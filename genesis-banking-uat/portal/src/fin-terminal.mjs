import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {XMLParser} from 'fast-xml-parser';
import {validateXML} from 'xmllint-wasm';
import {SovereignCore,fault,money,decimal} from './core.mjs';
import {RECEIVING_OWNERS} from './checkout-ip-settlement.mjs';
import {cryptoLedgerAccount} from './crypto/rolling-ledger.mjs';
import {MetaMaskPricing} from './metamask-pricing.mjs';
import {FIELDS,LIMITS,HEAD,PACS008,PACS003,blankForm,buildFinMessage,normalizeForm,fieldProblems} from '../public/fin-message.mjs';

// The FinTerminal's composer on the server: requested by the bank owner with the FinTerminal ISO 20022 specification,
// screen 1 "FIN - ISO 20022 Composer". A message is checked against the official schemas (schemas/head.001.001.02.xsd from
// iso20022.org, schemas/pacs.008.001.08.xsd, and for a Debit schemas/pacs.003.001.08.xsd) and kept as a draft; a UETR names one
// payment only.
const UETR=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMESPACE='urn:iso:std:iso:20022:tech:xsd:';
// The message is checked whole, as it is written: its envelope holds the header and then the transfer, each by its own
// official schema. Reported directly (review of the composer): a broken envelope around two correct parts passed when only
// the parts were checked.
const envelope=type=>`<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:head="${NAMESPACE+HEAD}" xmlns:pacs="${NAMESPACE+type}">
 <xs:import namespace="${NAMESPACE+HEAD}" schemaLocation="${HEAD}.xsd"/>
 <xs:import namespace="${NAMESPACE+type}" schemaLocation="${type}.xsd"/>
 <xs:element name="Envelope"><xs:complexType><xs:sequence><xs:element ref="head:AppHdr"/><xs:element ref="pacs:Document"/></xs:sequence></xs:complexType></xs:element>
</xs:schema>`;
let schemas=null;
const officialSchemas=async()=>schemas??=await Promise.all([HEAD,PACS008,PACS003].map(async type=>({fileName:type+'.xsd',contents:await readFile(new URL('../schemas/'+type+'.xsd',import.meta.url),'utf8')})));
// The schemas' own words, under the part they are about: a finding within the header or within the transfer names its
// elements alone; anything else (the envelope, its parts out of place, XML that does not read) with each element's
// namespace written out.
function readable(error){
 const text=String(error.message||error.rawMessage||'').replace(/^(Schemas (validity|parser) error|parser error) : /,'').trim();
 const named=[...text.matchAll(/\{urn:iso:std:iso:20022:tech:xsd:([^}]+)\}/g)].map(match=>match[1]);
 const type=/^Element '\{urn:iso:std:iso:20022:tech:xsd:([^}]+)\}/.exec(text)?.[1];
 const part=type&&named.every(name=>name===type)?{[HEAD]:'AppHdr',[PACS008]:'Document',[PACS003]:'Document'}[type]:null;
 return (part||'XML')+': '+text.replace(/\{urn:iso:std:iso:20022:tech:xsd:([^}]+)\}([A-Za-z0-9]+)/g,part?'$2':'$2 ($1)');
}

const parser=new XMLParser({ignoreAttributes:true,removeNSPrefix:true});
const first=xml=>{try{return Object.keys(parser.parse(xml)).find(key=>!key.startsWith('?'))||null;}catch{return null;}};

// type: the message the envelope must hold - a credit transfer, or a direct debit for a Debit.
export async function validateFinMessage(xml,type=PACS008){
 if(typeof xml!=='string'||!xml.trim()||Buffer.byteLength(xml)>65535||/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))fault('FIN_MESSAGE_INVALID','xml');
 const result=await validateXML({xml:{fileName:'message.xml',contents:xml},schema:{fileName:'envelope.xsd',contents:envelope(type===PACS003?PACS003:PACS008)},preload:await officialSchemas(),maxMemoryPages:512});
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
// wallet scroller), "not to AG and AGi". Nothing is booked here: the choices are kept with the draft. The suspense account holding
// the Cash Wire's money on its way (WIRE_SUSPENSE) is the wires' own: no account to book against or pay from.
const WIRE_SUSPENSE='FIN:WIRES';
const BOOKING=`SELECT a.account_id,a.owner_type,a.currency_code,b.abiq_iban,p.abiq_bic,p.institution_name,a.available_balance::text AS balance,
 COALESCE(a.display_name,CASE WHEN a.owner_type='COMMON_POOL' THEN 'Common Account' ELSE 'Suspense Account' END) AS label
 FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=a.account_id
 JOIN avis_core_v2.abiq_network_participants p ON p.participant_code=b.participant_code
 WHERE a.owner_type=ANY($1::text[]) AND b.status='ACTIVE' AND a.wallet_scope='FUNDING' AND a.account_category='LIABILITY' AND a.network IS NULL
  AND a.sub_account_code<>'${WIRE_SUSPENSE}'`;
const NOSTRO=`SELECT cash_account_id,institution_name,bic_code,iban_or_account_no,account_name,currency_code,is_active
 FROM avis_core_v2.external_cash_accounts`;
const WALLETS=`SELECT l.account_id,l.user_id,u.full_name,l.currency_code,l.network,a.name
 FROM avis_core_v2.ledger_accounts l JOIN avis_core_v2.sovereign_users u USING(user_id)
 LEFT JOIN avis_core_v2.crypto_assets a ON a.currency_code=l.currency_code
 WHERE l.owner_type='USER' AND l.network IS NOT NULL AND l.wallet_scope='FUNDING' AND l.account_category='LIABILITY'
  AND l.wallet_visible IS NOT FALSE AND l.currency_code NOT IN ('AG','AGi')`;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The specification v3's "Final Settlement Ledgers": the core banking cash (AVISPay PLC's Common and Suspense accounts), the NOSTRO
// correspondents and the bank's own wallets on the chains (its custody, the "Direct Institutional MPC Wallet"), each with the
// balance its ledger account holds.
const NOSTRO_LEDGERS=`SELECT c.cash_account_id,c.institution_name,c.bic_code,c.iban_or_account_no,c.currency_code,c.is_active,a.available_balance::text AS balance
 FROM avis_core_v2.external_cash_accounts c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.ledger_account_id ORDER BY c.institution_name,c.currency_code,c.cash_account_id`;
const CUSTODY=`SELECT currency_code,network,sum(available_balance)::text AS balance FROM avis_core_v2.ledger_accounts
 WHERE owner_type='HOT_WALLET' AND wallet_scope='FUNDING' AND network IS NOT NULL GROUP BY currency_code,network ORDER BY currency_code,network`;
