'use strict';
const modules=[
 ['customers','Customer accounts','foundation'],
 ['ledger','Double-entry ledger','foundation'],
 ['payments','Payment instructions','draft_only'],
 ['wallets','Banking wallets','foundation'],
 ['custody','Custodial accounts','draft_only'],
 ['stocks','Stocks and bonds','draft_only'],
 ['derivatives','Derivative trading','draft_only'],
 ['exchanges','Stock exchange connectors','disabled'],
 ['crypto','Crypto and smart contracts','draft_only'],
 ['cards','Card issuance','draft_only'],
 ['acquiring','Merchant acquiring','draft_only'],
 ['reconciliation','Financial reconciliation','not_implemented'],
 ['common_accounts','COMMON account warehouse (20 templates)','schema_only'],
 ['suspense','Suspense accounts (120 templates)','schema_only'],
 ['correspondents','Global correspondent interfaces','disabled'],
 ['swift_iso','FIN MT103/MT202 COV and ISO 20022 adapters','validation_only'],
 ['iban_pool','100,000 internal account-number slots','migration_required']
];
function getCapabilities(){return {release:'0.5.0',mode:'non_transactional',transactionsEnabled:false,capabilities:modules.map(([id,name,stage])=>({id,name,stage,operations:false}))}}
module.exports={getCapabilities};
