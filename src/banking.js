'use strict';
// Internal service layer only. Do NOT expose these methods through public HTTP
// without strong customer/staff authorization, rate limiting and audit policies.
const { randomUUID } = require('node:crypto');
const {currency, minorUnits, balanced} = require('./domain');
function requireActor(actor) {
  if (!actor || !actor.id || actor.authorized !== true) throw new Error('UNAUTHORIZED');
}
async function createCustomer(pool, actor, input) {
  requireActor(actor);
  if (!input || !['person','organization'].includes(input.kind)) throw new Error('INVALID_CUSTOMER_KIND');
  const id = randomUUID();
  await pool.query('INSERT INTO banking.customers(id,kind,status,created_by) VALUES($1,$2,$3,$4)', [id,input.kind,'pending_review',actor.id]);
  return {id,status:'pending_review'};
}
async function openWallet(pool, actor, input) {
  requireActor(actor);
  if (!input?.customerId) throw new Error('CUSTOMER_REQUIRED');
  const asset = currency(input.assetCode);
  const id = randomUUID();
  await pool.query('INSERT INTO banking.wallets(id,customer_id,asset_code,status) VALUES($1,$2,$3,$4)', [id,input.customerId,asset,'pending_review']);
  return {id,status:'pending_review'};
}
async function recordPaymentInstruction(pool, actor, input) {
  requireActor(actor);
  const amount = minorUnits(input?.amountMinor);
  const asset = currency(input?.assetCode);
  if (!input?.debtorWalletId || !input?.creditorReference || !input?.idempotencyKey) throw new Error('MISSING_PAYMENT_FIELDS');
  const id=randomUUID();
  const r=await pool.query(
    "INSERT INTO banking.payment_instructions(id,debtor_wallet_id,creditor_reference,asset_code,amount_minor,idempotency_key,status,created_by) VALUES($1,$2,$3,$4,$5,$6,'draft',$7) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,status",
    [id,input.debtorWalletId,input.creditorReference,asset,amount.toString(),input.idempotencyKey,actor.id]);
  return r.rows[0]; // Draft only: NO settlement or external payment execution.
}
async function postTestJournal(pool, actor, journal) {
  requireActor(actor);
  if (process.env.GENESIS_ENABLE_TEST_POSTING !== 'true') throw new Error('POSTING_DISABLED');
  balanced(journal?.entries);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const id=randomUUID();
    await client.query("INSERT INTO banking.journals(id,reference,asset_code,status,created_by) VALUES($1,$2,$3,'posted',$4)",[id,journal.reference,currency(journal.entries[0].currency),actor.id]);
    for (const entry of journal.entries) {
      await client.query('INSERT INTO banking.journal_entries(id,journal_id,ledger_account_id,side,amount_minor,asset_code) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,entry.accountId,entry.side,minorUnits(entry.amountMinor).toString(),entry.currency]);
    }
    await client.query('COMMIT');
    return {journalId:id,status:'posted'};
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally {client.release();}
}
module.exports={createCustomer,openWallet,recordPaymentInstruction,postTestJournal};
