import {XMLParser} from 'fast-xml-parser';

// The window's DOMParser as far as the FinTerminal's reader of a message (public/fin-message.mjs, readFinMessage) uses it, for
// the server: a peer bank's transfer taken on the listening port (src/fin-peer.mjs) is read into the form as the composer reads
// its own XML - each element's local name, child elements, text and attributes, in their order. Only a message that passed its
// official schemas is read so.
const ordered=new XMLParser({preserveOrder:true,ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false,
 trimValues:false,processEntities:true});
const nameOf=entry=>Object.keys(entry).find(key=>key!==':@');
const textOf=entries=>entries.map(entry=>'#text' in entry?String(entry['#text']):textOf(entry[nameOf(entry)]||[])).join('');
function element(entry){
 const localName=nameOf(entry),content=entry[localName]||[],attributes=entry[':@']||{};
 return {nodeType:1,localName,namespaceURI:'',textContent:textOf(content),getAttribute:name=>attributes['@_'+name]??null,
  childNodes:content.filter(child=>!('#text' in child)&&!nameOf(child).startsWith('?')).map(element)};
}
export class ServerDOMParser{
 parseFromString(xml){
  const root=ordered.parse(xml).find(entry=>!nameOf(entry).startsWith('?'));
  return {documentElement:root?element(root):null,getElementsByTagName:()=>[]};
 }
}