// A NOSTRO account settles a transfer as its settlement account: the register keeps account numbers of up to 128 characters,
// the message's account up to 34 (review finding) - a longer number is not offered.
const settlementNumber=value=>normalizeForm({settlementAccount:String(value??'')}).settlementAccount;
const fitsSettlement=row=>{const number=settlementNumber(row.iban_or_account_no);return number.length>0&&number.length<=LIMITS.settlementAccount;};
const CHOICES={bookingAccountId:'booking_account_id',nostroAccountId:'nostro_cash_account_id',tokenWalletId:'token_wallet_account_id'};
// The bank owner: "We now register an incoming transfer so AVISPay PLC is the receiver". An outgoing message names the chosen
// Common or Suspense account as the debtor's and the NOSTRO as the receiver (INDA); an incoming one names that account as the
// creditor's and the NOSTRO, where the money arrives, as the sender (INGA). A Debit (the bank owner: "There is missing a function:
// Debit") names that account as the creditor's, and the NOSTRO at the debtor's bank as the receiver (INDA).
const DIRECTIONS=['OUTGOING','INCOMING','DEBIT'];
// Why a peer's credit transfer is not booked, as its status answer says it (pacs.002 RJCT): the ISO 20022 status reason code and
// the bank's words for it.
const REJECTED={
 FIN_INCOMING_INVALID:{reason:'NARR',text:'The transfer does not pass as the FinTerminal writes it: its fields or its amount.'},
 FIN_BOOKING_ACCOUNT:{reason:'AC03',text:'The creditor\'s account is not an AVISPay PLC account in this currency.'},
 FIN_CREDITOR_MISMATCH:{reason:'AC03',text:'The creditor\'s agent and the receiver are not the bank of the creditor\'s account.'},
 FIN_NOSTRO_ACCOUNT:{reason:'NARR',text:'The bank holds no active NOSTRO account at this peer in this currency.'},
 FIN_NOSTRO_SENDER_MISMATCH:{reason:'NARR',text:'Not settled INGA on the bank\'s NOSTRO account at this peer, sent by this peer.'},
 FIN_UETR_DUPLICATE:{reason:'DUPL',text:'This UETR names another payment already.'},
 FIN_CONVERT_RATE:{reason:'NARR',text:'No live rate for converting into the account\'s wallet now.'},
 FIN_CONVERT_QUANTITY:{reason:'NARR',text:'The amount converts to no token at four decimals.'},
 FIN_TOKEN_WALLET:{reason:'NARR',text:'The account\'s conversion wallet is not open.'},
 FIN_IVMS101:{reason:'NARR',text:'The IVMS101 travel-rule data is not complete.'},
 FIN_WALLET_ADDRESS:{reason:'NARR',text:'The account\'s conversion wallet has no receiving address on its chain.'},
 FIN_CONVERT_ROUTE:{reason:'NARR',text:'The account\'s conversion route changed while the transfer was taken; send it again.'}};
// The bank's answer to a peer's transfer taken: booked on the NOSTRO and the core banking account, or converted into crypto (ACSC),
// or held for the operator under MANUAL INTERVENTION, technically accepted (ACTC). A transfer is the same payment when every field
// but its message's own id and creation time is the same.
const booked=(form,converted=null)=>({status:'ACSC',reason:null,text:converted?'AUTO_CRYPTO:'+four(converted.quantity)+' '+converted.asset+' (TX:'+converted.hash.slice(0,14)+'...)'
 :'CORE_BANKING_&_NOSTRO:+'+form.amount+' '+form.currency});
const HELD=Object.freeze({status:'ACTC',reason:null,text:'HELD FOR MANUAL INTERVENTION'});
const PAYMENT_FIELDS=FIELDS.filter(field=>!['businessMessageId','createdAt'].includes(field));

// The specification v3's Direct Crypto Converter: "Interactive asset selector (EURC, USDC, BTC, ETH, SOL)". A transfer converted is
// loaded at the live rate - EURC 1:1 for euros (MiCA), any other at its market price (MetaMask) - less 0.05%: amount x rate x 0.9995
// to four decimals, rounded half to even as its backend's quantize(Decimal("0.0001")); its hash is "0x" and the SHA-256 of its UETR.
export const CONVERT_ASSETS=Object.freeze(['EURC','USDC','BTC','ETH','SOL']);
const SCALE=10n**18n;
export function convertedQuantity(amount,rate){
 const product=money(String(amount))*money(String(rate))*9995n,unit=10n**36n,rest=product%unit;
 let quantity=product/unit;if(rest*2n>unit||rest*2n===unit&&quantity%2n===1n)quantity++;
 return decimal(quantity,4);
}
export const transferHash=uetr=>'0x'+createHash('sha256').update(uetr).digest('hex');
const four=value=>{const [whole,fraction='']=String(value).split('.');return whole+'.'+fraction.padEnd(4,'0').slice(0,4);};
// The IVMS101 travel-rule data a conversion is kept with: who sent the money and from which account, who holds the wallet the tokens
// are loaded into and which wallet - verified when each is named.
const legal=name=>({legalPerson:{name:{nameIdentifier:[{legalPersonName:name,legalPersonNameIdentifierType:'LEGL'}]}}});
function ivms101(form,wallet){
 const account=wallet.public_address;
 return {originator:{originatorPersons:[legal(form.debtorName)],accountNumber:[form.debtorIban]},
  beneficiary:{beneficiaryPersons:[legal(wallet.full_name)],accountNumber:[account]},verified:[form.debtorName,form.debtorIban,wallet.full_name,account].every(Boolean)};
}
// A wallet's receiving address on its chain: the holder's own route for that asset (crypto_asset_wallet_routes), else the holder's
// primary deposit address on that chain.
const WALLET_ADDRESS=`SELECT d.public_address FROM avis_core_v2.user_deposit_addresses d
 LEFT JOIN avis_core_v2.crypto_asset_wallet_routes r ON r.address_id=d.address_id AND r.user_id=d.user_id AND r.network=d.network
  AND r.asset_id=(SELECT asset_id FROM avis_core_v2.crypto_assets WHERE currency_code=$2)
 WHERE d.user_id=$1 AND d.network=$3 AND (r.address_id IS NOT NULL OR d.is_primary) ORDER BY r.address_id IS NULL,d.address_id LIMIT 1`;
const HAS_ADDRESS=` AND EXISTS(SELECT 1 FROM avis_core_v2.user_deposit_addresses d LEFT JOIN avis_core_v2.crypto_asset_wallet_routes r
 ON r.address_id=d.address_id AND r.user_id=d.user_id AND r.network=d.network AND r.asset_id=a.asset_id
 WHERE d.user_id=l.user_id AND d.network=l.network AND (r.address_id IS NOT NULL OR d.is_primary))`;
