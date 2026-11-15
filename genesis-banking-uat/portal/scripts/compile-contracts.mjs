import solc from 'solc';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const sources=Object.fromEntries(['AVISGreenRollingSecuritySystem.sol','AVISOmniChainMasterHub.sol'].map(n=>[n,{content:readFileSync(root+'contracts/'+n,'utf8')}]));
export function compile(extra={}){
 const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{...sources,...extra},settings:{optimizer:{enabled:true,runs:100},viaIR:true,evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','metadata']}}}}),{import:path=>{try{return {contents:readFileSync(root+(path.startsWith('@')?'node_modules/':'contracts/')+path,'utf8')};}catch{return {error:'Import not found: '+path};}}}));
 const errors=(out.errors||[]).filter(e=>e.severity==='error');if(errors.length)throw Error(errors.map(e=>e.formattedMessage).join('\n'));
 return out.contracts;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const compiled=compile();mkdirSync(root+'contracts/artifacts',{recursive:true});
 for(const [file,name]of [['AVISGreenRollingSecuritySystem.sol','AVISGreenRollingSecurityToken'],['AVISOmniChainMasterHub.sol','AVISOmniChainMasterHub']]){
  const c=compiled[file][name],size=c.evm.deployedBytecode.object.length/2;if(size>24576)throw Error(name+' exceeds EIP-170 size');
  writeFileSync(root+'contracts/artifacts/'+name+'.json',JSON.stringify({contractName:name,compiler:solc.version(),abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,deployedBytecode:'0x'+c.evm.deployedBytecode.object},null,2)+'\n');console.log(name+': '+size+' bytes; compiled');
 }
}
