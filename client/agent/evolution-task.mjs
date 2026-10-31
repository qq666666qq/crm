import {defineDocFamily,defineExtension,defineTask} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {randomUUID} from 'node:crypto';

const Runs=defineDocFamily({kind:'crm.evolution.tasks',version:1,scope:'session',family:true,initial:()=>({runs:[]}),checkpointWhen:()=>true});
const visibleErrors=new Set(['EVOLUTION_SOURCE_UNAVAILABLE','EVOLUTION_PERMISSION_REVOKED','NOT_FOUND','MODEL_NOT_CONFIGURED','MODEL_REQUEST_FAILED']);

// The durable parent resumes after a restart. Each attempt and its model
// conversations are abandoned on restart before a new, authorized attempt starts.
export function createEvolutionTask({perform,ready,onProgress=()=>{},waitModelMs=30000}){
 let harness,attach;const attached=new Promise(resolve=>{attach=resolve;}),listeners=new Map();
 async function mark(runtime,context,input,stage,extra={}){
  await runtime.commit(async tx=>{const doc=await tx.doc(Runs,String(input.conversationId),null),row=doc.runs.find(item=>item.runId===input.runId);if(row){row.stage=stage;Object.assign(row,extra);}},context);
  const event={conversationId:String(input.conversationId),traceId:input.traceId,runId:input.runId,stage,...extra};try{onProgress(event);}catch{}try{listeners.get(input.runId)?.(stage);}catch{}
 }
 const attempt=defineTask({name:'crm.evolution.attempt',version:1,initial:()=>({phase:'run'}),phases:{
  run:async(current,runtime,context)=>{
   await attached;const input=current.input;
   try{
    const conversation=await harness.conversation(input.conversationId,context);if(!conversation)throw Error('NOT_FOUND');
    const result=await perform(conversation,input.traceId,stage=>mark(runtime,context,input,stage),runtime.taskId,input.runId,runtime.signal);
    await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{value:result}}}),context);
   }catch(error){if(runtime.signal.aborted)throw error;const reason=visibleErrors.has(error?.message)?error.message:'EVOLUTION_FAILED';await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{error:reason}}}),context);}
  }
 },abort:async(current,runtime,context)=>{
  const input=current.input;let interruptedAtStage;await runtime.commit(async tx=>{const doc=await tx.doc(Runs,String(input.conversationId),null),row=doc.runs.find(item=>item.runId===input.runId);if(row){interruptedAtStage=row.stage;row.interruptedAtStage=row.stage;row.stage='interrupted';}return {status:'terminal',outcome:{status:'aborted'}};},context);
  try{onProgress({conversationId:String(input.conversationId),traceId:input.traceId,runId:input.runId,stage:'interrupted',interruptedAtStage});}catch{}
 }});
 const task=defineTask({name:'crm.evolution.run',version:1,initial:()=>({phase:'run',attemptId:null}),phases:{
  run:async(current,runtime,context)=>{
   await attached;const input=current.input,attemptId=current.state.checkpoint.attemptId;
   if(attemptId!=null){
    const child=await runtime.getTask(attemptId,context);
    if(child?.state.status==='terminal'){
     const outcome=child.state.outcome;
     if(outcome.status==='completed'){
      const result=outcome.result,stage=result?.error?'failed':'completed';
      await runtime.commit(async tx=>{const doc=await tx.doc(Runs,String(input.conversationId),null),row=doc.runs.find(item=>item.runId===input.runId);if(row){row.stage=stage;row.reason=result?.error||null;row.finishedAt=new Date().toISOString();}return {status:'terminal',outcome:{status:'completed',result}};},context);
      try{onProgress({conversationId:String(input.conversationId),traceId:input.traceId,runId:input.runId,stage});}catch{}return;
     }
     if(outcome.status!=='aborted'){await mark(runtime,context,input,'failed');return runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{error:'EVOLUTION_FAILED'}}}),context);}
    }else if(child)return runtime.commit(()=>({status:'waiting',on:[attemptId],policy:'allSettled',checkpoint:{phase:'run',attemptId}}),context);
   }
   if(!ready()){await mark(runtime,context,input,'waiting_model');return runtime.sleepUntil(runtime.now()+waitModelMs,{phase:'run',attemptId:null},context);}
   return runtime.commit(async tx=>{const id=await tx.createTask(attempt,input,{ownership:{kind:'task',taskId:runtime.taskId},abandonOnRestart:true});return {status:'waiting',on:[id],policy:'allSettled',checkpoint:{phase:'run',attemptId:id}};},context);
  }
 },abort:async(current,runtime,context)=>{
  const input=current.input;await runtime.commit(async tx=>{const doc=await tx.doc(Runs,String(input.conversationId),null),row=doc.runs.find(item=>item.runId===input.runId);if(row){row.stage='interrupted';row.finishedAt=new Date().toISOString();}return {status:'terminal',outcome:{status:'aborted'}};},context);
 }});
 const extension=defineExtension({name:'crm.evolution.task',tasks:[task,attempt]});
 async function execute(conversationId,traceId,listener){
  if(!harness||!ready())throw Error('MODEL_NOT_CONFIGURED');
  const runId=randomUUID(),input={conversationId,traceId:String(traceId),runId};if(listener)listeners.set(runId,listener);
  try{
   const taskId=await harness.commit(async tx=>{const doc=await tx.doc(Runs,String(conversationId),null);const id=await tx.createTask(task,input,{ownership:{kind:'conversation'},conversationId,background:true});doc.runs.push({runId,taskId:String(id),traceId:String(traceId),stage:'queued',createdAt:new Date().toISOString()});doc.runs=doc.runs.slice(-50);return id;},BACKGROUND_CONTEXT);
   harness.resume();const completed=await harness.waitForTask(taskId,BACKGROUND_CONTEXT),outcome=completed.state.outcome;
   if(outcome.status!=='completed')throw Error('EVOLUTION_INTERRUPTED');if(outcome.result?.error)throw Error(outcome.result.error);return outcome.result.value;
  }finally{listeners.delete(runId);}
 }
 async function list(conversationId){if(!harness)return [];const doc=await harness.snapshot(Runs,String(conversationId),BACKGROUND_CONTEXT);return [...(doc?.runs||[])].reverse();}
 return {extension,bind(value){harness=value;attach();},execute,list};
}
