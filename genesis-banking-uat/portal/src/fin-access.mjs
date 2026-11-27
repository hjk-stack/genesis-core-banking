import {randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {fault} from './core.mjs';

// The FinTerminal's access and its 4-Eyes checker (specification v3, FinTerminal_Unified_NOSTRO_Crypto_System_v3: "4-Eyes
// Maker-Checker PIN"). The bank owner: "I authorise them at the moment when i invite a user in the standard admin", "Only
// authorised user gets access and these must be named", "4 Eyes is 2 pins. I will during the beta time interning both PINs.
// This means the pin creation must be directly on the GUI for both PINs", and of its switch: "I can. Login se the GUI must sow
// my name on it". Who is authorised, by name, and who is the owner, come from avis.land with each request
// (src/workstation-admission.mjs); the bank keeps the two PINs, only scrypt-hashed, and the switch.
const scrypt=promisify(scryptCallback);
const COST={N:16384,r:8,p:1,maxmem:64*1024*1024};
const PIN=/^[0-9]{6,12}$/;
const ATTEMPTS=5;
async function hashPin(pin){const salt=randomBytes(16);return 'scrypt$'+salt.toString('base64')+'$'+(await scrypt(pin,salt,32,COST)).toString('base64');}
async function samePin(pin,stored){
 const [kind,salt,key]=String(stored||'').split('$');if(kind!=='scrypt'||!salt||!key)return false;
 const expected=Buffer.from(key,'base64');return timingSafeEqual(await scrypt(pin,Buffer.from(salt,'base64'),expected.length,COST),expected);
}
const slotOf=value=>value===1||value===2?value:fault('INVALID_FIELD','slot');
const pinOf=(value,field)=>typeof value==='string'&&PIN.test(value)?value:fault('FIN_PIN',field);

export class FinAccess {
 constructor(pool){this.pool=pool;}

 // Only an administrator given FinTerminal access - avis.land's answer for this sign-in.
 person(person){if(person?.finTerminal!==true||typeof person.name!=='string'||!person.name||typeof person.principal!=='string')fault('FIN_TERMINAL_ACCESS',null,403);return person;}

 async state(person){
  const you=this.person(person);
  const [mode,pins]=await Promise.all([
   this.pool.query('SELECT four_eyes,four_eyes_changed_by,four_eyes_changed_at FROM avis_core_v2.fin_terminal_mode WHERE mode_id=1'),
   this.pool.query('SELECT slot,holder_name,set_at,locked_until>now() AS locked FROM avis_core_v2.fin_terminal_pins ORDER BY slot')]);
  const switched=mode.rows[0]||{};
  return {you:{name:you.name,owner:you.owner===true},administrators:(you.administrators||[]).map(({name,owner})=>({name,owner:owner===true})),
   fourEyes:{on:switched.four_eyes===true,by:switched.four_eyes_changed_by||null,at:switched.four_eyes_changed_at?new Date(switched.four_eyes_changed_at).toISOString():null},
   pins:[1,2].map(slot=>{const row=pins.rows.find(item=>Number(item.slot)===slot);
    return {slot,holder:row?.holder_name||null,setAt:row?new Date(row.set_at).toISOString():null,locked:row?.locked===true};})};
 }

 // A PIN not made yet is made by the administrator signed in, who becomes its holder; a PIN made is changed only with it.
 async setPin(actor,person,body){
  const who=this.person(person),slot=slotOf(body?.slot),pin=pinOf(body?.pin,'pin');
  const client=await this.pool.connect();let wrong=false;
  try{
   await client.query('BEGIN');
   const row=(await client.query('SELECT pin_hash,failed_attempts,locked_until>now() AS locked FROM avis_core_v2.fin_terminal_pins WHERE slot=$1 FOR UPDATE',[slot])).rows[0];
   if(row){
    if(row.locked)fault('FIN_PIN_LOCKED','currentPin',423);
    const current=pinOf(body?.currentPin,'currentPin');
    if(!await samePin(current,row.pin_hash)){
     // Five wrong entries lock the PIN for 15 minutes; the count is kept although the change is refused.
     const failed=Number(row.failed_attempts)+1;wrong=true;
     await client.query(`UPDATE avis_core_v2.fin_terminal_pins SET failed_attempts=CASE WHEN $2>=${ATTEMPTS} THEN 0 ELSE $2 END,
      locked_until=CASE WHEN $2>=${ATTEMPTS} THEN now()+interval '15 minutes' ELSE locked_until END WHERE slot=$1`,[slot,failed]);
     await client.query('COMMIT');
     fault(failed>=ATTEMPTS?'FIN_PIN_LOCKED':'FIN_PIN_WRONG','currentPin',failed>=ATTEMPTS?423:422);
    }
    await client.query(`UPDATE avis_core_v2.fin_terminal_pins SET holder_principal=$2,holder_name=$3,pin_hash=$4,failed_attempts=0,locked_until=NULL,set_at=now()
     WHERE slot=$1`,[slot,who.principal,who.name,await hashPin(pin)]);
   }else{
    const made=await client.query(`INSERT INTO avis_core_v2.fin_terminal_pins(slot,holder_principal,holder_name,pin_hash) VALUES($1,$2,$3,$4)
     ON CONFLICT(slot) DO NOTHING RETURNING slot`,[slot,who.principal,who.name,await hashPin(pin)]);
    if(!made.rows.length)fault('FIN_PIN_WRONG','currentPin');
   }
   await client.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),row?'FIN_PIN_CHANGED':'FIN_PIN_CREATED','PIN '+slot]);
   await client.query('COMMIT');
  }catch(failure){if(!wrong)await client.query('ROLLBACK').catch(()=>{});throw failure;}
  finally{client.release?.();}
  return this.state(who);
 }

 // The switch is the owner's alone.
 async fourEyes(actor,person,body){
  const who=this.person(person);
  if(who.owner!==true)fault('FIN_FOUR_EYES',null,403);
  if(typeof body?.on!=='boolean')fault('INVALID_FIELD','on');
  await this.pool.query('UPDATE avis_core_v2.fin_terminal_mode SET four_eyes=$1,four_eyes_changed_by=$2,four_eyes_changed_at=now() WHERE mode_id=1',[body.on,who.name]);
  await this.pool.query('INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES($1,$2,$3)',[String(actor.id),body.on?'FIN_FOUR_EYES_ON':'FIN_FOUR_EYES_OFF','4-Eyes']);
  return this.state(who);
 }
}
