// Standalone, side-effect-free mapping and reconciliation planning.
// No storage writes, customer-account edits, gateway calls or payment submissions.
const fail = message => { throw new TypeError(message); };
const CURRENCY = /^[A-Z]{3}$/;
const BIC = /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const IBAN_LENGTHS = Object.freeze({AE:23,SA:24,QA:29,BH:22,JO:30,KW:30,PK:24,BR:29,IL:23,AL:28,BA:20,GE:22,MD:24,ME:22,MK:19,RS:22,XK:20,SC:31,LC:32,ST:25,TL:23,TN:24,DO:28,CR:22,GT:28,VA:22,MU:30,MR:27,SV:28,AZ:28,BY:28,KZ:20,IQ:23,PS:29,EG:29,AT:20,BE:16,BG:22,CH:21,CY:28,CZ:24,DE:22,DK:18,EE:20,ES:24,FI:18,FR:27,GB:22,GR:27,HR:21,HU:28,IE:22,IS:26,IT:27,LI:21,LT:20,LU:20,LV:21,MC:27,MT:31,NL:18,NO:15,PL:28,PT:25,RO:24,SE:24,SI:19,SK:24,SM:27,TR:26,UA:29});
const plain = (value,max=140) => {
 if(typeof value!=="string" || !value.trim() || value.trim().length>max) fail("Required text field is invalid");
 return value.trim();
};
export function normalizeIban(value) {
 if(typeof value!=="string") fail("IBAN must be text");
 const iban=value.replace(/\s+/g,"").toUpperCase();
 if(!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) || iban.length>34) fail("IBAN format invalid");
 const expected=IBAN_LENGTHS[iban.slice(0,2)];
 if(!expected) fail("Unsupported IBAN country");
 if(iban.length!==expected) fail("IBAN country length invalid");
 let remainder=0;
 for(const c of iban.slice(4)+iban.slice(0,4)){
  const token=c>="A"&&c<="Z"?String(c.charCodeAt(0)-55):c;
  for(const digit of token) remainder=(remainder*10+Number(digit))%97;
 }
 if(remainder!==1) fail("IBAN check digits invalid");
 return iban;
}
export function prepareCorrespondent(input) {
 if(!input || typeof input!=="object" || Array.isArray(input)) fail("Correspondent data required");
 const bic=plain(input.bic,11).toUpperCase();
 if(!BIC.test(bic)) fail("BIC format invalid");
 const currency=plain(input.currency,3).toUpperCase();
 if(!CURRENCY.test(currency)) fail("ISO currency code invalid");
 const rail=plain(input.rail,20).toUpperCase();
 if(!["SEPA","SWIFT","RTGS","LOCAL"].includes(rail)) fail("Unknown rail");
 const iban=normalizeIban(input.iban);
 const accountId=plain(input.internalAccountRef,100);
 const bank=plain(input.bankName,140);
 const owner=plain(input.accountHolder,140);
 const externalId=plain(input.id,100);
 const routeId=plain(input.routeId,100);
 return Object.freeze({id:externalId,bankName:bank,accountHolder:owner,iban,bic,currency,rail,
  internalAccountRef:accountId,routeId,role:input.role==="nostro"?"nostro":input.role==="vostro"?"vostro":fail("Account role must be nostro or vostro"),
  status:"proposed", outboundEnabled:false, inboundEnabled:false});
}
export function prepareExternalBeneficiary(input) {
 if(!input || typeof input!=="object") fail("Beneficiary data required");
 const bic=input.bic?plain(input.bic,11).toUpperCase():null;
 if(bic&&!BIC.test(bic)) fail("BIC format invalid");
 return Object.freeze({id:plain(input.id,100),name:plain(input.name,140),iban:normalizeIban(input.iban),bic});
}
export function validateCurrencyMappings(correspondents) {
 if(!Array.isArray(correspondents)) fail("Correspondent mappings required");
 const keys=new Set(),ids=new Set();
 for(const record of correspondents){
  if(!record || record.status!=="proposed" || record.outboundEnabled!==false || record.inboundEnabled!==false) fail("Unreviewed mapping cannot enable payment directions");
  if(ids.has(record.id)) fail("Duplicate correspondent identifier");
  ids.add(record.id);
  const key=[record.internalAccountRef,record.currency,record.rail,record.role].join("|");
  if(keys.has(key)) fail("Conflicting account/currency/rail/role mapping");
  keys.add(key);
 }
 return Object.freeze({count:correspondents.length,currencies:[...new Set(correspondents.map(r=>r.currency))].sort(),outboundEnabled:false});
}
// Statement matching is observational only: never creates journals or modifies balances.
export function compareStatementEntries(ledgerEntries, statementEntries, { ledgerUnit="decimal", statementUnit="decimal" } = {}) {
 if(!Array.isArray(ledgerEntries)||!Array.isArray(statementEntries)) fail("Statement and ledger entries required");
 const key=(x,unit)=>{const raw=plain(x.amount,40);if(!["decimal","minor"].includes(unit)||!(unit==="minor"?/^-?\d+$/:/^-?\d+(?:\.\d{1,2})?$/).test(raw))fail("Invalid reconciliation amount/unit");const negative=raw.startsWith("-"),[whole,fraction=""]=raw.replace(/^-/,"").split(".");const amount=unit==="minor"?BigInt(raw):(negative?-1n:1n)*(BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0")));return [plain(x.reference,140),plain(x.currency,3).toUpperCase(),amount.toString()].join("|")};
 const pool=new Map();
 for(const row of ledgerEntries){const k=key(row,ledgerUnit);pool.set(k,(pool.get(k)||0)+1)}
 const matched=[],unmatched=[];
 for(const row of statementEntries){const k=key(row,statementUnit),count=pool.get(k)||0;if(count){pool.set(k,count-1);matched.push(row)}else unmatched.push(row)}
 const remaining=[...pool.values()].reduce((a,b)=>a+b,0);
 return Object.freeze({matchedCount:matched.length,unmatchedStatementCount:unmatched.length,unmatchedLedgerCount:remaining,
  balanced:unmatched.length===0&&remaining===0});
}
export function preparePain001Instruction({debtor,creditor,currency,amount,reference,endToEndId}) {
 // Data contract only: not XML, payment signing, or bank submission.
 if(!debtor?.iban||!creditor?.iban) fail("Accounts required");
 const c=plain(currency,3).toUpperCase();
 if(!CURRENCY.test(c)||c!==debtor.currency) fail("No mapped funding currency");
 if(typeof amount!=="string"||!/^[1-9][0-9]{0,12}(?:\.[0-9]{1,2})?$|^0\.[0-9]{1,2}$/.test(amount)||Number(amount)<=0) fail("Invalid amount");
 if(debtor.outboundEnabled!==false) fail("Preview must not activate payments");
 return Object.freeze({messageType:"pain.001",debtorIban:normalizeIban(debtor.iban),creditorIban:normalizeIban(creditor.iban),
  currency:c,amount,reference:plain(reference,140),endToEndId:plain(endToEndId,35),submissionAllowed:false});
}