// An outgoing message transacted (FinPeers.transact) is a wire, a Debit sent is a debit: what became of it is their status. A Debit
// is closed once it is sent.
const DRAFT_ROWS=`SELECT d.*,c.asset AS converted_asset,c.quantity::text AS converted_quantity,c.tx_hash AS converted_hash,w.status AS wire_status,b.status AS debit_status
 FROM avis_core_v2.fin_terminal_drafts d LEFT JOIN avis_core_v2.fin_terminal_conversions c ON c.draft_id=d.draft_id
 LEFT JOIN avis_core_v2.fin_terminal_wires w ON w.uetr=d.uetr AND d.direction='OUTGOING' AND d.registered_journal_id=w.reserve_journal_id
 LEFT JOIN avis_core_v2.fin_terminal_debits b ON b.draft_id=d.draft_id`;

const draftOf=(row,full=true)=>({draftId:row.draft_id,revision:row.revision,uetr:row.uetr,messageType:row.message_type,
 amount:row.form.amount,currency:row.form.currency,creditorName:row.form.creditorName,debtorName:row.form.debtorName,schemaValid:row.schema_valid,
 direction:row.direction,registered:row.registered_journal_id!=null||row.debit_status!=null,updatedAt:new Date(row.updated_at).toISOString(),updatedBy:row.updated_by,
 conversion:row.converted_asset?{asset:row.converted_asset,quantity:four(row.converted_quantity),txHash:row.converted_hash}:null,
 transacted:row.wire_status||row.debit_status||null,
 ...(full?{form:row.form,xml:row.message,selection:Object.fromEntries(Object.entries(CHOICES).map(([name,column])=>[name,row[column]??null])),
  registeredAt:row.registered_at==null?null:new Date(row.registered_at).toISOString()}:{})});

