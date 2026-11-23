#!/usr/bin/env node
// Cross-repository integration: real application code, an in-memory core database,
// generated signing identity, loopback HTTP transport and an isolated fixture bank.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {AccountManagement} from '../src/account-management.mjs';
import {PaymentServer} from '../src/payments.mjs';
import {createBankServer} from '../server.mjs';

const {values}=parseArgs({options:{'website-repo':{type:'string'},'output-dir':{type:'string'},help:{type:'boolean'}}});
if(values.help){
 console.log('Usage: node scripts/verify-ip-handler-integration.mjs --website-repo /path/to/genesis-outlook-automation [--output-dir /path/to/evidence]\nThe website path may also be supplied as AVIS_WEBSITE_REPO. Both checkouts must have npm ci installed.');
 process.exit(0);
}
const configuredWebsite=values['website-repo']||process.env.AVIS_WEBSITE_REPO;
if(!configuredWebsite)throw Error('Provide --website-repo or AVIS_WEBSITE_REPO pointing to the local website checkout.');
const websiteRoot=await realpath(resolve(configuredWebsite));
const outputDirectory=values['output-dir']?resolve(values['output-dir']):null;
const websiteImport=relative=>import(pathToFileURL(join(websiteRoot,relative)).href);
const websiteRequire=createRequire(join(websiteRoot,'package.json'));
const [{createIndexSigner},{createCheckoutIpServiceClient},{checkoutIpPayload,activateCheckoutIp},
 {createIpHandlerServiceClient},{createDirectTransferService},{createBankConnector},
 {readTreasury,writeTreasuryAction,verifyTreasuryAudit,treasuryBalance},{getDocument}]=await Promise.all([
 websiteImport('src/press-concentrator/service-auth.mjs'),websiteImport('src/checkout-ip-service.mjs'),
 websiteImport('src/checkout-ip-registration.mjs'),websiteImport('src/ip-handler-service.mjs'),
 websiteImport('src/direct-transfer-service.mjs'),websiteImport('src/avispay-connectors.mjs'),
 websiteImport('src/avispay-treasury.mjs'),import(pathToFileURL(websiteRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
]);
const state=await mkdtemp(join(tmpdir(),'avispay-ip-handler-integration-')),previousStorage=process.env.LOCAL_STORAGE_DIR;
process.env.LOCAL_STORAGE_DIR=join(state,'website');
const admin={id:'integration-admin',username:'integration-admin',admin:true};
const websiteAdmin={authenticated:true,isAdmin:true,profileId:'integration-handler',name:'Integration fixture'};
const sha=value=>createHash('sha256').update(value).digest('hex');
function iban(body){let n=0;for(const c of body+'DE00')for(const d of /[A-Z]/.test(c)?String(c.charCodeAt(0)-55):c)n=(n*10+Number(d))%97;return 'DE'+String(98-n).padStart(2,'0')+body}
const clearingIban=iban('0'.repeat(18)),senderIban=iban('2'.repeat(18)),beneficiaryIban=iban('1'.repeat(18));
const db=new PGlite(),pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release(){}})};
let server;
const checks=[];const check=(label)=>{checks.push(label);console.log('PASS '+label)};
try{
 await migrate(db);
 const common=(await new AccountManagement(pool).openAccount(admin,{accountType:'COMMON',fullName:'Integration collection',currencies:['EUR']},randomUUID())).id;
 const nostro=await new PaymentServer(pool).registerCashAccount(admin,{institutionType:'CORRESPONDENT_BANK',institutionName:'Integration clearing bank',bic:'TESTDE00XXX',accountNumber:clearingIban,currency:'EUR',bankAddress:'Fixture address',accountName:'Integration treasury',reference:'INTEGRATION-NOSTRO'},randomUUID());
 const signer=createIndexSigner({path:join(state,'service.pem')});
 const jwksFetcher=async url=>{assert.equal(String(url),'https://avis.land/press/api/index-service/jwks');return Response.json(await signer.publicKeys())};
 server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,transferOptions:{secretEnv:{},posServiceFetcher:jwksFetcher,ipHandlerServiceFetcher:jwksFetcher}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const wire=[];
 const fetcher=async(url,init)=>{
  assert.equal(url.origin,'https://integration-bank.example.test');
  assert.equal(init.redirect,'error');assert.equal(init.method,'POST');
  const payload=JSON.parse(init.body);wire.push({path:url.pathname,payload,authPrefix:init.headers.authorization.split(' ')[0]});
  return fetch(base+url.pathname,init);
 };
 const env={AVIS_POS_BANK_ORIGIN:'https://integration-bank.example.test'};
 const checkout=createCheckoutIpServiceClient({env,fetcher,signer}),handlerClient=createIpHandlerServiceClient({env,fetcher,signer});
 const record={id:randomUUID(),source:'industrial',reference:'INTEGRATION-MILESTONE',title:'Integration milestone',amount:'10.00',currency:'EUR',bankName:'Integration sender bank',ip:'192.0.2.8',authorized:'Integration operator',account:senderIban,accountName:'Integration sender',documents:[{name:'authority.pdf'}]};
 const payload=checkoutIpPayload(record);assert.equal(payload.source,'industrial');assert.equal(payload.amount,'10.00');
 const requested=await activateCheckoutIp(record,checkout);assert.equal(requested.state,'REQUESTED');
 assert.equal((await checkout.status({requestId:record.id})).status,'REQUESTED');
 assert.equal(wire[0].authPrefix,'Index-JWS');check('Actual website payload, signer and HTTP registration match core contract');
 const coreBefore=(await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows;
 const ledgerBefore=(await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 assert.equal(login.status,200);const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
 const adminPost=async(path,payload)=>fetch(base+path,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json','x-csrf-token':session.csrf},body:JSON.stringify(payload)});
 const approved=await adminPost('/api/checkout-ip/activation',{requestId:record.id,active:true,receivingAccountId:common,nostroCashAccountId:nostro.id});assert.equal(approved.status,200);
 const context=await handlerClient.context({requestId:record.id});assert.equal(context.request.status,'ACTIVE');assert.equal(context.request.amount,'10.000000000000000000');assert.equal(context.routing.nostroIban,clearingIban);
 assert.equal(wire.at(-1).authPrefix,'Ip-JWS');check('Admin approval, dedicated handler signature and exact 18-place context roundtrip');
 let seq=0;const action=(name,input)=>writeTreasuryAction(name,{requestId:'integration-'+ ++seq,...input},websiteAdmin);
 const cash=await action('accounts',{name:'Integration correspondent',type:'common',currency:'EUR'}),counter=await action('accounts',{name:'Integration beneficiary',type:'common',currency:'EUR'});
 const correspondent=await action('correspondents',{accountId:cash.id,bankName:'Integration clearing bank',accountHolder:'Integration treasury',iban:clearingIban,bic:'TESTDE00XXX',role:'nostro',rail:'IP_TO_IP',connectorProfile:'integration-bank'});
 const profile={label:'Integration bank',protocol:'IP_TO_IP',endpoint:'tls://bank.example.test:443',adapterId:'fixture',credentialRef:'keyvault:fixture-only',accountBinding:cash.id,transportVerified:true,certified:true,outboundEnabled:true,messageVersions:['pain.001.001.09']};
 const statement='<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>integration-msg</MsgId><CreDtTm>2026-11-23T00:00:00Z</CreDtTm></GrpHdr><Stmt><Id>integration-statement</Id><CreDtTm>2026-11-23T00:00:00Z</CreDtTm><Acct><Id><IBAN>'+clearingIban+'</IBAN></Id><Ccy>EUR</Ccy></Acct><Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">0.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-11-23</Dt></Dt></Bal><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-11-23</Dt></Dt></Bal><Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-11-23</Dt></BookgDt><AcctSvcrRef>integration-bank-txn</AcctSvcrRef><BkTxCd><Prtry><Cd>TEST</Cd></Prtry></BkTxCd></Ntry></Stmt></BkToCstmrStmt></Document>';
 let statementMessages=[statement];
 const adapter={connect:async()=>({connected:true}),readStatements:async()=>({messages:statementMessages})};
 const connector=createBankConnector({profiles:new Map([['integration-bank',profile]]),adapters:new Map([['fixture',adapter]]),resolveCredential:async()=>Symbol('fixture-only-credential')});
 const handler=createDirectTransferService(connector,{checkout:handlerClient});
 const input={requestId:'integration-draft',checkoutRequestId:record.id,direction:'incoming',correspondentId:correspondent.id,ledgerAccountId:counter.id,amount:context.request.amount,date:'2026-11-23',charges:'SHA',creditorName:'Integration beneficiary',creditorIban:beneficiaryIban,reference:record.reference,senderBankName:record.bankName,senderName:record.accountName,senderIban};
 let transfer=await handler.save(input,websiteAdmin);assert.equal(transfer.amount,'10');
 await handler.publishCheckout(transfer.id);
 let rows=await (await fetch(base+'/api/views/checkoutip',{headers:{cookie}})).json();let row=rows.rows.find(row=>row.requestId===record.id);
 assert.equal(row.processing.transactionReference,transfer.uetr);assert.equal(row.processing.operationCompleted,false);assert.equal(row.processing.proof.available,false);
 check('Real handler saves and publishes draft with 18-place source amount, no proof or core ledger movement');
 const stableUetr=transfer.uetr;
 transfer=await handler.save({...input,requestId:'integration-draft-update',transferId:transfer.id,revision:transfer.revision,uetr:'',bankTransactionId:'integration-bank-txn'},websiteAdmin);
 assert.equal(transfer.uetr,stableUetr);
 await handler.publishCheckout(transfer.id);
 await handler.connect('integration-bank',websiteAdmin);const settled=await handler.settle(transfer.id,websiteAdmin);assert.equal(settled.status,'settled');
 await handler.publishCheckout(transfer.id);assert.equal((await handlerClient.context({requestId:record.id})).request.processing.handlerStatus,'SETTLED');
 await assert.rejects(checkout.cancel({requestId:record.id}),error=>error.code==='CHECKOUT_IP_COMPLETED');
 const websiteAfterSettlement=await readTreasury();assert.equal(websiteAfterSettlement.journals.length,1);assert.equal(treasuryBalance(websiteAfterSettlement,cash.id),1000n);
 check('Authenticated fixture statement settles once; core cancellation preserves settled payment awaiting report');
 const report={franchiseAllocatedPercent:'12.50',manualReport100Digits:'0123456789'.repeat(10)};
 const completed=await handler.processingReport(transfer.id,report,websiteAdmin);assert.equal(completed.register.processing.operationCompleted,true);
 const original=await handler.export(transfer.id,'pdf'),proof=await fetch(base+'/api/checkout-ip/'+record.id+'/proof.pdf',{headers:{cookie}});assert.equal(proof.status,200);
 const downloaded=Buffer.from(await proof.arrayBuffer());assert.deepEqual(downloaded,original);assert.equal(proof.headers.get('x-content-sha256'),sha(original));
 const pdf=await getDocument({data:new Uint8Array(original),isEvalSupported:false,disableFontFace:true,useSystemFonts:true}).promise;
 const text=(await (await pdf.getPage(1)).getTextContent()).items.map(item=>item.str).join('');await pdf.destroy();
 for(const item of ['PROOF OF PAYMENT',record.id,transfer.id,transfer.uetr,'integration-bank-txn',report.manualReport100Digits])assert.ok(text.includes(item),item);
 await handler.processingReport(transfer.id,report,websiteAdmin);assert.deepEqual(await handler.export(transfer.id,'pdf'),original);
 const websiteAfterReport=await readTreasury();assert.deepEqual(websiteAfterReport.journals,websiteAfterSettlement.journals);assert.equal(verifyTreasuryAudit(websiteAfterReport),true);
 check('Original handler PDF stores, downloads, parses and retries byte-for-byte with correct identities and report');
 const closed=await adminPost('/api/checkout-ip/activation',{requestId:record.id,active:false});assert.equal(closed.status,200);
 await handler.publishCheckout(transfer.id);
 await assert.rejects(checkout.register(payload),error=>error.code==='CHECKOUT_IP_COMPLETED');
 await assert.rejects(checkout.cancel({requestId:record.id}),error=>error.code==='CHECKOUT_IP_COMPLETED');
 assert.deepEqual(Buffer.from(await (await fetch(base+'/api/checkout-ip/'+record.id+'/proof.pdf?download=1',{headers:{cookie}})).arrayBuffer()),original);
 check('Completed proof survives closure/restart-style retry and cannot reopen or be cancelled');
 const newLinkedDraft=async(reference,bankTransactionId,service)=>{
  const registration={...record,id:randomUUID(),reference};await activateCheckoutIp(registration,checkout);
  assert.equal((await adminPost('/api/checkout-ip/activation',{requestId:registration.id,active:true,receivingAccountId:common,nostroCashAccountId:nostro.id})).status,200);
  const draft=await service.save({...input,requestId:reference,checkoutRequestId:registration.id,bankTransactionId,reference},websiteAdmin);
  await service.connect('integration-bank',websiteAdmin);return {registration,draft};
 };
 const cancelledDuringClaim=createDirectTransferService(connector,{checkout:{...handlerClient,claim:async payload=>{
  await checkout.cancel({requestId:payload.requestId});return handlerClient.claim(payload);
 }}});
 const cancelledDraft=await newLinkedDraft('INTEGRATION-CANCEL-BEFORE-CLAIM','integration-cancelled-txn',cancelledDuringClaim);
 statementMessages=[statement.replaceAll('integration-bank-txn','integration-cancelled-txn').replaceAll('integration-statement','integration-cancelled-statement')
  .replace('<Amt Ccy="EUR">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt>','<Amt Ccy="EUR">20.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt>')
  .replace('<Amt Ccy="EUR">0.00</Amt>','<Amt Ccy="EUR">10.00</Amt>')];
 const beforeCancelledSettle=await readTreasury();
 await assert.rejects(cancelledDuringClaim.settle(cancelledDraft.draft.id,websiteAdmin),error=>['CHECKOUT_IP_STATE','CHECKOUT_IP_CANCELLED'].includes(error.code));
 assert.deepEqual((await readTreasury()).journals,beforeCancelledSettle.journals);
 assert.equal((await pool.query('SELECT request_id FROM avis_core_v2.checkout_ip_settlement_claims WHERE request_id=$1',[cancelledDraft.registration.id])).rows.length,0);
 check('Real cancellation between statement validation and settlement claim prevents the handler journal');
 const lostClaimResponse=createDirectTransferService(connector,{checkout:{...handlerClient,claim:async payload=>{
  await handlerClient.claim(payload);throw Error('Fixture connection loss after durable settlement claim');
 }}});
 const recovery=await newLinkedDraft('INTEGRATION-CLAIM-RECOVERY','integration-recovery-txn',lostClaimResponse);
 // The first fixture settlement closed at10; the recovered receipt advances20.
 statementMessages=[statement.replaceAll('integration-bank-txn','integration-recovery-txn').replaceAll('integration-statement','integration-recovery-statement')
  .replace('<Amt Ccy="EUR">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt>','<Amt Ccy="EUR">20.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt>')
  .replace('<Amt Ccy="EUR">0.00</Amt>','<Amt Ccy="EUR">10.00</Amt>')];
 const beforeLostResponse=await readTreasury();
 await assert.rejects(lostClaimResponse.settle(recovery.draft.id,websiteAdmin),/Fixture connection loss/);
 assert.deepEqual((await readTreasury()).journals,beforeLostResponse.journals);
 await assert.rejects(checkout.cancel({requestId:recovery.registration.id}),error=>error.code==='CHECKOUT_IP_PROCESSING');
 assert.equal((await adminPost('/api/checkout-ip/activation',{requestId:recovery.registration.id,active:false})).status,200);
 const restartedHandler=createDirectTransferService(connector,{checkout:handlerClient});await restartedHandler.connect('integration-bank',websiteAdmin);
 const recovered=await restartedHandler.settle(recovery.draft.id,websiteAdmin);assert.equal(recovered.status,'settled');
 const recoveredBook=await readTreasury();assert.equal(recoveredBook.journals.length,beforeLostResponse.journals.length+1);
 await restartedHandler.settle(recovery.draft.id,websiteAdmin);assert.deepEqual((await readTreasury()).journals,recoveredBook.journals);
 await restartedHandler.processingReport(recovery.draft.id,report,websiteAdmin);
 assert.equal((await handlerClient.context({requestId:recovery.registration.id})).request.processing.operationCompleted,true);
 check('Claim wins cancellation; response-loss retry completes once after administrator closure');
 const cancelled={...record,id:randomUUID(),reference:'INTEGRATION-CANCEL'};await activateCheckoutIp(cancelled,checkout);
 const once=await checkout.cancel({requestId:cancelled.id}),twice=await checkout.cancel({requestId:cancelled.id});assert.equal(once.status,'CLOSED');assert.deepEqual(twice,once);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.checkout_ip_events WHERE request_id=$1 AND event_type='CLOSE'",[cancelled.id])).rows[0].n,1);
 assert.equal((await checkout.status({requestId:cancelled.id})).status,'CLOSED');
 await assert.rejects(checkout.register(checkoutIpPayload(cancelled)),error=>error.code==='CHECKOUT_IP_CANCELLED');
 const cancelledFirst={...record,id:randomUUID(),reference:'INTEGRATION-CANCEL-BEFORE-REGISTER'};
 const absent=await checkout.cancel({requestId:cancelledFirst.id});assert.equal(absent.cancelled,true);assert.equal(absent.registered,false);
 await assert.rejects(checkout.register(checkoutIpPayload(cancelledFirst)),error=>error.code==='CHECKOUT_IP_CANCELLED');
 assert.deepEqual((await pool.query('SELECT account_id,available_balance::text,locked_balance::text FROM avis_core_v2.ledger_accounts ORDER BY account_id')).rows,coreBefore);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM avis_core_v2.ledger_entries')).rows[0].n,ledgerBefore);
 check('Actual signed cancellation is idempotent and complete cross-repository flow leaves core ledger unchanged');
 const result={passed:checks.length,failed:0,checks,wireCalls:wire.map(({path,authPrefix})=>({path,authPrefix})),
  proof:{bytes:original.length,sha256:sha(original)},coreLedgerEntriesBefore:ledgerBefore,coreLedgerEntriesAfter:ledgerBefore};
 if(outputDirectory){
  await mkdir(outputDirectory,{recursive:true});
  await writeFile(join(outputDirectory,'fixture-handler-proof.pdf'),original);
  await writeFile(join(outputDirectory,'result.json'),JSON.stringify(result,null,2)+'\n');
 }
 console.log(JSON.stringify({passed:checks.length,failed:0,pdfBytes:original.length,pdfSha256:sha(original),...(outputDirectory?{outputDirectory}:{})}));
}finally{
 if(server)await new Promise(resolve=>server.close(resolve));await db.close();
 if(previousStorage===undefined)delete process.env.LOCAL_STORAGE_DIR;else process.env.LOCAL_STORAGE_DIR=previousStorage;
 await rm(state,{recursive:true,force:true});
}
