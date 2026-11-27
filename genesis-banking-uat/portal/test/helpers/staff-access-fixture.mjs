import assert from 'node:assert/strict';
import http from 'node:http';
import {createBankServer} from '../../server.mjs';

// Exercise the real HTTP server without a database, open connector, or external
// authentication service. The only background read sees a closed Fin listener.
export async function startStaffAccessFixture() {
 const unexpectedQueries=[],authentications=[];
 const pool={async query(sql){
  if(sql.startsWith('SELECT now() AS now,')&&sql.includes('fin_terminal_listener'))return {rows:[{now:new Date(),open_until:null}]};
  if(sql==='SELECT 1')return {rows:[{'?column?':1}]};
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
 return {request,authentications,async close(){
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  assert.deepEqual(unexpectedQueries,[],'access checks must not create sessions or financial records');
 }};
}
