import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {validateXML} from 'xmllint-wasm';
import {fault} from './core.mjs';
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

export async function validateFinMessage(xml){
 if(typeof xml!=='string'||!xml.trim()||Buffer.byteLength(xml)>65535||/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))fault('FIN_MESSAGE_INVALID','xml');
 const result=await validateXML({xml:{fileName:'message.xml',contents:xml},schema:{fileName:'envelope.xsd',contents:ENVELOPE},preload:await officialSchemas(),maxMemoryPages:512});
 if(result.valid)return {valid:true,errors:[]};
 // A parser's finding comes with the line it is about and a pointer to it; the finding itself is kept.
 const errors=result.errors.filter(error=>/error : /.test(String(error.message||error.rawMessage||''))).map(readable);
 return {valid:false,errors:errors.length?errors:['XML: The message could not be checked.']};
}

const draftOf=(row,full=true)=>({draftId:row.draft_id,revision:row.revision,uetr:row.uetr,messageType:row.message_type,
 amount:row.form.amount,currency:row.form.currency,creditorName:row.form.creditorName,schemaValid:row.schema_valid,
 updatedAt:new Date(row.updated_at).toISOString(),updatedBy:row.updated_by,...(full?{form:row.form,xml:row.message}:{})});

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
  const form=this.#form(body?.form),xml=buildFinMessage(form),draftId=body?.draftId??null;
  if(draftId!==null&&!UETR.test(String(draftId)))fault('FIN_DRAFT_NOT_FOUND','draftId',404);
  if(draftId!==null&&!Number.isInteger(body?.revision))fault('INVALID_FIELD','revision');
  const valid=(await validateFinMessage(xml)).valid&&!fieldProblems(form).length;
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   if(await this.#uetrTaken(client,form.uetr,draftId))fault('FIN_UETR_DUPLICATE','uetr',409);
   let row;
   if(draftId===null){
    row=(await client.query(`INSERT INTO avis_core_v2.fin_terminal_drafts(draft_id,uetr,message_type,revision,form,message,schema_valid,created_by,updated_by)
     VALUES($1,$2,$3,1,$4::jsonb,$5,$6,$7,$7) RETURNING *`,[randomUUID(),form.uetr,form.messageType,JSON.stringify(form),xml,valid,String(actor.id)])).rows[0];
   }else{
    row=(await client.query(`UPDATE avis_core_v2.fin_terminal_drafts SET uetr=$3,revision=revision+1,form=$4::jsonb,message=$5,schema_valid=$6,updated_by=$7,updated_at=now()
     WHERE draft_id=$1 AND revision=$2 RETURNING *`,[draftId,body.revision,form.uetr,JSON.stringify(form),xml,valid,String(actor.id)])).rows[0];
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
