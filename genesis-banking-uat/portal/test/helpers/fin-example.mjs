import {blankForm} from '../../public/fin-message.mjs';

// The FinTerminal tests' example transfer: banks and accounts that do not exist, with their check digits computed here.
const mod97=text=>[...text].reduce((rest,c)=>Number(String(rest)+(/[A-Z]/.test(c)?String(c.charCodeAt(0)-55):c))%97,0);
export const exampleIban=(country,bban)=>country+String(98-mod97(bban+country+'00')).padStart(2,'0')+bban;
export const exampleForm=()=>({...blankForm(new Date('2026-11-27T09:00:00Z')),uetr:'9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
 senderBic:'EXMPDEFFXXX',receiverBic:'SMPLFRPPXXX',amount:'1250000.00',valueDate:'2026-11-27',
 debtorName:'Example Debtor GmbH',debtorIban:exampleIban('DE','000000000001234567'),debtorAgentBic:'EXMPDEFFXXX',
 creditorName:'Example Creditor SARL',creditorIban:exampleIban('FR','00000000000000000000123'),creditorAgentBic:'SMPLFRPPXXX',
 intermediaryBic:'INTMGB2LXXX',intermediaryAddress:'1 Example Street, Example City EX1 1AA, United Kingdom',ultimateDebtorName:'Example Holding AG',
 ultimateDebtorAddress:'Examplestrasse 2, 8000 Example Town, Switzerland',ultimateCreditorName:'Example Supplier Group',
 ultimateCreditorAddress:'3 Rue Exemple, 75000 Example Ville, France',structuredReference:'RF18539007547034',
 unstructuredRemittance:'Invoice EX-2026-0001',regulatoryCountry:'DE',regulatoryCode:'GDDS',
 regulatoryDetails:'Goods payment for industrial equipment, non-military use, licence EX-2201'});
// An administrator the bank owner gave FinTerminal access in avis.land's User access management, as avis.land's admission answer
// names them (src/workstation-admission.mjs) - fictional.
export const finTerminalOwner={principal:'admin:owner@example.test',name:'Example Owner',owner:true,finTerminal:true,administrators:[{name:'Example Owner',owner:true}]};
