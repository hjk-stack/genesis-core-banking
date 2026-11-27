import assert from 'node:assert/strict';
import http from 'node:http';
import {createBankServer} from '../../server.mjs';

const normalizeSql=sql=>sql.replace(/\s+/g,' ').trim();
const ipExpiry=normalizeSql(`WITH expired AS(
 UPDATE avis_core_v2.checkout_ip_requests SET status='CLOSED',closed_at=expires_at,updated_at=now()
 WHERE status='REQUESTED' AND expires_at<=now() RETURNING request_id
 ), events AS(
 INSERT INTO avis_core_v2.checkout_ip_events(request_id,event_type,actor_id)
 SELECT request_id,'EXPIRE','system:ip-request-expiry' FROM expired RETURNING event_id)
 SELECT count(*)::int AS count FROM events`);
const posExpiry=normalizeSql(`WITH expired AS (
 UPDATE avis_core_v2.checkout_pos_controls
 SET state='CLOSED',expired_at=requested_at+interval '60 minutes',
 updated_at=now(),changed_by='system:pos-timeout'
 WHERE state='REQUESTED' AND requested_at <= now()-interval '60 minutes'
 AND ($1::varchar IS NULL OR terminal_id=$1)
 RETURNING terminal_id
 ), events AS (
 INSERT INTO avis_core_v2.checkout_pos_events(terminal_id,event_type,actor_id)
 SELECT terminal_id,'EXPIRE','system:pos-timeout' FROM expired
 RETURNING event_id
 ) SELECT count(*)::int AS total FROM events`);

// Exercise the real HTTP server without a database, open connector, or external
// authentication service. Background workers see a closed Fin listener and no
// expired requests; all other database operations remain forbidden.
export async function startStaffAccessFixture() {
 const unexpectedQueries=[],authentications=[],expirySweeps={ip:0,pos:0};
 const pool={async query(sql,parameters){
  if(sql.startsWith('SELECT now() AS now,')&&sql.includes('fin_terminal_listener'))return {rows:[{now:new Date(),open_until:null}]};
  if(sql==='SELECT 1')return {rows:[{'?column?':1}]};
  const normalized=normalizeSql(sql);
  if(normalized===ipExpiry&&parameters===undefined){expirySweeps.ip++;return {rows:[{count:0}]};}
  if(normalized===posExpiry&&Array.isArray(parameters)&&parameters.length===1&&parameters[0]===null){expirySweeps.pos++;return {rows:[{total:0}]};}
  unexpectedQueries.push(sql);
  assert.fail('Unexpected database operation in the access-page fixture');
 }};
 const noNetwork=async()=>assert.fail('Unexpected external service request');
 const server=createBankServer({pool,release:'staff-access-fixture',authenticate:async(username,password)=>{
  authentications.push({username,password});
  return {id:'fineract:1',username,admin:true};
 },transferOptions:{secretEnv:{},cryptoFetch:noNetwork,stripeFetch:noNetwork,indexServiceFetcher:noNetwork,
  posServiceFetcher:noNetwork,ipHandlerServiceFetcher:noNetwork,finListener:{env:{}}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const request=(path='/',{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,agent:false,
   headers:{host:'bank.avispay.online',...headers}},res=>{
   const chunks=[];
   res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
  });
  req.on('error',reject);req.end(body);
 });
 return {request,authentications,expirySweeps,async close(){
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  assert.deepEqual(unexpectedQueries,[],'access checks must not create sessions or financial records');
 }};
}
