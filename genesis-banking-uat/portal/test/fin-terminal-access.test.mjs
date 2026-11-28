import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrate.mjs';
import {WorkstationAdmission} from '../src/workstation-admission.mjs';
import {FinAccess} from '../src/fin-access.mjs';
import {createBankServer} from '../server.mjs';
import {createFinAccess} from '../public/fin-access.mjs';

// The FinTerminal's access and its 4-Eyes checker (src/fin-access.mjs). The bank owner: "I authorise them at the moment when i
// invite a user in the standard admin", "Only authorised user gets access and these must be named", "4 Eyes is 2 pins ... the pin
// creation must be directly on the GUI for both PINs", and of its switch, "I can. Login se the GUI must sow my name on it".
const admin={id:'fin-access-admin',username:'fin-access',admin:true};
const named=[{name:'Example Owner',owner:true},{name:'Example Officer',owner:false}];
const owner={principal:'admin:owner@example.test',name:'Example Owner',owner:true,finTerminal:true,administrators:named};
const officer={principal:'portal:officer',name:'Example Officer',owner:false,finTerminal:true,administrators:named};
const outsider={principal:'portal:outsider',name:'Example Outsider',owner:false,finTerminal:false,administrators:named};
let pool,db,servers=[],who=owner;
async function bank(options){
 const server=createBankServer({pool,authenticate:async()=>admin,secureCookies:false,...options});servers.push(server);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:'fixture'})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],signedIn=await login.json(),{csrf}=signedIn;
 return Object.assign(async(method,path,body)=>{
  const response=await fetch(base+path,{method,headers:{cookie,origin:base,...(body===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json().catch(()=>({}))};
 },{signedIn});
}
let call;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.pathname,'/avispay_ci');
  pool=new pg.Pool({connectionString:url.href});await pool.query('DROP SCHEMA IF EXISTS avis_core_v2 CASCADE');}
 else{db=new PGlite();let connections=Promise.resolve();pool={query:(...args)=>db.query(...args),connect:async()=>{
  const previous=connections;let release;connections=new Promise(resolve=>{release=resolve});await previous;
  return {query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release};
 }};}
 const connection=await pool.connect();try{await migrate(connection)}finally{connection.release()}
 call=await bank({finTerminalAccess:async()=>who});
});
after(async()=>{for(const server of servers)await new Promise(resolve=>server.close(resolve));if(db)await db.close();else await pool.end();});

test('only an administrator the owner gave FinTerminal access reaches the FinTerminal, by name',async()=>{
 for(const person of [outsider,null]){
  who=person;
  assert.equal((await call('GET','/api/session')).body.finTerminal,false);
  for(const [method,path,body] of [['GET','/api/fin-terminal/access'],['GET','/api/fin-terminal/accounts'],['GET','/api/fin-terminal/telemetry'],
   ['POST','/api/fin-terminal/pins',{slot:1,pin:'123456'}],['POST','/api/fin-terminal/four-eyes',{on:true}],['POST','/api/fin-terminal/mode',{roboticStp:true}]]){
   const answer=await call(method,path,body);
   assert.equal(answer.status,403,path);assert.equal(answer.body.code,'FIN_TERMINAL_ACCESS');assert.equal(answer.body.message,'You are not authorized to access this platform.');
  }
 }
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM avis_core_v2.fin_terminal_pins")).rows[0].n,0);
 assert.equal((await pool.query('SELECT robotic_stp FROM avis_core_v2.fin_terminal_mode')).rows[0].robotic_stp,false);
 who=officer;
 assert.equal((await call('GET','/api/session')).body.finTerminal,true);
 const state=await call('GET','/api/fin-terminal/access');
 assert.equal(state.status,200);
 assert.deepEqual(state.body.you,{name:'Example Officer',owner:false});
 assert.deepEqual(state.body.administrators,named);
 assert.deepEqual(state.body.pins,[{slot:1,holder:null,setAt:null,locked:false},{slot:2,holder:null,setAt:null,locked:false}]);
 assert.deepEqual(state.body.fourEyes,{on:false,by:null,at:null},'it starts off: "Not now for the test period"');
 // The bank's own default: no workstation admission named by avis.land, no FinTerminal - there is no other way in.
 const plain=await bank({});
 assert.equal(plain.signedIn.finTerminal,false);assert.equal((await plain('GET','/api/session')).body.finTerminal,false);
 // The sign-in's own answer says it at once, as the bank's page uses it before asking again (public/app.mjs).
 assert.equal(call.signedIn.finTerminal,true);
 assert.equal((await plain('GET','/api/fin-terminal/access')).status,403);
});

