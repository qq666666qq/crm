import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';

const validNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const iso=value=>new Date(value).toISOString();
const text=message=>typeof message?.content==='string'?message.content:Array.isArray(message?.content)?message.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'):'';

// Reconstruct only what Pi actually persisted. Original model request contexts
// and missing timing information are explicitly marked as unavailable.
export function createTraceHistory({harness,storage,conversations,traceStore}){
 async function reconstruct(conversationId,submission){
  if(submission.type!=='input'||!['done','unanswered'].includes(submission.status)||submission.entry==null||String(submission.conversationId)!==String(conversationId))return null;
  if(await traceStore.hasSubmission(String(conversationId),String(submission.id)))return null;
  const conv=await harness.conversation(conversationId,context);if(!conv)return null;
  const entries=[];let cursor,stop=false;
  do{
   const query={minEntryId:submission.entry,order:'ascending'};if(submission.answer!=null)query.maxEntryId=submission.answer;
   const page=await conv.entries(query,500,cursor,context);
   for(const entry of page.items){if(String(entry.id)!==String(submission.entry)&&entry.kind==='pi.user'){stop=true;break;}entries.push(entry);}
   cursor=stop?null:page.next;
  }while(cursor);
  const user=entries.find(item=>String(item.id)===String(submission.entry))?.model?.find(item=>item.role==='user');
  const assistants=entries.flatMap(item=>(item.model||[]).filter(message=>message.role==='assistant'));
  const answer=submission.answer!=null?entries.find(item=>String(item.id)===String(submission.answer))?.model?.find(item=>item.role==='assistant'):assistants.at(-1);
  if(!user||!validNumber(user.timestamp)||(submission.status==='done'&&!answer))return null;
  const generations=[],calls=[],results=new Map();
  for(const entry of entries)for(const message of entry.model||[]){
   if(message.role==='toolResult')results.set(String(message.toolCallId),{message,diagnostics:entry.data?.diagnostics});
   if(message.role!=='assistant')continue;
   const start=validNumber(message.timestamp)?message.timestamp:user.timestamp,hasDuration=validNumber(message.durationMs),end=start+(hasDuration?message.durationMs:0);
   generations.push({input:null,inputUnavailable:true,output:message,model:{provider:message.provider,modelId:message.model},usage:message.usage,startedAt:iso(start),finishedAt:iso(end),status:['error','aborted'].includes(message.stopReason)?'error':'ok',...(!hasDuration?{timing:'unavailable'}:{})});
   for(const item of Array.isArray(message.content)?message.content:[])if(item.type==='toolCall')calls.push({id:String(item.id),name:item.name,args:item.arguments,status:'unknown',timing:'unavailable'});
  }
  for(const call of calls){const result=results.get(call.id);if(!result)continue;const message=result.message;call.output=message.content;call.details=message.details;call.diagnostics=result.diagnostics;call.usage=message.usage;call.status=message.isError?'error':'ok';if(validNumber(message.timestamp)){const duration=validNumber(message.durationMs)?message.durationMs:0;call.startedAt=iso(Math.max(0,message.timestamp-duration));call.finishedAt=iso(message.timestamp);if(validNumber(message.durationMs))delete call.timing;}}
  const observed=entries.flatMap(entry=>entry.model||[]).map(message=>validNumber(message.timestamp)?message.timestamp+(validNumber(message.durationMs)?message.durationMs:0):user.timestamp);
  const end=observed.reduce((latest,value)=>Math.max(latest,value),user.timestamp);
  return {id:`history:${conversationId}:${submission.id}`,kind:'chat.history',sessionId:String(conversationId),submissionId:String(submission.id),reconstructed:true,started_at:iso(user.timestamp),finished_at:iso(end),status:submission.status==='done'?'completed':'failed',...(submission.status==='unanswered'?{error:String(submission.reason||'unanswered'),timing:'unavailable'}:{}),userMessage:user.content,answer:text(answer),model:{provider:answer?.provider,modelId:answer?.model},generations,toolCalls:calls};
 }
 async function page({conversationId,cursor,limit=20}){
  const native=conversations().get(String(conversationId));if(native===undefined)throw Error('NOT_FOUND');
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_TRACE_QUERY');
  const page=await storage.scanSubmissions({conversationId:native,order:'ascending'},limit,cursor,context),items=[];
  for(const submission of page.items){const detail=await reconstruct(native,submission);if(detail)items.push(detail);}
  return {items,next:page.next||null};
 }
 async function get(id){
  const match=typeof id==='string'&&/^history:(\d+):(\d+)$/.exec(id);if(!match)return null;
  const native=conversations().get(match[1]),submissionId=Number(match[2]);if(native===undefined||!Number.isSafeInteger(submissionId))return null;
  const submission=await storage.submission(submissionId,context);return submission?reconstruct(native,submission):null;
 }
 return {page,get};
}
