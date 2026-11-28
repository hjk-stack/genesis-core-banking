import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {cryptoLedgerAccount} from '../src/crypto/rolling-ledger.mjs';
import {FinTerminal} from '../src/fin-terminal.mjs';
import {newUetr} from '../public/fin-message.mjs';
import {createBankServer} from '../server.mjs';
import {finTerminalOwner} from './helpers/fin-example.mjs';
import {exampleForm} from './helpers/fin-example.mjs';

// Step 2 of the peer register's checklist, page 1's FIAT Converter and Bank fee. The bank owner: "missing the button with clear
// statement for "FIAT Converter" activation and then the wallet selector is active and calls the wallets they are in the crypto
// section wallet scroller operative", "install a second row below the selected accounts the live change rate", and "bank fees is
// taken from the amount ... and booked into the treasury wallets or account ... If the conversion is pressed then we will take the
// fees in the Crypto section".
const admin={id:'fin-fee-admin',username:'fin-fee',admin:true},guest={id:'guest',admin:false};
const BTC_EUR='54900';
let pool,db,fin,suspense,account,nostro,nostroLedger,eurc,btc,unaddressed,usdt;
let priced=true;
const pricing={spot:async(descriptor,fiat)=>{
 if(!priced||descriptor?.network!=='BITCOIN'||fiat!=='EUR')throw Object.assign(new Error('quote service'),{code:'METAMASK_PRICE'});
 return {rate:BTC_EUR+'.000000000000000000',observedAt:Date.now(),source:'MetaMask'};
}};
const refused=(code,field)=>error=>error.code===code&&(field===undefined||error.field===field);
const incoming=(overrides={})=>({...exampleForm(),uetr:newUetr(),senderBic:'EXMPDEFFXXX',receiverBic:account.bic,settlement:'INGA',
 settlementAccount:'NOSTRO-EXAMPLE-1',creditorName:account.institution,creditorIban:account.iban,creditorAgentBic:account.bic,amount:'1000.00',...overrides});
const selection=(tokenWalletId=null)=>({bookingAccountId:suspense.id,nostroAccountId:nostro.id,tokenWalletId});
// The booking of a registered draft: each entry with its account's kind, in cents.
const entries=async draftId=>(await pool.query(`SELECT e.direction,(e.amount*100)::bigint::text AS cents,a.owner_type,a.sub_account_code,a.account_category,a.currency_code
 FROM avis_core_v2.fin_terminal_drafts d JOIN avis_core_v2.ledger_entries e ON e.journal_id=d.registered_journal_id JOIN avis_core_v2.ledger_accounts a USING(account_id)
 WHERE d.draft_id=$1 ORDER BY e.direction DESC,e.amount DESC`,[draftId])).rows.map(row=>[row.direction,row.cents,row.owner_type,row.owner_type==='TREASURY'?row.sub_account_code:'',row.account_category,row.currency_code]);
const counted=async()=>(await pool.query(`SELECT (SELECT count(*) FROM avis_core_v2.fin_terminal_drafts)::int AS drafts,
 (SELECT count(*) FROM avis_core_v2.ledger_journals)::int AS journals`)).rows[0];

before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 fin=new FinTerminal(pool,{pricing});const bank=new AccountManagement(pool,{directory:{env:{}}});
 suspense=(await bank.openAccount(admin,{accountType:'SUSPENSE',fullName:'AVISPay PLC',currencies:['EUR']},randomUUID())).managedAccounts[0];
 account=(await fin.accounts(admin)).bookingAccounts.find(item=>item.accountId===suspense.id);
 nostro=await bank.registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Example NOSTRO',bic:'EXMPDEFFXXX',accountNumber:'NOSTRO-EXAMPLE-1',currency:'EUR'},randomUUID());
 nostroLedger=(await pool.query('SELECT ledger_account_id FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=$1',[nostro.id])).rows[0].ledger_account_id;
 // The treasury holder's "+" wallets: EURC on Solana and BTC, each with its receiving address; EURC on Ethereum without one there;
 // USDT, which the converter does not load.
 const holder=(await bank.openCustomer(admin,{fullName:'Example Treasury Holder',accountType:'PERSONAL',currencies:['EUR']},randomUUID())).userId;
 eurc=await cryptoLedgerAccount(pool,{userId:holder,currency:'EURC',network:'SOLANA'});btc=await cryptoLedgerAccount(pool,{userId:holder,currency:'BTC',network:'BITCOIN'});
 unaddressed=await cryptoLedgerAccount(pool,{userId:holder,currency:'EURC',network:'ETHEREUM'});usdt=await cryptoLedgerAccount(pool,{userId:holder,currency:'USDT',network:'SOLANA'});
 for(const [network,address] of [['SOLANA','ExampleSolanaTreasuryAddress1111111111111'],['BITCOIN','bc1qexampletreasuryaddress000000000000000']])
  await pool.query('INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address,is_primary) VALUES($1,$2,$3,true)',[holder,network,address]);
});
after(async()=>{if(db)await db.close();else await pool.end()});

