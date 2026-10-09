'use strict';
const http = require('node:http');
const { Client } = require('pg');
const host = process.env.PGHOST;
const port = Number(process.env.PORT || 8080);
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
    res.end(JSON.stringify(body));
  };
  if (path === '/healthz') return reply(200, {service:'genesis-core-banking', status:'ok', release:'0.1.0', mode:'diagnostic-only'});
  if (path !== '/') return reply(404, { error:'not_found' });
  return reply(200, {service:'GENESIS Core Banking', status:'foundation deployed', mode:'diagnostic-only', customerAccounts:false, paymentsEnabled:false, databaseConnectionConfigured: Boolean(host && process.env.PGUSER && process.env.PGPASSWORD)});
});
server.listen(port, '0.0.0.0', () => console.log(`GENESIS diagnostic API on ${port}`));
