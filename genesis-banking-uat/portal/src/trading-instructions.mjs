import {TradingLiveCore} from './trading-live.mjs';
import {fault,money,decimal} from './core.mjs';
import {indexHash} from './index-event-advice.mjs';

export const TRADING_INSTRUCTION_MESSAGES={
 TRADING_INSTRUCTIONS:'Use the five execution settings shown in the JSON instructions. Notes are optional.',
 TRADING_INSTRUCTIONS_CONFLICT:'This trading configuration changed. Reload its current instructions before saving.',
};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const admin=actor=>{if(!actor?.id||!actor.admin||actor.customerUserId||actor.indexService)fault('FORBIDDEN',null,403);};
const amount=value=>String(value).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
const zero=value=>/^0(?:\.0+)?$/.test(String(value));
const fields=['maxNotional','dailyNotional','maxLoss','minimumIndex','trailingBps','notes'];
export function parseTradingInstructions(text){
 if(typeof text!=='string'||!text.trim()||text.length>24000)fault('TRADING_INSTRUCTIONS','instructions');
 let value;try{value=JSON.parse(text);}catch{fault('TRADING_INSTRUCTIONS','instructions');}
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!fields.includes(key))||fields.slice(0,5).some(key=>!Object.hasOwn(value,key)))fault('TRADING_INSTRUCTIONS','instructions');
 let max,daily,loss;try{max=money(value.maxNotional);daily=money(value.dailyNotional);loss=money(value.maxLoss);}catch{fault('TRADING_INSTRUCTIONS','instructions');}
 if(daily<max||!Number.isFinite(value.minimumIndex)||value.minimumIndex< -100||value.minimumIndex>100||!Number.isInteger(value.trailingBps)||value.trailingBps<5||value.trailingBps>2000)fault('TRADING_INSTRUCTIONS','instructions');
 const notes=value.notes??'';
 if(typeof notes!=='string'||notes.length>16000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notes)||/\r(?!\n)/.test(notes))fault('TRADING_INSTRUCTIONS','instructions');
 return {maxNotional:amount(decimal(max)),dailyNotional:amount(decimal(daily)),maxLoss:amount(decimal(loss)),minimumIndex:value.minimumIndex,trailingBps:value.trailingBps,notes};
}

export class TradingInstructionsCore extends TradingLiveCore {
 async instructionRobot(db,id,lock=false){
  if(typeof id!=='string'||!uuid.test(id))fault('TRADING_TEST_PROFILE','robotId');
  const robot=(await db.query(`SELECT r.* FROM avis_core_v2.trading_robots r JOIN avis_core_v2.sovereign_users u USING(user_id)
   WHERE r.robot_id=$1 AND u.account_role='INSTITUTION'${lock?' FOR '+(lock==='SHARE'?'SHARE':'UPDATE')+' OF r':''}`,[id])).rows[0];
  if(!robot)fault('TRADING_TEST_PROFILE','robotId');return robot;
 }
 async robotInstructionState(db,robot){
  const row=robot.robot_id?(await db.query('SELECT * FROM avis_core_v2.trading_robot_instructions WHERE robot_id=$1 ORDER BY version DESC LIMIT 1',[robot.robot_id])).rows[0]:null;
  // Execution values always reflect the actual saved profile, including edits
  // made through its existing configuration form. Free text is audit context.
  const document={maxNotional:amount(robot.max_notional),dailyNotional:amount(robot.daily_notional),maxLoss:amount(robot.max_loss),minimumIndex:Number(robot.minimum_index),trailingBps:Number(robot.trailing_bps),notes:row?.document.notes??''};
  return {robotId:robot.robot_id,version:Number(robot.version??0),instructionVersion:row?Number(row.version):0,
   policyHash:indexHash(document),document,instructions:JSON.stringify(document,null,2),updatedAt:row?new Date(row.created_at).toISOString():null};
 }
 async robotInstructions(actor,input){
  admin(actor);const db=await this.pool.connect();
  try{await db.query('BEGIN');const robot=await this.instructionRobot(db,input?.robotId,'SHARE'),state=await this.robotInstructionState(db,robot);await db.query('COMMIT');return state;}
  catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async saveRobotInstructions(actor,input,key){
  admin(actor);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['robotId','expectedVersion','instructions'].includes(k)))fault('INVALID_FIELD','instructions');
  if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fault('INVALID_FIELD','expectedVersion');
  const document=parseTradingInstructions(input.instructions);
  return this.operation(actor,'TRADING_ROBOT_INSTRUCTIONS',input,key,async db=>{
   const robot=await this.instructionRobot(db,input.robotId,true);
   if(Number(robot.version)!==input.expectedVersion)fault('TRADING_INSTRUCTIONS_CONFLICT','expectedVersion',409);
   if(!zero(robot.position_quantity)||(await db.query("SELECT 1 FROM avis_core_v2.trading_robot_orders WHERE robot_id=$1 AND status IN('CREATED','DISPATCHING','ACKNOWLEDGED')",[robot.robot_id])).rows.length)fault('ROBOT_POSITION');
   const next=Number(robot.version)+1;
   await db.query('INSERT INTO avis_core_v2.trading_robot_instructions(robot_id,version,policy_hash,document,created_by) VALUES($1,$2,$3,$4,$5)',[robot.robot_id,next,indexHash(document),JSON.stringify(document),actor.id]);
   const updated=(await db.query(`UPDATE avis_core_v2.trading_robots SET max_notional=$2,daily_notional=$3,max_loss=$4,minimum_index=$5,trailing_bps=$6,
    enabled=false,version=version+1,last_event_advice='[]'::jsonb WHERE robot_id=$1 RETURNING *`,[robot.robot_id,document.maxNotional,document.dailyNotional,document.maxLoss,document.minimumIndex,document.trailingBps])).rows[0];
   return {...await this.robotInstructionState(db,updated),id:robot.robot_id,enabled:false};
  });
 }
 async tradingTestConfiguration(db,robot){
  const configuration=await super.tradingTestConfiguration(db,robot),policy=await this.robotInstructionState(db,robot);
  return {...configuration,tradingInstructionHash:policy.policyHash};
 }
 async robotInstructionEvidence(db,robot){
  const policy=await this.robotInstructionState(db,robot);
  return {instructionVersion:policy.instructionVersion,configurationVersion:policy.version,policyHash:policy.policyHash,document:policy.document};
 }
}