test('PIN 1 and PIN 2 are made in the FinTerminal by their holders, kept only hashed, and changed only with the PIN',async()=>{
 who=owner;
 for(const pin of ['12345','abcdef','1234567890123',123456,'']){
  const answer=await call('POST','/api/fin-terminal/pins',{slot:1,pin});assert.equal(answer.status,422);assert.equal(answer.body.code,'FIN_PIN');
 }
 for(const slot of [3,'1',0,undefined])assert.equal((await call('POST','/api/fin-terminal/pins',{slot,pin:'123456'})).body.field,'slot');
 let state=(await call('POST','/api/fin-terminal/pins',{slot:1,pin:'123456'})).body;
 assert.equal(state.pins[0].holder,'Example Owner');assert.equal(state.pins[1].holder,null);
 who=officer;
 state=(await call('POST','/api/fin-terminal/pins',{slot:2,pin:'65432178'})).body;
 assert.deepEqual(state.pins.map(pin=>pin.holder),['Example Owner','Example Officer']);
 const stored=(await pool.query('SELECT slot,holder_principal,pin_hash FROM avis_core_v2.fin_terminal_pins ORDER BY slot')).rows;
 assert.deepEqual(stored.map(row=>row.holder_principal),['admin:owner@example.test','portal:officer']);
 for(const row of stored){assert.match(row.pin_hash,/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);assert.ok(!/123456|65432178/.test(row.pin_hash));}
 // A PIN made is changed only with it - by whoever knows it, who then holds it.
 assert.equal((await call('POST','/api/fin-terminal/pins',{slot:1,pin:'111111'})).body.field,'currentPin');
 for(let wrong=1;wrong<5;wrong++){
  const answer=await call('POST','/api/fin-terminal/pins',{slot:1,pin:'111111',currentPin:'999999'});
  assert.equal(answer.status,422);assert.equal(answer.body.code,'FIN_PIN_WRONG');
 }
 const fifth=await call('POST','/api/fin-terminal/pins',{slot:1,pin:'111111',currentPin:'999999'});
 assert.equal(fifth.status,423);assert.equal(fifth.body.code,'FIN_PIN_LOCKED');
 assert.equal((await call('POST','/api/fin-terminal/pins',{slot:1,pin:'111111',currentPin:'123456'})).body.code,'FIN_PIN_LOCKED','even the right PIN waits');
 assert.equal((await call('GET','/api/fin-terminal/access')).body.pins[0].locked,true);
 // 15 minutes on.
 await pool.query("UPDATE avis_core_v2.fin_terminal_pins SET locked_until=now()-interval '1 second' WHERE slot=1");
 state=(await call('POST','/api/fin-terminal/pins',{slot:1,pin:'111111',currentPin:'123456'})).body;
 assert.equal(state.pins[0].holder,'Example Officer');assert.equal(state.pins[0].locked,false);
 assert.deepEqual((await pool.query('SELECT failed_attempts,locked_until FROM avis_core_v2.fin_terminal_pins WHERE slot=1')).rows[0],{failed_attempts:0,locked_until:null});
 assert.equal((await call('POST','/api/fin-terminal/pins',{slot:1,pin:'222222',currentPin:'123456'})).body.code,'FIN_PIN_WRONG','the old PIN is gone');
 const audit=(await pool.query("SELECT operation,resource_id FROM avis_core_v2.operation_audit WHERE operation LIKE 'FIN_PIN%' ORDER BY audit_id")).rows;
 assert.deepEqual(audit,[{operation:'FIN_PIN_CREATED',resource_id:'PIN 1'},{operation:'FIN_PIN_CREATED',resource_id:'PIN 2'},{operation:'FIN_PIN_CHANGED',resource_id:'PIN 1'}]);
});

test('4-Eyes starts off and only the owner switches it, the switch showing the owner\'s name',async()=>{
 who=officer;
 const refused=await call('POST','/api/fin-terminal/four-eyes',{on:true});
 assert.equal(refused.status,403);assert.equal(refused.body.code,'FIN_FOUR_EYES');
 assert.equal((await call('GET','/api/fin-terminal/access')).body.fourEyes.on,false);
 who=owner;
 for(const on of ['true',1,null,undefined])assert.equal((await call('POST','/api/fin-terminal/four-eyes',{on})).body.field,'on');
 let state=(await call('POST','/api/fin-terminal/four-eyes',{on:true})).body;
 assert.equal(state.fourEyes.on,true);assert.equal(state.fourEyes.by,'Example Owner');assert.ok(Date.parse(state.fourEyes.at));
 assert.deepEqual(state.you,{name:'Example Owner',owner:true});
 state=(await call('POST','/api/fin-terminal/four-eyes',{on:false})).body;
 assert.equal(state.fourEyes.on,false);
 assert.deepEqual((await pool.query("SELECT operation FROM avis_core_v2.operation_audit WHERE operation LIKE 'FIN_FOUR_EYES%' ORDER BY audit_id")).rows.map(row=>row.operation),['FIN_FOUR_EYES_ON','FIN_FOUR_EYES_OFF']);
});