export class FinTerminal{
 constructor(pool,{pricing=new MetaMaskPricing()}={}){this.pool=pool;this.pricing=pricing;}
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
  if(![PACS008,PACS003].includes(form.messageType))fault('INVALID_FIELD','messageType');
  if(!UETR.test(form.uetr))fault('INVALID_FIELD','uetr');
  return form;
 }
 // A Debit is a direct debit (pacs.003), every other message a credit transfer (pacs.008).
 #typed(form,direction){if(form.messageType!==(direction==='DEBIT'?PACS003:PACS008))fault('INVALID_FIELD','messageType');}
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
 // message says it (review finding): outgoing, the debtor's account and BIC are the Common or Suspense account's, the receiver,
 // INDA and the settlement account the NOSTRO account's; incoming, the creditor's account and BIC, the sender, INGA and the
 // settlement account. The NOSTRO's number is used as the register keeps it, without a further check (the bank owner: "Nostro
 // accounts are registered and must select via the listed NOSTROS and no need any further check").
 async #checkSelection(db,selection,form,direction='OUTGOING'){
  const incoming=direction==='INCOMING',debit=direction==='DEBIT';
  if(selection.bookingAccountId){
   const row=(await db.query(BOOKING+' AND a.account_id=$2 AND a.currency_code=$3',[RECEIVING_OWNERS,selection.bookingAccountId,form.currency])).rows[0];
   if(!row)fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
   // A Debit collects into the chosen account, as an incoming transfer arrives there. Incoming, the chosen account's bank is also the
   // message's receiver (AppHdr To, InstdAgt) - review finding.
   const [iban,bic]=incoming||debit?['creditorIban','creditorAgentBic']:['debtorIban','debtorAgentBic'];
   if(form[iban]!==row.abiq_iban||form[bic]!==row.abiq_bic||incoming&&form.receiverBic!==row.abiq_bic)
    fault(incoming?'FIN_CREDITOR_MISMATCH':debit?'FIN_DEBIT_CREDITOR_MISMATCH':'FIN_BOOKING_MISMATCH','bookingAccountId',409);
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
 // A UETR already given to another draft, an IP-to-IP transfer or a bank payment is refused. A transacted draft's own wire, or a Debit
 // draft's own Debit, is its own (review finding: reopened, it showed as a duplicate of itself); it is not sent again (#opened).
 async #uetrTaken(db,uetr,draftId){
  return (await db.query(`SELECT 1 FROM avis_core_v2.fin_terminal_drafts WHERE uetr=$1 AND draft_id IS DISTINCT FROM $2::uuid
   UNION ALL SELECT 1 FROM avis_core_v2.fin_terminal_wires w WHERE w.uetr=$1
    AND w.reserve_journal_id IS DISTINCT FROM (SELECT registered_journal_id FROM avis_core_v2.fin_terminal_drafts WHERE draft_id=$2::uuid)
   UNION ALL SELECT 1 FROM avis_core_v2.fin_terminal_debits WHERE uetr=$1 AND draft_id IS DISTINCT FROM $2::uuid
   UNION ALL SELECT 1 FROM avis_core_v2.interbank_ip_transfers WHERE uetr=$1
   UNION ALL SELECT 1 FROM avis_core_v2.payment_requests WHERE uetr=$1 LIMIT 1`,[uetr,draftId])).rows.length>0;
 }
 async validate(actor,body){
  this.#administrator(actor);
  const form=this.#form(body?.form),checked=await validateFinMessage(body?.xml,form.messageType);
  const problems=fieldProblems(form).map(problem=>problem.field+': '+problem.message);
  if(await this.#uetrTaken(this.pool,form.uetr,typeof body?.draftId==='string'&&UETR.test(body.draftId)?body.draftId:null))problems.push('uetr: already used by another payment or draft.');
  return {valid:checked.valid&&!problems.length,errors:[...problems,...checked.errors]};
 }
 async drafts(actor){
  this.#administrator(actor);
  return (await this.pool.query(DRAFT_ROWS+' ORDER BY d.updated_at DESC LIMIT 200')).rows.map(row=>draftOf(row,false));
 }
 async draft(actor,draftId){
  this.#administrator(actor);
  if(!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  const row=(await this.pool.query(DRAFT_ROWS+' WHERE d.draft_id=$1',[draftId])).rows[0];
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
 // The draft as it was opened: saved meanwhile, it is opened again first; a registered incoming transfer, a transacted outgoing
 // message or a Debit sent is not changed any more.
 async #opened(db,draftId,revision){
  const row=(await db.query(`SELECT d.revision,d.registered_journal_id,d.direction,EXISTS(SELECT 1 FROM avis_core_v2.fin_terminal_debits b WHERE b.draft_id=d.draft_id) AS sent
   FROM avis_core_v2.fin_terminal_drafts d WHERE d.draft_id=$1 FOR UPDATE OF d`,[draftId])).rows[0];
  if(!row)fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(row.registered_journal_id||row.sent)fault(row.direction==='INCOMING'?'FIN_DRAFT_REGISTERED':'FIN_TRANSACTED','draftId',409);
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
  this.#typed(form,direction);
  if(draftId!==null&&!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(draftId!==null&&!Number.isInteger(body?.revision))fault('INVALID_FIELD','revision');
  const valid=(await validateFinMessage(xml,form.messageType)).valid&&!fieldProblems(form).length;
  return this.#transaction(async client=>{
   if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
   await this.#checkSelection(client,selection,form,direction);
   if(draftId!==null)await this.#opened(client,draftId,body.revision);
   return draftOf(await this.#keep(client,actor,draftId,{form,xml,valid,selection,direction}));
  });
 }
 // The specification v3's mode: ROBOTIC STP, an incoming credit taken and booked by the bank at once, or MANUAL INTERVENTION,
 // held for a bank administrator.
 async mode(actor,body){
  this.#administrator(actor);
  if(typeof body?.roboticStp!=='boolean')fault('INVALID_FIELD','roboticStp');
  const row=(await this.pool.query('UPDATE avis_core_v2.fin_terminal_mode SET robotic_stp=$1,changed_by=$2,changed_at=now() WHERE mode_id=1 RETURNING robotic_stp',
   [body.roboticStp,String(actor.id)])).rows[0];
  return {roboticStp:row.robotic_stp};
 }
 async telemetry(actor){
  this.#administrator(actor);
  const mode=(await this.pool.query('SELECT robotic_stp FROM avis_core_v2.fin_terminal_mode WHERE mode_id=1')).rows[0];
  const core=(await this.pool.query(BOOKING+' ORDER BY a.currency_code,a.owner_type,b.abiq_iban',[RECEIVING_OWNERS])).rows;
  const nostro=(await this.pool.query(NOSTRO_LEDGERS)).rows,custody=(await this.pool.query(CUSTODY)).rows;
  return {roboticStp:mode?.robotic_stp===true,ledgers:{
   coreBanking:core.map(row=>({accountId:row.account_id,label:row.label,iban:row.abiq_iban,currency:row.currency_code,balance:row.balance})),
   nostro:nostro.map(row=>({accountId:row.cash_account_id,institution:row.institution_name,bic:row.bic_code||'',account:row.iban_or_account_no,currency:row.currency_code,
    active:row.is_active===true,balance:row.balance})),
   wallets:custody.map(row=>({currency:row.currency_code,network:row.network,balance:row.balance}))}};
 }
 // Registered, an incoming transfer's message - one that passed both schemas, naming AVISPay PLC's chosen account as the creditor's
 // and the NOSTRO as the sender - is kept for good, and its money is booked at once: on the NOSTRO, where it arrived, and on the
 // chosen account. The bank owner: "All Nostro we control manually not automatically"; the FinTerminal specification v3,
 // "CORE_BANKING_&_NOSTRO", ACSC.
 async register(actor,body){
  this.#administrator(actor);
  const form=this.#form(body?.form),selection=this.#selection(body?.selection),xml=buildFinMessage(form),draftId=body?.draftId??null;
  this.#typed(form,'INCOMING');
  if(draftId!==null&&!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(draftId!==null&&!Number.isInteger(body?.revision))fault('INVALID_FIELD','revision');
  if(!selection.bookingAccountId)fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
  if(!selection.nostroAccountId)fault('FIN_NOSTRO_ACCOUNT','nostroAccountId',409);
  if(fieldProblems(form).length||!(await validateFinMessage(xml)).valid)fault('FIN_INCOMING_INVALID','xml');
  // A "+" wallet chosen, the converter is active: the transfer is converted into it at the live rate, and nothing arrives at the
  // NOSTRO (the bank owner: "when the crypto converter is active then nothing will arrive at the NOSTRO instead will be the wallet
  // loaded").
  if(selection.tokenWalletId){
   const wallet=await this.#wallet(this.pool,selection.tokenWalletId),quote=await this.#rate(form.currency,wallet);
   return this.#transaction(async client=>draftOf((await this.#convert(client,actor,{form,xml,selection,wallet,quote,mode:'MANUAL',draftId,revision:body.revision})).row));
  }
  return this.#transaction(async client=>draftOf(await this.#book(client,actor,{form,xml,selection,draftId,revision:body.revision})));
 }
 // A wallet the converter loads: a "+" wallet in one of its assets, with the address its tokens are received at on its chain - none,
 // no conversion (review finding).
 async #wallet(db,accountId){
  const wallet=(await db.query(WALLETS+' AND l.account_id=$1 AND l.currency_code=ANY($2::text[])',[accountId,CONVERT_ASSETS])).rows[0];
  if(!wallet)fault('FIN_TOKEN_WALLET','tokenWalletId',409);
  const address=(await db.query(WALLET_ADDRESS,[wallet.user_id,wallet.currency_code,wallet.network])).rows[0]?.public_address;
  if(!address)fault('FIN_WALLET_ADDRESS','tokenWalletId',409);
  return {...wallet,public_address:address};
 }
 // The live rate: the tokens for one unit of the transfer's currency - EURC 1:1 for euros (MiCA), any other at its market price on
 // the wallet's chain (MetaMask).
 async #rate(currency,wallet){
  if(wallet.currency_code==='EURC'&&currency==='EUR')return {rate:'1.000000000000000000',source:'MiCA 1:1',observedAt:new Date()};
  const descriptor=(await this.pool.query(`SELECT n.network,n.contract_address FROM avis_core_v2.crypto_asset_networks n JOIN avis_core_v2.crypto_assets a USING(asset_id)
   WHERE a.currency_code=$1 AND n.network=$2`,[wallet.currency_code,wallet.network])).rows[0];
  let price;try{price=money((await this.pricing.spot(descriptor,currency)).rate);}catch{fault('FIN_CONVERT_RATE','tokenWalletId',503);}
  return {rate:decimal(SCALE*SCALE/price),source:'MetaMask',observedAt:new Date()};
 }
 // A transfer's money converted at the rate quoted: its tokens loaded into the wallet and into the bank's custody on that chain
 // (the "Direct Institutional MPC Wallet"); the NOSTRO and the core banking cash stay as they are.
 async #tokens(client,actor,{key,event,form,wallet,quote}){
  const quantity=convertedQuantity(form.amount,quote.rate),hash=transferHash(form.uetr),travel=ivms101(form,wallet);
  if(!/[1-9]/.test(quantity))fault('FIN_CONVERT_QUANTITY','amount',409);
  if(!travel.verified)fault('FIN_IVMS101','form',409);
  const custody=await cryptoLedgerAccount(client,{owner:'HOT_WALLET',currency:wallet.currency_code,network:wallet.network,bucket:'CHAIN_CUSTODY',category:'ASSET'});
  const journalId=await new SovereignCore(null).post(client,actor,key,event,form.businessMessageId,
   [{accountId:custody,direction:'DEBIT',amount:quantity},{accountId:wallet.account_id,direction:'CREDIT',amount:quantity}]);
  return {journalId,quantity,hash,travel};
 }
 async #converted(client,actor,{form,draftId,journalId,wallet,quote,quantity,hash,travel,mode}){
  await client.query(`INSERT INTO avis_core_v2.fin_terminal_conversions(uetr,draft_id,journal_id,token_wallet_account_id,fiat_amount,fiat_currency,asset,network,
   rate,rate_source,rate_observed_at,quantity,tx_hash,mode,ivms101,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`,
   [form.uetr,draftId,journalId,wallet.account_id,form.amount,form.currency,wallet.currency_code,wallet.network,quote.rate,quote.source,
    quote.observedAt.toISOString(),quantity,hash,mode,JSON.stringify(travel),String(actor.id)]);
 }
 async #convert(client,actor,{form,xml,selection,wallet,quote,mode,draftId=null,revision}){
  if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
  await this.#checkSelection(client,selection,form,'INCOMING');
  if(draftId!==null)await this.#opened(client,draftId,revision);
  const {journalId,quantity,hash,travel}=await this.#tokens(client,actor,{key:'fin-incoming:'+form.uetr,event:'FIN_INCOMING_CONVERTED',form,wallet,quote});
  const row=await this.#keep(client,actor,draftId,{form,xml,valid:true,selection,direction:'INCOMING'},journalId);
  await this.#converted(client,actor,{form,draftId:row.draft_id,journalId,wallet,quote,quantity,hash,travel,mode});
  await client.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),'FIN_INCOMING_CONVERTED',journalId]);
  return {row:{...row,converted_asset:wallet.currency_code,converted_quantity:quantity,converted_hash:hash},asset:wallet.currency_code,quantity,hash};
 }
 // The live rate a Debit's money is converted at into the wallet chosen, quoted when it is sent: an amount that converts to no
 // token is refused before it leaves.
 async debitQuote(tokenWalletId,form){
  const wallet=await this.#wallet(this.pool,tokenWalletId),quote=await this.#rate(form.currency,wallet);
  if(!/[1-9]/.test(convertedQuantity(form.amount,quote.rate)))fault('FIN_CONVERT_QUANTITY','amount',409);
  return quote;
 }
 // Sent, a Debit's message is kept for good as the draft it was written in, closed by its debit (src/fin-peer.mjs, transact): never
 // changed or sent again. Nothing is booked before the debtor's bank answered (bookDebit).
 async keepDebit(client,actor,{form,xml,selection,draftId,revision}){
  if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
  await this.#checkSelection(client,selection,form,'DEBIT');
  if(draftId!==null)await this.#opened(client,draftId,revision);
  return (await this.#keep(client,actor,draftId,{form,xml,valid:true,selection,direction:'DEBIT'})).draft_id;
 }
 // Settled by the debtor's bank, a Debit's money is the bank's - the bank owner: "A transaction does either book the message monies
 // to our common account and the physical clearing to our NOSTRO selected or convert the monies by all connected gateways into a
 // coin and books the coin into the chosen wallet" - as an incoming transfer is booked: on the NOSTRO and the chosen account, or
 // converted into the chosen wallet at the rate quoted when it was sent. Its draft keeps the journal.
 async bookDebit(client,actor,debit){
  const form=normalizeForm((await client.query('SELECT form FROM avis_core_v2.fin_terminal_drafts WHERE draft_id=$1',[debit.draft_id])).rows[0].form);
  let journalId;
  if(debit.token_wallet_account_id){
   const wallet=await this.#wallet(client,debit.token_wallet_account_id),quote={rate:String(debit.rate),source:debit.rate_source,observedAt:new Date(debit.rate_observed_at)};
   const tokens=await this.#tokens(client,actor,{key:'fin-debit:'+debit.uetr,event:'FIN_DEBIT_CONVERTED',form,wallet,quote});
   journalId=tokens.journalId;await this.#converted(client,actor,{form,draftId:debit.draft_id,wallet,quote,...tokens,mode:'MANUAL'});
  }else{
   const nostro=await this.#nostroLedger(client,debit.nostro_cash_account_id,debit.currency_code);
   if(!nostro)fault('FIN_NOSTRO_ACCOUNT','nostroAccountId',409);
   journalId=await new SovereignCore(null).post(client,actor,'fin-debit:'+debit.uetr,'FIN_DEBIT_BOOKED',form.businessMessageId,
    [{accountId:nostro.account_id,direction:'DEBIT',amount:debit.amount},{accountId:debit.booking_account_id,direction:'CREDIT',amount:debit.amount}]);
  }
  await client.query('UPDATE avis_core_v2.fin_terminal_drafts SET registered_journal_id=$2,registered_at=now(),registered_by=$3,revision=revision+1,updated_at=now() WHERE draft_id=$1',
   [debit.draft_id,journalId,String(actor.id)]);
  await client.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',
   [String(actor.id),debit.token_wallet_account_id?'FIN_DEBIT_CONVERTED':'FIN_DEBIT_BOOKED',journalId]);
  return journalId;
 }
 async #book(client,actor,{form,xml,selection,draftId=null,revision}){
  if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
  await this.#checkSelection(client,selection,form,'INCOMING');
  if(draftId!==null)await this.#opened(client,draftId,revision);
  const nostro=await this.#nostroLedger(client,selection.nostroAccountId,form.currency);
  if(!nostro)fault('FIN_NOSTRO_ACCOUNT','nostroAccountId',409);
  const journalId=await new SovereignCore(null).post(client,actor,'fin-incoming:'+form.uetr,'FIN_INCOMING_BOOKED',form.businessMessageId,
   [{accountId:nostro.account_id,direction:'DEBIT',amount:form.amount},{accountId:selection.bookingAccountId,direction:'CREDIT',amount:form.amount}]);
  const row=await this.#keep(client,actor,draftId,{form,xml,valid:true,selection,direction:'INCOMING'},journalId);
  await client.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),'FIN_INCOMING_BOOKED',journalId]);
  return row;
 }
 // The NOSTRO's own ledger account: an asset of the bank at its correspondent, in the transfer's currency.
 async #nostroLedger(db,cashAccountId,currency){
  return (await db.query(`SELECT a.account_id FROM avis_core_v2.external_cash_accounts c JOIN avis_core_v2.ledger_accounts a ON a.account_id=c.ledger_account_id
   WHERE c.cash_account_id=$1 AND c.is_active AND a.currency_code=$2 AND a.account_category='ASSET' AND a.network IS NULL AND a.wallet_scope='FUNDING'
    AND a.owner_type IN ('CORRESPONDENT_NOSTRO','CENTRAL_BANK_RESERVE') FOR SHARE OF c`,[cashAccountId,currency])).rows[0]||null;
 }
 // Screen B's Cash Wire (NOSTRO) (the specification v3's dispatch_manual_transfer, CASH_NOSTRO; src/fin-peer.mjs): a credit transfer
 // in euros from AVISPay PLC's account at the bank to the beneficiary at the peer bank, settled on the bank's NOSTRO there - the
 // connector's clearing account (INDA). The message the composer writes for an outgoing transfer on that account and that NOSTRO,
 // under the connector's BICs; the beneficiary's bank is the peer.
 async cashWire(peer,{uetr,bookingAccountId,amount,creditorName,creditorIban},at=new Date()){
  const account=(await this.pool.query(BOOKING+' AND a.account_id=$2 AND a.currency_code=$3',[RECEIVING_OWNERS,bookingAccountId,'EUR'])).rows[0];
  if(!account)fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
  const nostro=(await this.pool.query(NOSTRO+' WHERE cash_account_id=$1 AND currency_code=$2 AND is_active',[peer.cash_account_id,'EUR'])).rows[0];
  if(!nostro||!fitsSettlement(nostro)||nostro.bic_code&&nostro.bic_code.toUpperCase()!==peer.peer_bic)fault('FIN_WIRE_NOSTRO','profileId',409);
  const form=normalizeForm({...blankForm(at),uetr,senderBic:peer.local_bic,receiverBic:peer.peer_bic,currency:'EUR',amount,settlement:'INDA',
   settlementAccount:settlementNumber(nostro.iban_or_account_no),debtorName:account.institution_name,debtorIban:account.abiq_iban,debtorAgentBic:account.abiq_bic,
   creditorName,creditorIban,creditorAgentBic:peer.peer_bic,unstructuredRemittance:'INTERBANK-IP-DISPATCH'});
  const xml=buildFinMessage(form);
  if(fieldProblems(form).length||!(await validateFinMessage(xml)).valid)fault('FIN_WIRE_INVALID','form');
  return {form,xml};
 }
 // Executed, the wire's money leaves AVISPay PLC's account at once for the wires' suspense account, and the NOSTRO's cash is
 // reserved for it, as a bank payment reserves it (src/payments.mjs): both balances locked in the order post_journal locks them, the
 // account paying only what it holds free. The peer's answer settles it on the NOSTRO or returns it (finishWire).
 async reserveWire(client,actor,{form,bookingAccountId,nostroAccountId}){
  if(await this.#uetrTaken(client,form.uetr,null))fault('FIN_UETR_DUPLICATE','uetr',409);
  await this.#checkSelection(client,{bookingAccountId,nostroAccountId,tokenWalletId:null},form,'OUTGOING');
  return this.#reserve(client,actor,{form,bookingAccountId,nostroAccountId});
 }
 // Screen 1's Transact (src/fin-peer.mjs, transact). The bank owner: "When the transaction is filled, then add a button for press
 // Transact for the transaction executed" - an outgoing message as the composer wrote it, one that passes Validate XML, paid from
 // the Common or Suspense account chosen and cleared through the NOSTRO chosen ("book the message monies to our common account and
 // the physical clearing to our NOSTRO selected"). Checked here before anything is reserved or sent.
 async transactable(actor,body){
  this.#administrator(actor);
  const form=this.#form(body?.form),selection=this.#selection(body?.selection),direction=this.#direction(body?.direction),xml=buildFinMessage(form),draftId=body?.draftId??null;
  // An incoming transfer is booked by the bank as it comes (the bank owner: "booked automatically ... does not need press to transact").
  if(direction==='INCOMING')fault('FIN_TRANSACT_DIRECTION','direction',409);
  this.#typed(form,direction);
  if(draftId!==null&&!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(draftId!==null&&!Number.isInteger(body?.revision))fault('INVALID_FIELD','revision');
  if(!selection.bookingAccountId)fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
  if(!selection.nostroAccountId)fault('FIN_NOSTRO_ACCOUNT','nostroAccountId',409);
  if(direction==='DEBIT'){
   // A Debit collects from the debtor named, at their account, under the mandate they signed (the bank owner: "when we have
   // authorisation for debiting an external connected account").
   if(!form.debtorName)fault('FIN_DEBIT_DEBTOR','debtorName');
   if(!form.debtorIban)fault('FIN_DEBIT_ACCOUNT','debtorIban');
   if(!form.mandateId)fault('FIN_DEBIT_MANDATE','mandateId');
   if(!form.mandateSignatureDate)fault('FIN_DEBIT_MANDATE','mandateSignatureDate');
  }else{
   // A wire pays a beneficiary named, at their account, as the Cash Wire's (src/fin-peer.mjs, #wire).
   if(!form.creditorName)fault('FIN_WIRE_BENEFICIARY','creditorName');
   if(!form.creditorIban)fault('FIN_WIRE_ACCOUNT','creditorIban');
  }
  if(fieldProblems(form).length||!(await validateFinMessage(xml,form.messageType)).valid)fault('FIN_TRANSACT_INVALID','xml');
  // An outgoing message is paid from the account; a Debit's money may be converted into the wallet chosen.
  return {form,xml,direction,selection:direction==='DEBIT'?selection:{...selection,tokenWalletId:null},draftId,revision:draftId===null?null:body.revision};
 }
 // Transacted, the message is kept for good as the draft it was written in - closed, never changed or sent again: the bank owner,
 // "Multiple pressing are not generating duplicated a transaction" - and its money is reserved as a Cash Wire's is.
 async reserveTransact(client,actor,{form,xml,selection,draftId,revision}){
  if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
  await this.#checkSelection(client,selection,form,'OUTGOING');
  if(draftId!==null)await this.#opened(client,draftId,revision);
  const reserved=await this.#reserve(client,actor,{form,bookingAccountId:selection.bookingAccountId,nostroAccountId:selection.nostroAccountId});
  const row=await this.#keep(client,actor,draftId,{form,xml,valid:true,selection,direction:'OUTGOING'},reserved.journalId);
  return {...reserved,draftId:row.draft_id};
 }
 async #reserve(client,actor,{form,bookingAccountId,nostroAccountId}){
  const nostro=await this.#nostroLedger(client,nostroAccountId,form.currency);
  if(!nostro)fault('FIN_WIRE_NOSTRO','profileId',409);
  const core=new SovereignCore(null),suspense=await core.system(client,'SUSPENSE_OUTBOUND',form.currency,WIRE_SUSPENSE);
  const free=new Map((await client.query(`SELECT account_id,available_balance-locked_balance>=$2::numeric AS covered FROM avis_core_v2.ledger_accounts
   WHERE account_id=ANY($1::uuid[]) ORDER BY account_id FOR UPDATE`,[[bookingAccountId,nostro.account_id],form.amount])).rows.map(row=>[row.account_id,row.covered]));
  if(!free.get(bookingAccountId))fault('INSUFFICIENT_FUNDS','amount',409);
  if(!free.get(nostro.account_id))fault('INSUFFICIENT_CLEARING_FUNDS','profileId',409);
  await client.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance+$2::numeric WHERE account_id=$1',[nostro.account_id,form.amount]);
  const journalId=await core.post(client,actor,'fin-outgoing:'+form.uetr,'FIN_OUTGOING_RESERVED',form.businessMessageId,
   [{accountId:bookingAccountId,direction:'DEBIT',amount:form.amount},{accountId:suspense,direction:'CREDIT',amount:form.amount}]);
  return {journalId,suspense};
 }
 // The peer's answer to a wire: settled (ACSC, ACCC), its money goes from the suspense account to the NOSTRO, whose cash it reserved;
 // refused (RJCT), or never delivered, back to the account it was paid from.
 async finishWire(client,actor,wire,settled,reference){
  const nostro=(await client.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[wire.nostro_cash_account_id])).rows[0].ledger_account_id;
  await client.query('SELECT 1 FROM avis_core_v2.ledger_accounts WHERE account_id=ANY($1::uuid[]) ORDER BY account_id FOR UPDATE',[[nostro,wire.booking_account_id,wire.suspense_account_id]]);
  await client.query('UPDATE avis_core_v2.ledger_accounts SET locked_balance=locked_balance-$2::numeric WHERE account_id=$1',[nostro,wire.amount]);
  return new SovereignCore(null).post(client,actor,'fin-outgoing-'+(settled?'settled:':'returned:')+wire.uetr,settled?'FIN_OUTGOING_SETTLED':'FIN_OUTGOING_RETURNED',reference,
   [{accountId:wire.suspense_account_id,direction:'DEBIT',amount:wire.amount},{accountId:settled?nostro:wire.booking_account_id,direction:'CREDIT',amount:wire.amount}],
   settled?null:wire.reserve_journal_id);
 }
 // Under MANUAL INTERVENTION a peer's transfer is checked as one registered and held for the operator: kept as an incoming draft
 // on AVISPay PLC's account and the NOSTRO it names, nothing booked; the operator registers it in the composer.
 async #hold(client,actor,{form,xml,selection}){
  if(await this.#uetrTaken(client,form.uetr,null))fault('FIN_UETR_DUPLICATE','uetr',409);
  await this.#checkSelection(client,selection,form,'INCOMING');
  const row=await this.#keep(client,actor,null,{form,xml,valid:true,selection,direction:'INCOMING'});
  await client.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),'FIN_INCOMING_HELD',row.draft_id]);
  return row;
 }
 // A transfer taken before is answered as it was - booked or converted, or held - when every field that makes the payment is the same, from the
 // same peer's NOSTRO; otherwise its UETR names another payment (review finding: not only the amount, currency and creditor).
 async #replay(client,peer,form){
  const before=(await client.query(`SELECT d.form,d.direction,d.nostro_cash_account_id,d.registered_journal_id,c.asset,c.quantity::text AS quantity,c.tx_hash AS hash
   FROM avis_core_v2.fin_terminal_drafts d LEFT JOIN avis_core_v2.fin_terminal_conversions c ON c.draft_id=d.draft_id WHERE d.uetr=$1`,[form.uetr])).rows[0];
  if(!before)return null;
  if(before.direction!=='INCOMING'||before.nostro_cash_account_id!==peer.cash_account_id||PAYMENT_FIELDS.some(field=>(before.form[field]??'')!==form[field]))
   return {status:'RJCT',...REJECTED.FIN_UETR_DUPLICATE};
  return before.registered_journal_id?booked(form,before.asset?before:null):HELD;
 }
 // A peer bank's credit transfer taken on the listening port (src/fin-peer.mjs), the FinTerminal specification v3's
 // receive_ip2ip_pacs008 - "Auto-parses incoming credits, validates XSD, and returns pacs.002 (ACSC)" while ROBOTIC STP is active:
 // booked at once as one registered by hand, on the bank's NOSTRO at that peer (its connector's clearing account) and on AVISPay
 // PLC's account its creditor's IBAN names, in the transaction that keeps the message and the bank's answer - or, the account
 // routed into a wallet (quoteIncoming), converted into that wallet instead: "AUTO_CRYPTO". Under MANUAL INTERVENTION it is held
 // for the operator, ACTC (review finding: the switch decides). One the bank cannot book is answered RJCT with the reason, nothing
 // kept; the same transfer again is answered as before.
 async receiveIncoming(client,peer,input,quote=null){
  let form;try{form=this.#form(input);}catch{return {status:'RJCT',...REJECTED.FIN_INCOMING_INVALID};}
  // One delivery of a transfer at a time: the same transfer delivered twice at once is answered the second time as the first was
  // (review finding).
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('avis_core_v2:fin-incoming:'||$1,0))",[form.uetr]);
  const before=await this.#replay(client,peer,form);if(before)return before;
  const xml=buildFinMessage(form);
  if(fieldProblems(form).length||!(await validateFinMessage(xml)).valid)return {status:'RJCT',...REJECTED.FIN_INCOMING_INVALID};
  const account=(await client.query(BOOKING+' AND b.abiq_iban=$2 AND a.currency_code=$3 ORDER BY a.account_id LIMIT 1',[RECEIVING_OWNERS,form.creditorIban,form.currency])).rows[0];
  if(!account)return {status:'RJCT',...REJECTED.FIN_BOOKING_ACCOUNT};
  // The mode and the account's route as they are now, held until the transfer is taken: a quote read before the transaction for
  // another route - or none - is read again (review finding).
  const robotic=(await client.query('SELECT robotic_stp FROM avis_core_v2.fin_terminal_mode WHERE mode_id=1 FOR SHARE')).rows[0]?.robotic_stp===true;
  const route=robotic?(await client.query('SELECT token_wallet_account_id FROM avis_core_v2.fin_terminal_crypto_routes WHERE booking_account_id=$1 FOR SHARE',
   [account.account_id])).rows[0]?.token_wallet_account_id??null:null;
  if(robotic&&route!==(quote?.wallet?.account_id??quote?.walletId??null))return {stale:true,status:'RJCT',...REJECTED.FIN_CONVERT_ROUTE};
  if(robotic&&quote?.failed)return {status:'RJCT',...REJECTED[quote.failed]};
  await client.query('SAVEPOINT fin_incoming');
  try{
   const actor={id:'listener:'+peer.profile_id},wallet=robotic?quote?.wallet??null:null;
   const selection={bookingAccountId:account.account_id,nostroAccountId:peer.cash_account_id,tokenWalletId:wallet?.account_id??null};
   if(!robotic){await this.#hold(client,actor,{form,xml,selection});await client.query('RELEASE SAVEPOINT fin_incoming');return HELD;}
   const converted=wallet?await this.#convert(client,actor,{form,xml,selection,wallet,quote,mode:'ROBOTIC'}):(await this.#book(client,actor,{form,xml,selection}),null);
   await client.query('RELEASE SAVEPOINT fin_incoming');
   return booked(form,converted);
  }catch(error){
   await client.query('ROLLBACK TO SAVEPOINT fin_incoming');
   const code=error.code==='23505'?'FIN_UETR_DUPLICATE':error.code;
   if(!Object.hasOwn(REJECTED,code))throw error;
   return {status:'RJCT',...REJECTED[code]};
  }
 }
 // Before a peer's transfer is taken (src/fin-peer.mjs), with no transaction open yet: whether it is converted - ROBOTIC STP active
 // and a wallet routed for AVISPay PLC's account its creditor's IBAN names - and at which live rate.
 async quoteIncoming(input){
  const form=normalizeForm(input);
  const route=(await this.pool.query(`SELECT r.token_wallet_account_id FROM avis_core_v2.fin_terminal_crypto_routes r
   JOIN avis_core_v2.abiq_account_identifiers b ON b.ledger_account_id=r.booking_account_id AND b.status='ACTIVE'
   JOIN avis_core_v2.ledger_accounts a ON a.account_id=r.booking_account_id
   JOIN avis_core_v2.fin_terminal_mode m ON m.mode_id=1 AND m.robotic_stp
   WHERE b.abiq_iban=$1 AND a.currency_code=$2`,[form.creditorIban,form.currency])).rows[0];
  if(!route)return null;
  try{const wallet=await this.#wallet(this.pool,route.token_wallet_account_id);return {wallet,...await this.#rate(form.currency,wallet)};}
  catch(error){return {failed:Object.hasOwn(REJECTED,error.code)?error.code:'FIN_CONVERT_RATE',walletId:route.token_wallet_account_id};}
 }
 // Screen B's Fiat-to-Crypto/Stablecoin Selector (the specification v3): each of AVISPay PLC's accounts with the wallet its credits
 // are converted into while ROBOTIC STP is active, the wallets offered and their live rates, and the transfers converted with their
 // IVMS101 verification.
 async converter(actor){
  this.#administrator(actor);
  const accounts=(await this.pool.query(BOOKING+' ORDER BY a.currency_code,a.owner_type,b.abiq_iban',[RECEIVING_OWNERS])).rows;
  const routes=new Map((await this.pool.query('SELECT booking_account_id,token_wallet_account_id FROM avis_core_v2.fin_terminal_crypto_routes')).rows
   .map(row=>[row.booking_account_id,row.token_wallet_account_id]));
  const wallets=(await this.pool.query(WALLETS+' AND l.currency_code=ANY($1::text[])'+HAS_ADDRESS+' ORDER BY l.currency_code,l.network,u.full_name',[CONVERT_ASSETS])).rows;
  const pairs=[...new Set(accounts.map(row=>row.currency_code))].flatMap(currency=>[...new Map(wallets.map(row=>[row.currency_code+'|'+row.network,row])).values()]
   .map(wallet=>({currency,wallet})));
  const rates=await Promise.all(pairs.map(async({currency,wallet})=>{
   const quote=await this.#rate(currency,wallet).catch(()=>null);
   return {currency,asset:wallet.currency_code,network:wallet.network,rate:quote?.rate??null,source:quote?.source??null};
  }));
  const conversions=(await this.pool.query(`SELECT c.*,c.quantity::text AS units,c.rate::text AS price,c.fiat_amount::text AS fiat FROM avis_core_v2.fin_terminal_conversions c
   ORDER BY c.created_at DESC LIMIT 20`)).rows;
  return {assets:CONVERT_ASSETS,
   accounts:accounts.map(row=>({accountId:row.account_id,label:row.label,iban:row.abiq_iban,currency:row.currency_code,tokenWalletId:routes.get(row.account_id)??null})),
   wallets:wallets.map(row=>({accountId:row.account_id,holder:row.full_name,currency:row.currency_code,network:row.network})),rates,
   conversions:conversions.map(row=>({uetr:row.uetr,at:new Date(row.created_at).toISOString(),amount:row.fiat,currency:row.fiat_currency,asset:row.asset,network:row.network,
    quantity:four(row.units),rate:row.price,rateSource:row.rate_source,txHash:row.tx_hash,mode:row.mode,
    ivms101:{verified:row.ivms101.verified===true,originator:row.ivms101.originator.originatorPersons[0].legalPerson.name.nameIdentifier[0].legalPersonName,
     beneficiary:row.ivms101.beneficiary.beneficiaryPersons[0].legalPerson.name.nameIdentifier[0].legalPersonName,wallet:row.ivms101.beneficiary.accountNumber[0]}}))};
 }
 // A bank administrator routes an account's credits into a wallet, or back to the NOSTRO (no wallet).
 async route(actor,body){
  this.#administrator(actor);
  const {bookingAccountId,tokenWalletId}=this.#selection({bookingAccountId:body?.bookingAccountId,tokenWalletId:body?.tokenWalletId});
  if(!bookingAccountId||!(await this.pool.query(BOOKING+' AND a.account_id=$2',[RECEIVING_OWNERS,bookingAccountId])).rows.length)fault('FIN_BOOKING_ACCOUNT','bookingAccountId',409);
  if(tokenWalletId){
   await this.#wallet(this.pool,tokenWalletId);
   await this.pool.query(`INSERT INTO avis_core_v2.fin_terminal_crypto_routes(booking_account_id,token_wallet_account_id,changed_by) VALUES($1,$2,$3)
    ON CONFLICT(booking_account_id) DO UPDATE SET token_wallet_account_id=EXCLUDED.token_wallet_account_id,changed_by=EXCLUDED.changed_by,changed_at=now()`,
    [bookingAccountId,tokenWalletId,String(actor.id)]);
  }else await this.pool.query('DELETE FROM avis_core_v2.fin_terminal_crypto_routes WHERE booking_account_id=$1',[bookingAccountId]);
  await this.pool.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),'FIN_CRYPTO_ROUTE',bookingAccountId]);
  return this.converter(actor);
 }
}
