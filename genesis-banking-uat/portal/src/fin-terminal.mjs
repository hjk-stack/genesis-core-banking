import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {XMLParser} from 'fast-xml-parser';
import {validateXML} from 'xmllint-wasm';
import {fault} from './core.mjs';
import {RECEIVING_OWNERS} from './checkout-ip-settlement.mjs';
import {FIELDS,LIMITS,HEAD,PACS008,buildFinMessage,normalizeForm,fieldProblems} from '../public/fin-message.mjs';

// The FinTerminal's composer on the server: requested by the bank owner with the FinTerminal ISO 20022 specification,
// screen 1 "FIN - ISO 20022 Composer". A message is checked against the official schemas (schemas/head.001.001.02.xsd from
// iso20022.org, schemas/pacs.008.001.08.xsd) and kept as a draft; a UETR names one payment only.
const UETR=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMESPACE='urn:iso:std:iso:20022:tech:xsd:';
// The message is checked whole, as it is written: its envelope holds the header and then the transfer, each by its own
// official schema. Reported directly (review of the composer): a broken envelope around two correct parts passed when only
// the parts were checked.
const ENVELOPE=`<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:head="${NAMESPACE+HEAD}" xmlns:pacs="${NAMESPACE+PACS008}">
 <xs:import namespace="${NAMESPACE+HEAD}" schemaLocation="${HEAD}.xsd"/>
 <xs:import namespace="${NAMESPACE+PACS008}" schemaLocation="${PACS008}.xsd"/>
 <xs:element name="Envelope"><xs:complexType><xs:sequence><xs:element ref="head:AppHdr"/><xs:element ref="pacs:Document"/></xs:sequence></xs:complexType></xs:element>
</xs:schema>`;
let schemas=null;
const officialSchemas=async()=>schemas??=await Promise.all([HEAD,PACS008].map(async type=>({fileName:type+'.xsd',contents:await readFile(new URL('../schemas/'+type+'.xsd',import.meta.url),'utf8')})));
// The schemas' own words, under the part they are about: a finding within the header or within the transfer names its
// elements alone; anything else (the envelope, its parts out of place, XML that does not read) with each element's
// namespace written out.
function readable(error){
 const text=String(error.message||error.rawMessage||'').replace(/^(Schemas (validity|parser) error|parser error) : /,'').trim();
 const named=[...text.matchAll(/\{urn:iso:std:iso:20022:tech:xsd:([^}]+)\}/g)].map(match=>match[1]);
 const type=/^Element '\{urn:iso:std:iso:20022:tech:xsd:([^}]+)\}/.exec(text)?.[1];
 const part=type&&named.every(name=>name===type)?{[HEAD]:'AppHdr',[PACS008]:'Document'}[type]:null;
 return (part||'XML')+': '+text.replace(/\{urn:iso:std:iso:20022:tech:xsd:([^}]+)\}([A-Za-z0-9]+)/g,part?'$2':'$2 ($1)');
}

const parser=new XMLParser({ignoreAttributes:true,removeNSPrefix:true});
const first=xml=>{try{return Object.keys(parser.parse(xml)).find(key=>!key.startsWith('?'))||null;}catch{return null;}};

export async function validateFinMessage(xml){
 if(typeof xml!=='string'||!xml.trim()||Buffer.byteLength(xml)>65535||/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))fault('FIN_MESSAGE_INVALID','xml');
 const result=await validateXML({xml:{fileName:'message.xml',contents:xml},schema:{fileName:'envelope.xsd',contents:ENVELOPE},preload:await officialSchemas(),maxMemoryPages:512});
 // The schemas take any element they declare as a whole message: the header alone or the transfer alone passes too. Only the
 // envelope with both is the message. Reported directly: "XSD: PASSED" for only part of a message.
 if(result.valid){const root=first(xml);return root==='Envelope'?{valid:true,errors:[]}:{valid:false,errors:["XML: Element '"+(root||'?')+"': Not the message's envelope. Expected is ( Envelope ), with the AppHdr and the Document inside."]};}
 // A parser's finding comes with the line it is about and a pointer to it; the finding itself is kept.
 const errors=result.errors.filter(error=>/error : /.test(String(error.message||error.rawMessage||''))).map(readable);
 return {valid:false,errors:errors.length?errors:['XML: The message could not be checked.']};
}

