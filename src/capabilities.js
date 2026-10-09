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
 ['reconciliation','Financial reconciliation','not_implemented']
];
function getCapabilities(){return {release:'0.4.0',mode:'non_transactional',transactionsEnabled:false,capabilities:modules.map(([id,name,stage])=>({id,name,stage,operations:false}))}}
module.exports={getCapabilities};