test('the "+" wallets offered are the operative ones: in a converter asset, with a receiving address on their chain',async()=>{
 const offered=(await fin.accounts(admin)).tokenWallets;
 assert.deepEqual(offered.map(wallet=>[wallet.accountId,wallet.currency,wallet.network]),[[btc,'BTC','BITCOIN'],[eurc,'EURC','SOLANA']]);
 for(const tokenWalletId of [unaddressed,usdt])
  await assert.rejects(fin.save(admin,{form:incoming(),selection:selection(tokenWalletId),direction:'INCOMING'}),refused('FIN_TOKEN_WALLET','tokenWalletId'));
});

test('the live rate of the wallet chosen and, with the amount, the tokens it converts to - as a transfer registered now',async()=>{
 const {observedAt,...euro}=await fin.quote(admin,{tokenWalletId:eurc,currency:'EUR',amount:'1000.00'});
 assert.deepEqual(euro,{asset:'EURC',network:'SOLANA',rate:'1.000000000000000000',source:'MiCA 1:1',quantity:'999.5000'});
 assert.match(observedAt,/^\d{4}-\d{2}-\d{2}T/);
 const bitcoin=await fin.quote(admin,{tokenWalletId:btc.toUpperCase(),currency:'EUR',amount:'54900'});
 assert.deepEqual([bitcoin.asset,bitcoin.network,bitcoin.source,Number(bitcoin.rate).toPrecision(6),bitcoin.quantity],['BTC','BITCOIN','MetaMask',(1/54900).toPrecision(6),'0.9995']);
 assert.match(bitcoin.observedAt,/^\d{4}-\d{2}-\d{2}T/);
 // Without the amount, the rate alone.
 assert.equal((await fin.quote(admin,{tokenWalletId:btc,currency:'EUR',amount:''})).quantity,null);
 for(const [input,code,field] of [[{currency:'EUR'},'FIN_TOKEN_WALLET','tokenWalletId'],[{tokenWalletId:usdt,currency:'EUR'},'FIN_TOKEN_WALLET','tokenWalletId'],
  [{tokenWalletId:unaddressed,currency:'EUR'},'FIN_WALLET_ADDRESS','tokenWalletId'],[{tokenWalletId:'wallet',currency:'EUR'},'INVALID_FIELD','tokenWalletId'],
  [{tokenWalletId:eurc,currency:'eur'},'INVALID_FIELD','currency'],[{tokenWalletId:eurc},'INVALID_FIELD','currency'],
  [{tokenWalletId:eurc,currency:'EUR',amount:'0'},'INVALID_FIELD','amount'],[{tokenWalletId:eurc,currency:'EUR',amount:'1.123456'},'INVALID_FIELD','amount'],
  [{tokenWalletId:btc,currency:'USD'},'FIN_CONVERT_RATE','tokenWalletId'],
  // An amount that converts to no token at four decimals cannot be registered or sent: no quote for it either (review finding).
  [{tokenWalletId:btc,currency:'EUR',amount:'0.01'},'FIN_CONVERT_QUANTITY','amount']])
  await assert.rejects(fin.quote(admin,input),refused(code,field),JSON.stringify(input));
 priced=false;try{await assert.rejects(fin.quote(admin,{tokenWalletId:btc,currency:'EUR'}),error=>refused('FIN_CONVERT_RATE')(error)&&error.status===503);}finally{priced=true;}
 await assert.rejects(fin.quote(guest,{tokenWalletId:eurc,currency:'EUR'}),refused('FORBIDDEN'));
});

test('registered with a bank fee, an incoming transfer is booked on the NOSTRO in full, on the chosen account less the fee, and the fee on the Treasury account',async()=>{
 const registered=await fin.register(admin,{form:incoming(),selection:selection(),bankFee:'10.50'});
 assert.deepEqual([registered.registered,registered.bankFee],[true,'10.50']);
 assert.deepEqual(await entries(registered.draftId),[
  ['DEBIT','100000','CORRESPONDENT_NOSTRO','','ASSET','EUR'],
  ['CREDIT','98950','SUSPENSE_INBOUND','','LIABILITY','EUR'],
  ['CREDIT','1050','TREASURY','BANK_FEES','REVENUE','EUR']]);
 assert.equal((await fin.draft(admin,registered.draftId)).bankFee,'10.50');
 // Another fee in euros goes to the same Treasury account; without one, the account takes the whole amount, as before.
 await fin.register(admin,{form:incoming(),selection:selection(),bankFee:'4'});
 assert.equal((await pool.query("SELECT (available_balance*100)::bigint::text AS cents FROM avis_core_v2.ledger_accounts WHERE owner_type='TREASURY' AND sub_account_code='BANK_FEES' AND currency_code='EUR'")).rows[0].cents,'1450');
 const plain=await fin.register(admin,{form:incoming(),selection:selection(),bankFee:''});
 assert.deepEqual([plain.bankFee,(await entries(plain.draftId)).map(entry=>entry.slice(0,2))],['',[['DEBIT','100000'],['CREDIT','100000']]]);
 assert.ok(nostroLedger);
});

