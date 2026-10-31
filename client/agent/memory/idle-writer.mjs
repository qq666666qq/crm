import {defineTask,defineExtension,defineDocFamily} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';

const IdleKey=defineDocFamily({kind:'crm.memory.idle-writer-key',version:1,scope:'session',family:true,initial:()=>({taskId:null}),checkpointWhen:()=>true});
export function createIdleWriter({repo,delayMs=600000,onProgress=()=>{}}){
 let check;
 const task=defineTask({name:'crm.memory.idle-writer',version:1,initial:()=>({phase:'wait'}),phases:{
  wait:async(current,runtime,context)=>{
   const {ref,dueAt}=current.input;
   if(runtime.now()<dueAt){await repo.taskStatus(ref,'idle','waiting_idle',{taskId:String(runtime.taskId)});onProgress({...ref,kind:'idle',status:'waiting_idle'});return runtime.sleepUntil(dueAt,{phase:'check'},context);}
   return runtime.commit(()=>({status:'running',checkpoint:{phase:'check'}}),context);
  },
  check:async(current,runtime,context)=>{
   const {ref}=current.input;if(!check)throw Error('IDLE_COORDINATOR_UNAVAILABLE');
   const result=await check(ref);
   if(result==='busy')return runtime.sleepUntil(runtime.now()+60000,{phase:'check'},context);
   await repo.taskStatus(ref,'idle',result,{taskId:String(runtime.taskId)});onProgress({...ref,kind:'idle',status:result});
   return runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:result}}}),context);
  }
 },abort:async(current,runtime,context)=>{await repo.taskStatus(current.input.ref,'idle','interrupted',{taskId:String(runtime.taskId)});await runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),context);}});
 const extension=defineExtension({name:'crm.memory.idle-writer',tasks:[task]});
 async function schedule(harness,ref,createdAt){
  await repo.queueTask(ref,'idle');const key=`${ref.conversationId}:${ref.submissionId}`;const dueAt=Date.parse(createdAt)+delayMs;
  const taskId=await harness.commit(async tx=>{const doc=await tx.doc(IdleKey,key,null);if(doc.taskId==null)doc.taskId=await tx.createTask(task,{ref,dueAt:Number.isFinite(dueAt)?dueAt:Date.now()+delayMs},{ownership:{kind:'conversation'},conversationId:ref.piConversationId,background:true});return doc.taskId;},BACKGROUND_CONTEXT);
  await repo.linkTask(ref,'idle',taskId);harness.resume();return taskId;
 }
 return {extension,schedule,attach(fn){check=fn;}};
}
