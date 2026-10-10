'use strict';

// Institutional omnibus COMMON accounts: registered client/third-party interests.
// Nothing in this catalog asserts proprietary bank ownership or an available balance.
const PRODUCTS = Object.freeze([
 ['FIAT_CASH','Cash and safeguarded funds'],
 ['BANK_DEPOSITS','Deposits and bank cash claims'],
 ['BONDS_NOTES','Bonds, notes and debt securities'],
 ['EQUITIES','Shares and equity securities'],
 ['INVESTMENT_FUNDS','Fund units and investment vehicles'],
 ['MONEY_MARKET','Money market instruments'],
 ['FOREIGN_EXCHANGE','Foreign exchange claims and settlements'],
 ['CRYPTO_ASSETS','Cryptocurrency custody positions'],
 ['TOKENIZED_ASSETS','Tokenized financial assets'],
 ['STABLECOINS','Stablecoin custody positions'],
 ['DERIVATIVES','Derivatives and margin interests'],
 ['PRECIOUS_METALS','Allocated and unallocated metal interests'],
 ['COMMODITIES','Commodity warehouse interests'],
 ['PHYSICAL_ASSETS','Documented valuables and physical assets'],
 ['COLLATERAL','Pledged and security-held collateral'],
 ['TRADE_FINANCE','Trade finance instruments'],
 ['CARD_SETTLEMENT','Card and merchant settlement proceeds'],
 ['PAYMENT_CLEARING','Customer payment clearing'],
 ['CORRESPONDENT_TRANSIT','Correspondent cover and settlement transit'],
 ['OTHER_CUSTODY','Other custody and deposit products']
].map(([code,name],index)=>Object.freeze({code,name,ordinal:index+1,commonAccountCode:'COM-'+String(index+1).padStart(4,'0'),status:'configured_disabled',ownership:'client_or_third_party_omnibus'})));
const SUSPENSE_PURPOSES = Object.freeze([
 ['UNMATCHED_BENEFICIARY','Beneficiary not positively identified'],
 ['SETTLEMENT_UNCONFIRMED','Correspondent settlement not reconciled'],
 ['COVER_UNMATCHED','Cover leg awaiting matched customer payment'],
 ['CORRESPONDENT_BREAK','External account reconciliation difference'],
 ['COMPLIANCE_HOLD','Sanctions, screening or compliance hold'],
 ['RETURN_REPAIR','Unresolved return, rejection or repair']
].map(([code,name],index)=>Object.freeze({code,name,ordinal:index+1})));
const COMMON_ACCOUNTS=Object.freeze(PRODUCTS.map(x=>Object.freeze({
  code:x.commonAccountCode,productCode:x.code,name:x.name,status:x.status,ownership:x.ownership
})));
const SUSPENSE_ACCOUNTS=Object.freeze(PRODUCTS.flatMap(p=>SUSPENSE_PURPOSES.map(s=>Object.freeze({
  code:'SUS-'+String(p.ordinal).padStart(4,'0')+'-'+String(s.ordinal).padStart(2,'0'),
  commonAccountCode:p.commonAccountCode,productCode:p.code,purposeCode:s.code,
  status:'configured_disabled'
}))));
const PAYMENT_RAILS=Object.freeze([
 {code:'SWIFT_FIN',role:'messaging',status:'disabled'},
 {code:'SWIFT_MX',role:'messaging',status:'disabled'},
 {code:'SEPA_CT',role:'clearing_settlement',status:'disabled'},
 {code:'SEPA_INST',role:'clearing_settlement',status:'disabled'},
 {code:'RTGS',role:'clearing_settlement',status:'disabled'},
 {code:'ACH',role:'clearing_settlement',status:'disabled'},
 {code:'RTP',role:'clearing_settlement',status:'disabled'},
 {code:'FASTER_PAYMENTS',role:'clearing_settlement',status:'disabled'},
 {code:'CORRESPONDENT_API',role:'statement_and_reconciliation',status:'disabled'},
 {code:'CUSTODY_API',role:'custody_statement',status:'disabled'}
].map(Object.freeze));
function catalog(){
 return {
  model:'omnibus_common_ledger',mode:'schema_stage_not_bookable',
  commonAccounts:COMMON_ACCOUNTS,suspenseAccounts:SUSPENSE_ACCOUNTS,
  suspensePurposes:SUSPENSE_PURPOSES,paymentRails:PAYMENT_RAILS,
  ibanPool:{code:'GENESIS-IBAN-BASE',slots:100000,firstSerial:0,lastSerial:99999,
    issuedIbans:0,status:'internal_reserved',countryAndBankIdentifierConfigured:false},
  allocationPolicy:{initialState:'unallocated',beneficialOwnerMustBeVerified:true,
    correspondentSettlementRequired:true,coverLegMustNotBeCreditedTwice:true,
    livePaymentsEnabled:false}
 };
}
function findCommonByProduct(productCode){
 return COMMON_ACCOUNTS.find(a=>a.productCode===productCode)||null;
}
function findSuspense(productCode,purposeCode){
 return SUSPENSE_ACCOUNTS.find(a=>a.productCode===productCode&&a.purposeCode===purposeCode)||null;
}
module.exports={PRODUCTS,SUSPENSE_PURPOSES,COMMON_ACCOUNTS,SUSPENSE_ACCOUNTS,PAYMENT_RAILS,catalog,findCommonByProduct,findSuspense};