// The accounts a message is booked against, as the bank's own pages list them. Requested by the bank owner: "Connected to Common
// and Suspense Accounts selectors and the NOSTRO accounts and the Wallet scroller in crypto for booking the converted tokens" -
// the Common and Suspense accounts of the Manual IP-Handler, the NOSTRO register, and the "+" wallets ("Add currency" in the
// wallet scroller), "not to AG and AGi". Nothing is booked here: the choices are kept with the draft.
const BOOKING=`SELECT a.account_id,a.owner_type,a.currency_code,b.abiq_iban,p.abiq_bic,p.institution_name,
 COALESCE(a.display_name,CASE WHEN a.owner_type='COMMON_POOL' THEN 'Common Account' ELSE 'Suspense Account' END) AS label
 FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
 JOIN avis_core_v2.abiq_network_participants p ON p.participant_code=b.participant_code
 WHERE a.owner_type=ANY($1::text[]) AND b.status='ACTIVE' AND a.wallet_scope='FUNDING' AND a.account_category='LIABILITY' AND a.network IS NULL`;
const NOSTRO=`SELECT cash_account_id,institution_name,bic_code,iban_or_account_no,account_name,currency_code,is_active
 FROM avis_core_v2.external_cash_accounts`;
const WALLETS=`SELECT l.account_id,u.full_name,l.currency_code,l.network,a.name
 FROM avis_core_v2.ledger_accounts l JOIN avis_core_v2.sovereign_users u USING(user_id)
 LEFT JOIN avis_core_v2.crypto_assets a ON a.currency_code=l.currency_code
 WHERE l.owner_type='USER' AND l.network IS NOT NULL AND l.wallet_scope='FUNDING' AND l.account_category='LIABILITY'
  AND l.wallet_visible IS NOT FALSE AND l.currency_code NOT IN ('AG','AGi')`;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A NOSTRO account settles a transfer as its settlement account: the register keeps account numbers of up to 128 characters,
// the message's account up to 34 (review finding) - a longer number is not offered.
const settlementNumber=value=>normalizeForm({settlementAccount:String(value??'')}).settlementAccount;
const fitsSettlement=row=>{const number=settlementNumber(row.iban_or_account_no);return number.length>0&&number.length<=LIMITS.settlementAccount;};
const CHOICES={bookingAccountId:'booking_account_id',nostroAccountId:'nostro_cash_account_id',tokenWalletId:'token_wallet_account_id'};

const draftOf=(row,full=true)=>({draftId:row.draft_id,revision:row.revision,uetr:row.uetr,messageType:row.message_type,
 amount:row.form.amount,currency:row.form.currency,creditorName:row.form.creditorName,schemaValid:row.schema_valid,
 updatedAt:new Date(row.updated_at).toISOString(),updatedBy:row.updated_by,
 ...(full?{form:row.form,xml:row.message,selection:Object.fromEntries(Object.entries(CHOICES).map(([name,column])=>[name,row[column]??null]))}:{})});

