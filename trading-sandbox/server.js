'use strict';
const http=require('node:http');
const {createEngine}=require('./engine');
const fs=require('node:fs'),path=require('node:path');
const engine=createEngine(),host='127.0.0.1',port=Number(process.env.PORT||8091);
const known=new Set(['INVALID_ORDER','INVALID_CLIENT_ORDER_ID','IDEMPOTENCY_CONFLICT','INSTRUMENT_NOT_ALLOWED','INVALID_SIDE','INVALID_QUANTITY','INVALID_LIMIT_PRICE','RISK_NOTIONAL_LIMIT','INSUFFICIENT_SIMULATED_CASH','NO_SHORT_SELLING','ORDER_NOT_FOUND','ORDER_NOT_CANCELLABLE']);
function respond(res,code,body){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))}
function read(req){return new Promise((resolve,reject)=>{let body='',size=0;req.on('data',v=>{size+=v.length;if(size>4096){reject(Error('TOO_LARGE'));req.destroy();return}body+=v});req.on('end',()=>{try{resolve(JSON.parse(body))}catch{reject(Error('INVALID_JSON'))}});req.on('error',reject)})}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');
if(req.method==='GET'&&url.pathname==='/healthz')return respond(res,200,{service:'genesis-trading-sandbox',mode:'PAPER_ONLY',status:'ok'});
if(req.method==='GET'&&url.pathname==='/api/state')return respond(res,200,engine.snapshot());
if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});return fs.createReadStream(path.join(__dirname,'public','index.html')).pipe(res)}
if(req.method==='POST'&&url.pathname==='/api/orders'){try{return respond(res,201,engine.submit(await read(req)))}catch(e){return respond(res,400,{error:known.has(e.message)?e.message:'INVALID_INPUT'})}}
if(req.method==='POST'&&url.pathname==='/api/cancel'){try{const input=await read(req);return respond(res,200,engine.cancel(input.clientOrderId))}catch(e){return respond(res,400,{error:known.has(e.message)?e.message:'INVALID_INPUT'})}}
return respond(res,404,{error:'NOT_FOUND'});
});
if(require.main===module)server.listen(port,host,()=>console.log('GENESIS Paper Trading: http://'+host+':'+port));
module.exports={server};