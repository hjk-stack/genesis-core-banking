'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {getCapabilities}=require('./src/capabilities');
const {catalog}=require('./src/common-accounts');
const {finTemplates}=require('./src/message-adapters');
const port=Number(process.env.PORT||8080);
const dashboard=path.join(__dirname,'public','dashboard.html');
const workbench=path.join(__dirname,'public','message-workbench.html');
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body))};
 if(req.method!=='GET'&&req.method!=='HEAD')return reply(405,{error:'method_not_allowed'});
 if(pathname==='/healthz')return reply(200,{service:'genesis-core-banking',status:'ok',release:'0.4.0',mode:'diagnostic-only'});
 if(pathname==='/api/capabilities')return reply(200,getCapabilities());
 if(pathname==='/api/common-accounts')return reply(200,catalog());
 if(pathname==='/api/message-templates')return reply(200,{mode:'formatting_and_validation_only',financialPosting:false,templates:finTemplates()});
 if(pathname==='/api/iban-range')return reply(200,{range:'GENESIS-IBAN-BASE',capacity:100000,allocated:0,issued:0,status:'internal_reservation_schema_only',liveBankIdentifiersConfigured:false});
 if(pathname==='/message-workbench'){
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
  return fs.createReadStream(workbench).on('error',()=>res.destroy()).pipe(res);
 }
 if(pathname==='/dashboard'){
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
  return fs.createReadStream(dashboard).on('error',()=>res.destroy()).pipe(res);
 }
 if(pathname==='/')return reply(200,{service:'GENESIS Core Banking',status:'development foundation deployed',mode:'non_transactional',dashboard:'/dashboard',transactionsEnabled:false});
 return reply(404,{error:'not_found'});
});
server.listen(port,'0.0.0.0',()=>console.log('GENESIS development API on '+port));
