import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {XMLParser} from 'fast-xml-parser';
import {validateXML} from 'xmllint-wasm';
import {SovereignCore,fault} from './core.mjs';
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
// The bank owner: "We now register an incoming transfer so AVISPay PLC is the receiver". An outgoing message names the chosen
// Common or Suspense account as the debtor's and the NOSTRO as the receiver (INDA); an incoming one names that account as the
// creditor's and the NOSTRO, where the money arrives, as the sender (INGA).
const DIRECTIONS=['OUTGOING','INCOMING'];

const draftOf=(row,full=true)=>({draftId:row.draft_id,revision:row.revision,uetr:row.uetr,messageType:row.message_type,
 amount:row.form.amount,currency:row.form.currency,creditorName:row.form.creditorName,debtorName:row.form.debtorName,schemaValid:row.schema_valid,
 direction:row.direction,registered:row.registered_journal_id!=null,updatedAt:new Date(row.updated_at).toISOString(),updatedBy:row.updated_by,
 ...(full?{form:row.form,xml:row.message,selection:Object.fromEntries(Object.entries(CHOICES).map(([name,column])=>[name,row[column]??null])),
  registeredAt:row.registered_at==null?null:new Date(row.registered_at).toISOString()}:{})});

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
 #direction(input){
  if(input===undefined||input===null||input==='')return 'OUTGOING';
  if(!DIRECTIONS.includes(input))fault('INVALID_FIELD','direction');
  return input;
 }
 // A chosen account is one of the lists the terminal offers, in the message's currency where it holds money in one, and the
 // message says it (review finding): outgoing, the debtor's IBAN and BIC are the Common or Suspense account's, the receiver,
 // INDA and the settlement account the NOSTRO account's; incoming, the creditor's IBAN and BIC, the sender, INGA and the
 // settlement account.
 async #checkSelection(db,selection,form,direction='OUTGOING'){
  const incoming=direction==='INCOMING';
  if(selection.bookingAccountId){
   const row=(await db.query(BOOKING+' AND a.account_id=$2 AND a.currency_code=$3',[RECEIVING_OWNERS,selection.bookingAccountId,form.currency])).rows[0];
   if(!row)fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
   // Incoming, the chosen account's bank is also the message's receiver (AppHdr To, InstdAgt) - review finding.
   const [iban,bic]=incoming?['creditorIban','creditorAgentBic']:['debtorIban','debtorAgentBic'];
   if(form[iban]!==row.abiq_iban||form[bic]!==row.abiq_bic||incoming&&form.receiverBic!==row.abiq_bic)
    fault(incoming?'FIN_CREDITOR_MISMATCH':'FIN_BOOKING_MISMATCH','bookingAccountId',409);
  }
  if(selection.nostroAccountId){
   const row=(await db.query(NOSTRO+' WHERE cash_account_id=$1 AND currency_code=$2 AND is_active',[selection.nostroAccountId,form.currency])).rows[0];
   if(!row||!fitsSettlement(row))fault('FIN_NOSTRO_ACCOUNT','nostroAccountId',409);
   if(form.settlement!==(incoming?'INGA':'INDA')||form.settlementAccount!==settlementNumber(row.iban_or_account_no)||
    (row.bic_code&&form[incoming?'senderBic':'receiverBic']!==row.bic_code.toUpperCase()))fault(incoming?'FIN_NOSTRO_SENDER_MISMATCH':'FIN_NOSTRO_MISMATCH','nostroAccountId',409);
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
 async #transaction(work){
  const client=await this.pool.connect();
  try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
  catch(error){
   await client.query('ROLLBACK').catch(()=>{});
   // Two drafts saved with one UETR at the same moment: the second is refused as any duplicate.
   if(error.code==='23505')fault('FIN_UETR_DUPLICATE','uetr',409);
   if(error.message==='FIN_DRAFT_REGISTERED')fault('FIN_DRAFT_REGISTERED','draftId',409);
   throw error;
  }finally{client.release?.();}
 }
 // The draft as it was opened: saved meanwhile, it is opened again first; a registered incoming transfer is not changed any more.
 async #opened(db,draftId,revision){
  const row=(await db.query('SELECT revision,registered_journal_id FROM avis_core_v2.fin_terminal_drafts WHERE draft_id=$1 FOR UPDATE',[draftId])).rows[0];
  if(!row)fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(row.registered_journal_id)fault('FIN_DRAFT_REGISTERED','draftId',409);
  if(row.revision!==revision)fault('FIN_DRAFT_CHANGED','draftId',409);
 }
 async #keep(db,actor,draftId,{form,xml,valid,selection,direction},journalId=null){
  const values=[form.uetr,form.messageType,JSON.stringify(form),xml,valid,String(actor.id),selection.bookingAccountId,selection.nostroAccountId,
   selection.tokenWalletId,direction,journalId,journalId&&new Date().toISOString(),journalId&&String(actor.id)];
  if(draftId===null)return (await db.query(`INSERT INTO avis_core_v2.fin_terminal_drafts(uetr,message_type,form,message,schema_valid,created_by,updated_by,
   booking_account_id,nostro_cash_account_id,token_wallet_account_id,direction,registered_journal_id,registered_at,registered_by,draft_id,revision)
   VALUES($1,$2,$3::jsonb,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14,1) RETURNING *`,[...values,randomUUID()])).rows[0];
  return (await db.query(`UPDATE avis_core_v2.fin_terminal_drafts SET uetr=$1,message_type=$2,form=$3::jsonb,message=$4,schema_valid=$5,updated_by=$6,
   booking_account_id=$7,nostro_cash_account_id=$8,token_wallet_account_id=$9,direction=$10,registered_journal_id=$11,registered_at=$12::timestamptz,
   registered_by=$13,revision=revision+1,updated_at=now() WHERE draft_id=$14 RETURNING *`,[...values,draftId])).rows[0];
 }
 // A draft keeps the form as written and its message as built from it - also unfinished; whether that message passed both
 // schemas is kept with it. Saved again, it needs the revision it was opened at.
 async save(actor,body){
  this.#administrator(actor);
  const form=this.#form(body?.form),selection=this.#selection(body?.selection),direction=this.#direction(body?.direction),xml=buildFinMessage(form),draftId=body?.draftId??null;
  if(draftId!==null&&!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(draftId!==null&&!Number.isInteger(body?.revision))fault('INVALID_FIELD','revision');
  const valid=(await validateFinMessage(xml)).valid&&!fieldProblems(form).length;
  return this.#transaction(async client=>{
   if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
   await this.#checkSelection(client,selection,form,direction);
   if(draftId!==null)await this.#opened(client,draftId,body.revision);
   return draftOf(await this.#keep(client,actor,draftId,{form,xml,valid,selection,direction}));
  });
 }
 // Registered, an incoming transfer's message - one that passed both schemas, naming AVISPay PLC's chosen account as the creditor's
 // and the NOSTRO as the sender - is kept for good, and its money is booked at once: on the NOSTRO, where it arrived, and on the
 // chosen account. The bank owner: "All Nostro we control manually not automatically"; the FinTerminal specification v3,
 // "CORE_BANKING_&_NOSTRO", ACSC.
 async register(actor,body){
  this.#administrator(actor);
  const form=this.#form(body?.form),selection=this.#selection(body?.selection),xml=buildFinMessage(form),draftId=body?.draftId??null;
  if(draftId!==null&&!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(draftId!==null&&!Number.isInteger(body?.revision))fault('INVALID_FIELD','revision');
  if(!selection.bookingAccountId)fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
  if(!selection.nostroAccountId)fault('FIN_NOSTRO_ACCOUNT','nostroAccountId',409);
  if(fieldProblems(form).length||!(await validateFinMessage(xml)).valid)fault('FIN_INCOMING_INVALID','xml');
  return this.#transaction(async client=>{
   if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
   await this.#checkSelection(client,selection,form,'INCOMING');
   if(draftId!==null)await this.#opened(client,draftId,body.revision);
   // The NOSTRO's own ledger account: an asset of the bank at its correspondent, in the transfer's currency.
   const nostro=(await client.query(`SELECT a.account_id FROM avis_core_v2.external_cash_accounts c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.ledger_account_id
    WHERE c.cash_account_id=$1 AND c.is_active AND a.currency_code=$2 AND a.account_category='ASSET' AND a.network IS NULL AND a.wallet_scope='FUNDING'
     AND a.owner_type IN ('CORRESPONDENT_NOSTRO','CENTRAL_BANK_RESERVE') FOR SHARE OF c`,[selection.nostroAccountId,form.currency])).rows[0];
   if(!nostro)fault('FIN_NOSTRO_ACCOUNT','nostroAccountId',409);
   const journalId=await new SovereignCore(null).post(client,actor,'fin-incoming:'+form.uetr,'FIN_INCOMING_BOOKED',form.businessMessageId,
    [{accountId:nostro.account_id,direction:'DEBIT',amount:form.amount},{accountId:selection.bookingAccountId,direction:'CREDIT',amount:form.amount}]);
   const row=await this.#keep(client,actor,draftId,{form,xml,valid:true,selection,direction:'INCOMING'},journalId);
   await client.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),'FIN_INCOMING_BOOKED',journalId]);
   return draftOf(row);
  });
 }
}
