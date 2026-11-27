import { X509Certificate } from "node:crypto";

export const staffHost = "bank.avispay.online";
const fpPattern = /^[0-9a-f]{64}$/;
export const isStaffHost = req => [staffHost, staffHost + ":443"].includes(String(req.headers.host || "").toLowerCase());
const blocked = () => Object.assign(new Error("BANK_WORKSTATION_REQUIRED"),{code:"BANK_WORKSTATION_REQUIRED",status:403});

export function workstationFingerprint(req, env=process.env, now=Date.now()) {
  // ACA rewrites XFCC only when client certificates are enabled. The private deployment
  // selects this mode only behind that ingress; direct HTTPS uses the verified socket peer.
  let cert;
  try {
    if (req.socket?.authorized && req.socket.getPeerCertificate) {
      cert = new X509Certificate(req.socket.getPeerCertificate().raw);
    } else if (env.BANK_DESK_MTLS_INGRESS === "azure-container-apps") {
      const xfcc = req.headers["x-forwarded-client-cert"];
      if (typeof xfcc !== "string" || xfcc.length > 65536) throw blocked();
      const fields = xfcc.split(";").map(s => s.trim());
      const hashes = fields.filter(v=>/^Hash=/i.test(v)), certificates=fields.filter(v=>/^Cert=/i.test(v));
      if (hashes.length !== 1 || certificates.length !== 1) throw blocked();
      const fingerprint = hashes[0].slice(5).toLowerCase();
      if(!fpPattern.test(fingerprint)) throw blocked();
      const pem=decodeURIComponent(certificates[0].slice(5).replace(/^"|"$/g,""));
      cert=new X509Certificate(pem);
      if (cert.fingerprint256.replaceAll(":","").toLowerCase() !== fingerprint) throw blocked();
    } else throw blocked();
    if (!(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo))) throw blocked();
    return cert.fingerprint256.replaceAll(":","").toLowerCase();
  } catch { throw blocked(); }
}

export async function contactIncubator(action, input, env=process.env, fetcher=fetch) {
  const secret=env.BANK_DESK_CHANNEL_SECRET || "";
  if (Buffer.byteLength(secret) < 32) throw blocked();
  const receipt=await fetcher("https://avis.land/bank/workstation-channel/" + action, {
    method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),
    headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify(input)
  });
  if(!receipt.ok) throw blocked();
  return receipt.json();
}