export class FinTerminal{
 constructor(pool){this.pool=pool;}
 #administrator(actor){if(!actor?.admin)fault('FORBIDDEN',null,403);}
 #form(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fault('INVALID_FIELD','form');
  for(const field of FIELDS){
   const value=input[field];
   if(value!==undefined&&value!==null&&(typeof value!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)))fault('INVALID_FIELD',field);
  }
  // A field's limit is for what is kept: an IBAN written in groups of four is counted without its spaces (review finding).
  const form=normalizeForm(input);
  for(const field of FIELDS)if(form[field].length>LIMITS[field])fault('INVALID_FIELD',field);
  if(form.messageType!==PACS008)fault('INVALID_FIELD','messageType');
  if(!UETR.test(form.uetr))fault('INVALID_FIELD','uetr');
  return form;
 }
 #selection(input){
  if(input!==undefined&&input!==null&&(typeof input!=='object'||Array.isArray(input)))fault('INVALID_FIELD','selection');
  return Object.fromEntries(Object.keys(CHOICES).map(name=>{
   const value=input?.[name];if(value===undefined||value===null||value==='')return [name,null];
   if(typeof value!=='string'||!ID.test(value.toLowerCase()))fault('INVALID_FIELD',name);
   return [name,value.toLowerCase()];
  }));
 }
 // A chosen account is one of the lists the terminal offers, in the message's currency where it holds money in one, and the
 // message says it (review finding): the debtor's IBAN and BIC are the Common or Suspense account's, the receiver, INDA and
 // the settlement account the NOSTRO account's.
 async #checkSelection(db,selection,form){
  if(selection.bookingAccountId){
   const row=(await db.query(BOOKING+' AND a.account_id=$2 AND a.currency_code=$3',[RECEIVING_OWNERS,selection.bookingAccountId,form.currency])).rows[0];
   if(!row)fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
   if(form.debtorIban!==row.abiq_iban||form.debtorAgentBic!==row.abiq_bic)fault('FIN_BOOKING_MISMATCH','bookingAccountId',409);
  }
  if(selection.nostroAccountId){
   const row=(await db.query(NOSTRO+' WHERE cash_account_id=$1 AND currency_code=$2 AND is_active',[selection.nostroAccountId,form.currency])).rows[0];
   if(!row||!fitsSettlement(row))fault('FIN_NOSTRO_ACCOUNT','nostroAccountId',409);
   if(form.settlement!=='INDA'||form.settlementAccount!==settlementNumber(row.iban_or_account_no)||(row.bic_code&&form.receiverBic!==row.bic_code.toUpperCase()))fault('FIN_NOSTRO_MISMATCH','nostroAccountId',409);
  }
  if(selection.tokenWalletId&&!(await db.query(WALLETS+' AND l.account_id=$1',[selection.tokenWalletId])).rows.length)fault('FIN_TOKEN_WALLET','tokenWalletId',409);
 }
 async accounts(actor){
  this.#administrator(actor);
  const booking=(await this.pool.query(BOOKING+' ORDER BY a.currency_code,a.owner_type,b.abiq_iban',[RECEIVING_OWNERS])).rows;
  const nostro=(await this.pool.query(NOSTRO+' ORDER BY institution_name,currency_code,cash_account_id')).rows;
  const wallets=(await this.pool.query(WALLETS+' ORDER BY u.full_name,l.currency_code,l.network,l.account_id LIMIT 500')).rows;
  return {
   bookingAccounts:booking.map(row=>({accountId:row.account_id,type:row.owner_type==='COMMON_POOL'?'COMMON':'SUSPENSE',label:row.label,
    currency:row.currency_code,iban:row.abiq_iban,bic:row.abiq_bic,institution:row.institution_name})),
   nostroAccounts:nostro.filter(fitsSettlement).map(row=>({accountId:row.cash_account_id,institution:row.institution_name,bic:row.bic_code||'',
    account:row.iban_or_account_no,accountName:row.account_name||'',currency:row.currency_code,active:row.is_active===true})),
   tokenWallets:wallets.map(row=>({accountId:row.account_id,holder:row.full_name,currency:row.currency_code,network:row.network,name:row.name||row.currency_code}))
  };
 }
 // A UETR already given to another draft, an IP-to-IP transfer or a bank payment is refused.
 async #uetrTaken(db,uetr,draftId){
  return (await db.query(`SELECT 1 FROM avis_core_v2.fin_terminal_drafts WHERE uetr=$1 AND draft_id IS DISTINCT FROM $2::uuid
   UNION ALL SELECT 1 FROM avis_core_v2.interbank_ip_transfers WHERE uetr=$1
   UNION ALL SELECT 1 FROM avis_core_v2.payment_requests WHERE uetr=$1 LIMIT 1`,[uetr,draftId])).rows.length>0;
 }
 async validate(actor,body){
  this.#administrator(actor);
  const form=this.#form(body?.form),checked=await validateFinMessage(body?.xml);
  const problems=fieldProblems(form).map(problem=>problem.field+': '+problem.message);
  if(await this.#uetrTaken(this.pool,form.uetr,typeof body?.draftId==='string'&&UETR.test(body.draftId)?body.draftId:null))problems.push('uetr: already used by another payment or draft.');
  return {valid:checked.valid&&!problems.length,errors:[...problems,...checked.errors]};
 }
 async drafts(actor){
  this.#administrator(actor);
  return (await this.pool.query('SELECT * FROM avis_core_v2.fin_terminal_drafts ORDER BY updated_at DESC LIMIT 200')).rows.map(row=>draftOf(row,false));
 }
 async draft(actor,draftId){
  this.#administrator(actor);
  if(!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  const row=(await this.pool.query('SELECT * FROM avis_core_v2.fin_terminal_drafts WHERE draft_id=$1',[draftId])).rows[0];
  if(!row)fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  return draftOf(row);
 }
 // A draft keeps the form as written and its message as built from it - also unfinished; whether that message passed both
 // schemas is kept with it. Saved again, it needs the revision it was opened at.
 async save(actor,body){
  this.#administrator(actor);
  const form=this.#form(body?.form),selection=this.#selection(body?.selection),xml=buildFinMessage(form),draftId=body?.draftId??null;
  if(draftId!==null&&!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(draftId!==null&&!Number.isInteger(body?.revision))fault('INVALID_FIELD','revision');
  const valid=(await validateFinMessage(xml)).valid&&!fieldProblems(form).length;
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
   await this.#checkSelection(client,selection,form);
   const chosen=[selection.bookingAccountId,selection.nostroAccountId,selection.tokenWalletId];
   let row;
   if(draftId===null){
    row=(await client.query(`INSERT INTO avis_core_v2.fin_terminal_drafts(draft_id,uetr,message_type,revision,form,message,schema_valid,created_by,updated_by,
     booking_account_id,nostro_cash_account_id,token_wallet_account_id)
     VALUES($1,$2,$3,1,$4::jsonb,$5,$6,$7,$7,$8,$9,$10) RETURNING *`,[randomUUID(),form.uetr,form.messageType,JSON.stringify(form),xml,valid,String(actor.id),...chosen])).rows[0];
   }else{
    row=(await client.query(`UPDATE avis_core_v2.fin_terminal_drafts SET uetr=$3,revision=revision+1,form=$4::jsonb,message=$5,schema_valid=$6,updated_by=$7,updated_at=now(),
     booking_account_id=$8,nostro_cash_account_id=$9,token_wallet_account_id=$10
     WHERE draft_id=$1 AND revision=$2 RETURNING *`,[draftId,body.revision,form.uetr,JSON.stringify(form),xml,valid,String(actor.id),...chosen])).rows[0];
    if(!row){
     const exists=(await client.query('SELECT 1 FROM avis_core_v2.fin_terminal_drafts WHERE draft_id=$1',[draftId])).rows.length;
     fault(exists?'FIN_DRAFT_CHANGED':'FIN_DRAFT_NOT_FOUND','draftId',exists?409:404);
    }
   }
   await client.query('COMMIT');
   return draftOf(row);
  }catch(error){
   await client.query('ROLLBACK').catch(()=>{});
   // Two drafts saved with one UETR at the same moment: the second is refused as any duplicate.
   if(error.code==='23505')fault('FIN_UETR_DUPLICATE','uetr',409);
   throw error;
  }finally{client.release?.();}
 }
}
