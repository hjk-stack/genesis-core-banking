import {createHash} from 'node:crypto';
import {fault} from './core.mjs';
import {IP_PROOF_MAX_BYTES} from './checkout-ip-processing.mjs';

export async function registerHandlerDraft(pool,actor,input){
 if(!actor?.ipHandlerService||!actor.id||actor.customerUserId)fault('FORBIDDEN',null,403);
 const {transferId,registerNumber,revision,savedAt,beneficiary,account,amount,currency,pdf}=input;
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(transferId)||!/^IP-\d{8,16}$/.test(registerNumber)||
  !Number.isSafeInteger(revision)||revision<1||revision>2147483647||typeof savedAt!=='string'||!Number.isFinite(Date.parse(savedAt))||
  [beneficiary,account,amount,currency].some(v=>typeof v!=='string'||v.length>1000||v.includes('\0')))fault('INVALID_FIELD','draft');
 if(typeof pdf!=='string'||pdf.length>Math.ceil(IP_PROOF_MAX_BYTES/3)*4)fault('INVALID_FIELD','pdf');
 const bytes=Buffer.from(pdf,'base64');
 if(bytes.toString('base64')!==pdf||bytes.length>IP_PROOF_MAX_BYTES||bytes.subarray(0,5).toString()!=='%PDF-'||
  !bytes.subarray(-32).toString().includes('%%EOF'))fault('INVALID_FIELD','pdf');
 const values=[transferId,registerNumber,revision,savedAt,beneficiary,account,amount,currency];
 const hash=createHash('sha256').update(JSON.stringify(values)).update(bytes).digest('hex');
 const written=await pool.query(`INSERT INTO avis_core_v2.ip_handler_drafts AS d
  (transfer_id,register_number,revision,saved_at,beneficiary,account_number,amount_text,currency_text,pdf,content_hash)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  ON CONFLICT (transfer_id) DO UPDATE SET revision=EXCLUDED.revision,saved_at=EXCLUDED.saved_at,
   beneficiary=EXCLUDED.beneficiary,account_number=EXCLUDED.account_number,amount_text=EXCLUDED.amount_text,
   currency_text=EXCLUDED.currency_text,pdf=EXCLUDED.pdf,content_hash=EXCLUDED.content_hash
  WHERE d.register_number=EXCLUDED.register_number AND d.revision<EXCLUDED.revision RETURNING revision`,[...values,bytes,hash]);
 if(written.rows.length)return {transferId,revision};
 const row=(await pool.query('SELECT revision,register_number,content_hash FROM avis_core_v2.ip_handler_drafts WHERE transfer_id=$1',[transferId])).rows[0];
 if(row?.register_number!==registerNumber||row.revision===revision&&row.content_hash!==hash)fault('IDEMPOTENCY_CONFLICT','draft',409);
 return {transferId,revision:row.revision};
}

export async function handlerDraftPdf(pool,actor,id){
 if(!actor?.admin||actor.customerUserId)fault('FORBIDDEN',null,403);
 const row=(await pool.query('SELECT pdf,register_number FROM avis_core_v2.ip_handler_drafts WHERE transfer_id=$1',[id])).rows[0];
 if(!row)fault('CHECKOUT_IP_PROOF_NOT_FOUND',null,404);
 return {bytes:Buffer.from(row.pdf),fileName:row.register_number+'.pdf'};
}
