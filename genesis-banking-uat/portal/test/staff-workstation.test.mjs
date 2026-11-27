import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { isStaffHost, workstationFingerprint, contactIncubator } from '../src/staff-workstation.mjs';

test('the dedicated bank hostname is exact and its server channel fails closed', async () => {
 assert.ok(isStaffHost({headers:{host:'BANK.AVISPAY.ONLINE:443'}}));
 assert.equal(isStaffHost({headers:{host:'avispay.online'}}), false);
 await assert.rejects(contactIncubator('admit',{}, {},()=>assert.fail('unexpected network request')));
});

test('the approved certificate fingerprint is the same at the TLS socket and trusted Azure ingress', () => {
 const root=mkdtempSync(join(tmpdir(),'bank-test-cert-'));
 try {
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=synthetic-test-device','-keyout',join(root,'key'),'-out',join(root,'cert')],{stdio:'ignore'});
  const pem=readFileSync(join(root,'cert'),'utf8'), cert=new X509Certificate(pem);
  const fp=cert.fingerprint256.replaceAll(':','').toLowerCase();
  assert.equal(workstationFingerprint({headers:{},socket:{authorized:true,getPeerCertificate:()=>({raw:cert.raw})}},{}),fp);
  const req={socket:{},headers:{'x-forwarded-client-cert':'Hash='+fp+';Cert="'+encodeURIComponent(pem)+'";'}};
  assert.throws(()=>workstationFingerprint(req,{}));
  const ingress={BANK_DESK_MTLS_INGRESS:'azure-container-apps'};
  assert.equal(workstationFingerprint(req,ingress),fp);
  assert.throws(()=>workstationFingerprint(req,ingress,Date.parse(cert.validTo)+1000));
  assert.throws(()=>workstationFingerprint({socket:{},headers:{}},ingress));
 } finally { rmSync(root,{recursive:true,force:true}); }
});
