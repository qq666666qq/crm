import {randomUUID} from 'node:crypto';

// Owns accepted worker requests and the details of the one active chat.
// Pi remains responsible for durable task execution and recovery.
export function createRunCoordinator({getRuntime,getTrace,ready,send}) {
 let accepting=true,activeDetail=null,activeChat=null;
 const requests=new Set(),traceWrites=new Set();
 function accept(work) {
  if(!accepting)return false;
  const request=Promise.resolve().then(work);requests.add(request);
  void request.catch(()=>{}).finally(()=>requests.delete(request));
  return true;
 }
 async function waitFor(set){while(set.size)await Promise.allSettled([...set]);}
 async function persist(detail){try{await getRuntime().traceSave(detail);send({type:'run-detail-ready',id:detail.id});}catch{send({type:'trace-storage-error'});send({type:'run-detail',detail});}}
 function persistAux(detail){const work=ready.then(()=>persist(detail)).finally(()=>traceWrites.delete(work));traceWrites.add(work);void work.catch(()=>{});return work;}
 function telemetry(record){if(activeDetail&&activeDetail.id===record.runId){activeDetail.submissionId=record.submissionId;activeDetail.generations=record.generations;activeDetail.toolCalls=record.toolCalls;}}
 function crmCall(runId,operation,args){if(!activeDetail||activeDetail.id!==runId)return null;const call={name:operation,operation,args,startedAt:new Date().toISOString(),status:'running'};activeDetail.toolCalls.push(call);return call;}
 function chat(text,requestId=randomUUID()){
  if(activeChat){if(activeChat.id===requestId&&activeChat.text===text)return activeChat.promise;return Promise.reject(Error(activeChat.id===requestId?'CHAT_REQUEST_CONFLICT':'BUSY'));}
  const run={id:requestId,text,promise:null};activeChat=run;
  run.promise=(async()=>{
   const runtime=getRuntime(),trace=getTrace();let traceId;
   try{
    const result=await runtime.chat(text,undefined,requestId,async({existing,conversationId})=>{
     if(existing)return null;
     traceId=await trace.start();activeDetail={id:traceId,kind:'chat',sessionId:conversationId,started_at:new Date().toISOString(),userMessage:text,toolCalls:[]};return traceId;
    });
    if(activeDetail){Object.assign(activeDetail,{finished_at:new Date().toISOString(),status:'completed',answer:result.answer,model:result.model,usage:result.usage,cost:result.cost});await trace.finish(traceId,'completed');await persist(activeDetail);}return result;
   }catch(error){if(activeDetail){Object.assign(activeDetail,{finished_at:new Date().toISOString(),status:'failed',error:String(error&&error.message||error).slice(0,2000)});try{await trace.finish(traceId,'failed');}catch{}await persist(activeDetail);}throw error;}
   finally{activeDetail=null;}
  })().finally(()=>{if(activeChat===run)activeChat=null;});
  return run.promise;
 }
 async function close(){accepting=false;await ready;await waitFor(requests);await waitFor(traceWrites);try{await getRuntime().close();}finally{await waitFor(traceWrites);}}
 return {accept,chat,close,crmCall,persistAux,telemetry};
}