// Review finding: the switch and its audit line go together - a switch that cannot be audited does not switch.
test('a 4-Eyes switch that cannot be audited does not switch',async()=>{
 const refuseAudit=query=>(text,...rest)=>/operation_audit/.test(String(text))?Promise.reject(new Error('audit refused')):query(text,...rest);
 const failing={query:refuseAudit((...args)=>pool.query(...args)),connect:async()=>{const client=await pool.connect();return {...client,query:refuseAudit((...args)=>client.query(...args))};}};
 const before=(await new FinAccess(pool).state(owner)).fourEyes;
 await assert.rejects(new FinAccess(failing).fourEyes(admin,owner,{on:!before.on}),/audit refused/);
 assert.deepEqual((await new FinAccess(pool).state(owner)).fourEyes,before);
});

test('avis.land\'s admission answer names the administrator and their FinTerminal access; anything else is dropped',async()=>{
 const grant={principal:'portal:officer',deviceId:'device-example',approvalId:randomUUID(),generation:randomUUID(),expiresAt:new Date(Date.now()+600000).toISOString(),statusCapability:'example.capability'};
 const answering=body=>new WorkstationAdmission(pool,{fetcher:async()=>({ok:true,redirected:false,headers:{get:()=>null},body:[Buffer.from(JSON.stringify(body))]})});
 const status={active:true,principal:grant.principal,deviceId:grant.deviceId,approvalId:grant.approvalId,generation:grant.generation,expiresAt:grant.expiresAt};
 assert.deepEqual(await answering({...status,name:'Example Officer',owner:false,finTerminal:true,
  finTerminalAdministrators:[{name:'Example Owner',owner:true},{name:'Example Officer'},{name:'bell\u0007'},{name:'x'.repeat(81)},'Example',{owner:true}]}).active(grant),
  {principal:'portal:officer',name:'Example Officer',owner:false,finTerminal:true,administrators:[{name:'Example Owner',owner:true},{name:'Example Officer',owner:false}]});
 // An answer from an avis.land without FinTerminal access, or without a name, opens no FinTerminal.
 assert.equal((await answering(status).active(grant)).finTerminal,false);
 assert.equal((await answering({...status,finTerminal:true}).active(grant)).finTerminal,false);
 assert.equal((await answering({...status,finTerminal:'true',name:'Example Officer'}).active(grant)).finTerminal,false);
 // Only spaces are no name (review finding); spaces around a name are not kept.
 for(const name of ['   ','\u00a0\t '])assert.equal((await answering({...status,finTerminal:true,name}).active(grant)).finTerminal,false);
 assert.deepEqual(await answering({...status,finTerminal:true,name:'  Example Officer ',finTerminalAdministrators:[{name:'  '},{name:' Example Owner ',owner:true}]}).active(grant),
  {principal:'portal:officer',name:'Example Officer',owner:false,finTerminal:true,administrators:[{name:'Example Owner',owner:true}]});
 await assert.rejects(new FinAccess(pool).state({...officer,name:'  '}),e=>e.code==='FIN_TERMINAL_ACCESS');
 await assert.rejects(answering({...status,active:false,finTerminal:true,name:'Example Officer'}).active(grant),e=>e.code==='BANK_WORKSTATION_REQUIRED');
});

