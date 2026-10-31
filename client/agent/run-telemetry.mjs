import {defineExtension,hook,GenerationTask,ToolTask} from '@earendil-works/pi-durable';

// Capture only the conversation explicitly selected for the current run.
// Hooks observe Pi's requests; they never change messages or tool decisions.
export function createRunTelemetry(){
 const active=new Map();
 const copy=value=>{if(value===undefined)return undefined;try{return structuredClone(value);}catch{return '[无法复制的运行记录]';}};
 const now=()=>new Date().toISOString();
 const current=api=>active.get(String(api.conversationId));
 const extension=defineExtension({name:'crm.run-telemetry',hooks:[
  hook(GenerationTask,{
   beforeRequest(request,api){
    const run=current(api);if(!run)return;
    run.generations.push({taskId:String(api.taskId),input:copy(request.messages),startedAt:now(),status:'running'});
   },
   afterResponse(message,api){
    const run=current(api);if(!run)return;
    const taskId=String(api.taskId),call=[...run.generations].reverse().find(item=>item.taskId===taskId&&item.status==='running');
    if(!call)return;
    Object.assign(call,{output:copy(message),finishedAt:now(),status:message.stopReason==='error'||message.stopReason==='aborted'?'error':'ok',model:{provider:message.provider,modelId:message.model},usage:copy(message.usage)});
   },
  }),
  hook(ToolTask,{
   beforeTool(call,api){
    const run=current(api);if(!run)return;
    run.toolCalls.push({id:String(call.id),taskId:String(api.taskId),name:call.name,args:copy(call.arguments),parentCallId:call.parent?.callId,startedAt:now(),status:'running'});
   },
   afterTool(call,result,api){
    const run=current(api);if(!run)return;
    const item=run.toolCalls.find(value=>value.taskId===String(api.taskId));if(!item)return;
    Object.assign(item,{output:copy(result.output),structuredOutput:copy(result.structuredOutput),details:copy(result.details),diagnostics:copy(result.diagnostics),usage:copy(result.usage),control:copy(result.control),finishedAt:now(),status:result.isError?'error':'ok'});
   },
  }),
 ]});
 function begin(conversationId,runId){
  const key=String(conversationId);if(active.has(key))throw Error('TRACE_ALREADY_ACTIVE');
  active.set(key,{runId,conversationId:key,generations:[],toolCalls:[]});
 }
 function finish(conversationId,entries=[]){
  const key=String(conversationId),run=active.get(key);if(!run)return null;active.delete(key);
  const results=new Map();
  for(const entry of entries){
   if(entry.kind!=='pi.tool-result')continue;
   for(const message of entry.model||[])if(message.toolCallId)results.set(String(message.toolCallId),{message,diagnostics:entry.data?.diagnostics});
  }
  for(const entry of entries){
   if(entry.kind!=='pi.assistant')continue;
   for(const message of entry.model||[])for(const part of Array.isArray(message.content)?message.content:[]){
    if(part.type!=='toolCall')continue;
    const id=String(part.id),result=results.get(id);let item=run.toolCalls.find(call=>call.id===id);
    if(!item){item={id,name:part.name,args:copy(part.arguments),status:'unknown',timing:'unavailable'};run.toolCalls.push(item);}
    if(result){item.output=copy(result.message.content);item.diagnostics=copy(result.diagnostics);item.status=result.message.isError?'error':'ok';}
   }
  }
  for(const call of [...run.generations,...run.toolCalls])if(call.status==='running'){call.status='interrupted';call.finishedAt=now();}
  return run;
 }
 return {extension,begin,finish};
}