test('a draft keeps its bank fee; saved again without it, none',async()=>{
 const saved=await fin.save(admin,{form:incoming(),selection:selection(),direction:'INCOMING',bankFee:'2.5'});
 assert.equal(saved.bankFee,'2.50');assert.equal((await fin.draft(admin,saved.draftId)).bankFee,'2.50');
 assert.equal((await fin.save(admin,{draftId:saved.draftId,revision:saved.revision,form:saved.form,selection:selection(),direction:'INCOMING'})).bankFee,'');
 // A draft not written to the end keeps its fee too.
 assert.equal((await fin.save(admin,{form:incoming({amount:'',messageType:'pacs.003.001.08'}),selection:{},direction:'DEBIT',bankFee:'1.00'})).bankFee,'1.00');
});

test('a bank fee is above zero and below the amount, for an incoming transfer or a Debit not converted: otherwise nothing is kept or booked',async()=>{
 const before=await counted();
 for(const [body,code] of [
  [{form:incoming(),selection:selection(),bankFee:'1000.00'},'FIN_BANK_FEE'],[{form:incoming(),selection:selection(),bankFee:'1500'},'FIN_BANK_FEE'],
  [{form:incoming(),selection:selection(eurc),bankFee:'1.00'},'FIN_BANK_FEE'],
  [{form:incoming(),selection:selection(),bankFee:'0'},'INVALID_FIELD'],[{form:incoming(),selection:selection(),bankFee:'-1'},'INVALID_FIELD'],
  [{form:incoming(),selection:selection(),bankFee:'1.123456'},'INVALID_FIELD'],[{form:incoming(),selection:selection(),bankFee:10},'INVALID_FIELD']])
  await assert.rejects(fin.register(admin,body),error=>refused(code,'bankFee')(error)&&error.status===(code==='FIN_BANK_FEE'?409:422),JSON.stringify(body.bankFee));
 // An outgoing message carries none; a Debit's fee, too, stays below its amount.
 await assert.rejects(fin.save(admin,{form:incoming(),selection:{},direction:'OUTGOING',bankFee:'1.00'}),refused('FIN_BANK_FEE','bankFee'));
 await assert.rejects(fin.save(admin,{form:incoming({messageType:'pacs.003.001.08'}),selection:{},direction:'DEBIT',bankFee:'1000'}),refused('FIN_BANK_FEE','bankFee'));
 await assert.rejects(fin.transactable(admin,{form:incoming(),selection:selection(),direction:'OUTGOING',bankFee:'1.00'}),refused('FIN_BANK_FEE','bankFee'));
 assert.deepEqual(await counted(),before);
});

test('over HTTP: the live rate for a signed-in FinTerminal administrator, and a bank fee refused with its reason',async()=>{
 const server=createBankServer({pool,authenticate:async()=>admin,finTerminalAccess:async()=>finTerminalOwner,secureCookies:false,transferOptions:{finPricing:pricing}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const quoted=await fetch(base+'/api/fin-terminal/quote?tokenWalletId='+eurc+'&currency=EUR&amount=250.00',{headers:{cookie}});
  assert.equal(quoted.status,200);assert.deepEqual((({asset,rate,quantity})=>({asset,rate,quantity}))(await quoted.json()),{asset:'EURC',rate:'1.000000000000000000',quantity:'249.8750'});
  const unknown=await fetch(base+'/api/fin-terminal/quote?currency=EUR',{headers:{cookie}});
  assert.equal(unknown.status,409);assert.equal((await unknown.json()).code,'FIN_TOKEN_WALLET');
  const fee=await fetch(base+'/api/fin-terminal/incoming',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json','x-csrf-token':csrf},
   body:JSON.stringify({form:incoming(),selection:selection(),bankFee:'5000'})});
  assert.equal(fee.status,409);assert.deepEqual((({code,field,message})=>({code,field,message}))(await fee.json()),
   {code:'FIN_BANK_FEE',field:'bankFee',message:'The bank fee is below the amount, for an incoming transfer or a Debit that is not converted.'});
 }finally{await new Promise(resolve=>server.close(resolve))}
});