test('the terminal\'s Access & 4-Eyes: the names, each PIN with its holder, the switch for the owner alone',async()=>{
 const html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://bank.example/fin-terminal'}),doc=dom.window.document,asked=[];
 let state={you:{name:'Example Officer',owner:false},administrators:[{name:'Example Officer',owner:false},{name:'Example Owner',owner:true}],
  fourEyes:{on:false,by:null,at:null},pins:[{slot:1,holder:'Example Owner',setAt:'2026-11-27T22:00:00.000Z',locked:false},{slot:2,holder:null,setAt:null,locked:false}]};
 const request=async(method,path,body)=>{asked.push([method,path,body]);return state;};
 const access=createFinAccess({root:doc,request,view:{setInterval(){}}});
 assert.equal(doc.querySelector('[data-fin-access]').hidden,true,'nothing before the bank answers');
 await access.refresh();
 assert.equal(doc.querySelector('[data-fin-access]').hidden,false);
 assert.equal(doc.querySelector('[data-fin-access-names]').textContent,'Example Owner · Example Officer','the owner first');
 const fourEyes=doc.querySelector('[data-fin-four-eyes]');
 assert.equal(fourEyes.textContent,'4-EYES: OFF · Example Owner');assert.equal(fourEyes.disabled,true,'not the owner');
 const [first,second]=doc.querySelectorAll('form[data-fin-pin]');
 assert.equal(first.querySelector('.fin-pin-holder').textContent,'PIN 1 · Example Owner');
 assert.deepEqual([...first.querySelectorAll('input')].map(input=>[input.type,input.getAttribute('aria-label')]),[['password','Current PIN 1'],['password','New PIN 1']]);
 assert.equal(first.querySelector('button').textContent,'Change PIN');
 assert.equal(second.querySelector('.fin-pin-holder').textContent,'PIN 2 · —');
 assert.deepEqual([...second.querySelectorAll('input')].map(input=>input.getAttribute('aria-label')),['PIN 2']);
 assert.equal(second.querySelector('button').textContent,'Create PIN');
 // A PIN made here goes to the bank and leaves its field at once.
 second.querySelector('[data-pin]').value='24681357';
 state={...state,pins:[state.pins[0],{slot:2,holder:'Example Officer',setAt:'2026-11-27T22:05:00.000Z',locked:false}]};
 second.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
 assert.equal(second.querySelector('[data-pin]').value,'');
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(asked.at(-1),['POST','/api/fin-terminal/pins',{slot:2,pin:'24681357'}]);
 assert.equal(doc.querySelectorAll('form[data-fin-pin]')[1].querySelector('.fin-pin-holder').textContent,'PIN 2 · Example Officer');
 const firstAgain=doc.querySelectorAll('form[data-fin-pin]')[0];
 firstAgain.querySelector('[data-current]').value='13572468';firstAgain.querySelector('[data-pin]').value='97531864';
 firstAgain.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(asked.at(-1),['POST','/api/fin-terminal/pins',{slot:1,pin:'97531864',currentPin:'13572468'}]);
 // The owner works the switch; it shows who switched it.
 state={...state,you:{name:'Example Owner',owner:true}};await access.refresh();
 assert.equal(fourEyes.disabled,false);
 state={...state,fourEyes:{on:true,by:'Example Owner',at:'2026-11-27T22:10:00.000Z'}};
 fourEyes.click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(asked.at(-1),['POST','/api/fin-terminal/four-eyes',{on:true}]);
 assert.equal(fourEyes.textContent,'4-EYES: ON · Example Owner');assert.equal(fourEyes.dataset.state,'ON');assert.equal(fourEyes.getAttribute('aria-pressed'),'true');
 // A refusal is shown where it belongs.
 const refusing=createFinAccess({root:doc,request:async(method)=>{if(method==='POST')throw new Error('Only the super administrator switches 4-Eyes on or off.');return state;},view:{setInterval(){}}});
 await refusing.refresh();fourEyes.click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(doc.querySelector('[data-fin-access-problem]').textContent,'Only the super administrator switches 4-Eyes on or off.');
 dom.window.close();
});

// The bank owner: "the header referencing PIN make it in a klap menu, with default closed".
test('the PINs fold out of their menu: closed when the terminal opens, opened and closed again by it',async()=>{
 const html=await readFile(new URL('../public/fin-terminal.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://bank.example/fin-terminal'}),doc=dom.window.document;
 const state={you:{name:'Example Owner',owner:true},administrators:[{name:'Example Owner',owner:true}],fourEyes:{on:false,by:null,at:null},
  pins:[{slot:1,holder:'Example Owner',setAt:'2026-11-27T22:00:00.000Z',locked:false},{slot:2,holder:null,setAt:null,locked:false}]};
 const access=createFinAccess({root:doc,request:async()=>state,view:{setInterval(){}}});
 await access.refresh();
 const open=doc.querySelector('[data-fin-pins-open]'),pins=doc.querySelector('[data-fin-pins]');
 assert.equal(open.textContent,'PIN');assert.equal(open.getAttribute('aria-controls'),pins.id);
 assert.equal(open.getAttribute('aria-expanded'),'false');assert.equal(pins.hidden,true,'closed when the terminal opens');
 assert.equal(pins.querySelectorAll('form[data-fin-pin]').length,2,'both PINs are in the menu');
 open.click();
 assert.equal(open.getAttribute('aria-expanded'),'true');assert.equal(pins.hidden,false);
 await access.refresh();assert.equal(pins.hidden,false,'open while the bank is read again');
 open.click();
 assert.equal(open.getAttribute('aria-expanded'),'false');assert.equal(pins.hidden,true);
 dom.window.close();
});
