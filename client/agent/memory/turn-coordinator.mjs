import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {buildMemorySnapshot} from './snapshot.mjs';
import {evaluateTurn} from './turn-policy.mjs';

const later=(a,b)=>BigInt(String(a))>BigInt(String(b));

// Commit listeners only enqueue IDs. All reads and writes happen after the listener returns.
export async function createTurnCoordinator({harness,storage,repo,memoryTasks,idleWriter,knownConversations,onProgress=()=>{}}){
 let tail=Promise.resolve(),stopped=false;const queued=new Set();
 async function scanSubmissions(conversationId){
  const result=[];let cursor;
  do{const page=await storage.scanSubmissions({conversationId,status:'done',order:'ascending'},500,cursor,BACKGROUND_CONTEXT);result.push(...page.items.filter(item=>item.type==='input'));cursor=page.next;}while(cursor);
  return result;
 }
 async function readEntries(conversation,answer){
  const entries=[];let cursor;
  do{const page=await conversation.entries({order:'ascending',maxEntryId:answer},500,cursor,BACKGROUND_CONTEXT);entries.push(...page.items);cursor=page.next;}while(cursor);
  return entries;
 }
 async function process(submission){
  if(stopped||submission.type!=='input'||submission.status!=='done'||!knownConversations().has(String(submission.conversationId)))return;
  const conversation=await harness.conversation(submission.conversationId,BACKGROUND_CONTEXT);if(!conversation)return;
  const all=await scanSubmissions(submission.conversationId),completedRuns=all.filter(item=>!later(item.id,submission.id)).length;
  const snapshot=buildMemorySnapshot(String(submission.conversationId),await readEntries(conversation,submission.answer));
  const ref={conversationId:String(submission.conversationId),piConversationId:submission.conversationId,submissionId:String(submission.id),answerEntryId:String(submission.answer),completedRuns,messageCount:snapshot.messageCount,toolCallCount:snapshot.toolCallCount};
  const turn=await repo.recordTurn(ref);onProgress({conversationId:ref.conversationId,submissionId:ref.submissionId,kind:'check',status:'completed',harvest:turn.harvest_status});
  const currentUser=snapshot.entries.find(entry=>entry.id===String(submission.entry)),currentAnswer=snapshot.entries.find(entry=>entry.id===String(submission.answer));
  const currentSafe=Boolean(currentUser&&currentAnswer),length=snapshot.entries.reduce((sum,entry)=>sum+entry.text.length,0);
  const decisions=evaluateTurn({completedRuns,contentLength:length,messageCount:snapshot.messageCount,toolCallCount:snapshot.toolCallCount});
  const explicit=currentUser&&/(记住|记下来|请记|帮我记|保存为记忆)/.test(currentUser.text);
  if(currentSafe&&decisions.reflection)await memoryTasks.schedule(harness,ref,snapshot,'reflection');
  else await repo.queueTask(ref,'reflection');
  if(currentSafe&&(decisions.writer||explicit))await memoryTasks.schedule(harness,ref,snapshot,'writer');
  else await repo.queueTask(ref,'writer');
  if(idleWriter&&currentSafe&&!decisions.writer&&!explicit&&length>=100&&await repo.turnsSinceWriter(ref.conversationId)>=8)await idleWriter.schedule(harness,ref,turn.created_at);
  if(!currentSafe||!decisions.reflection){await repo.finishSkipped(ref,'reflection');onProgress({conversationId:ref.conversationId,submissionId:ref.submissionId,kind:'reflection',status:'skipped'});}
  if(!currentSafe||(!decisions.writer&&!explicit)){await repo.finishSkipped(ref,'writer');onProgress({conversationId:ref.conversationId,submissionId:ref.submissionId,kind:'writer',status:'skipped'});}
 }
 function enqueue(submission){
  const key=String(submission.id);if(stopped||queued.has(key))return;queued.add(key);
  const work=tail.then(()=>process(submission));tail=work.catch(()=>{onProgress({conversationId:String(submission.conversationId),submissionId:key,kind:'check',status:'failed'});}).finally(()=>queued.delete(key));
 }
 const unsubscribe=harness.subscribeCommits(publication=>{for(const change of publication.changes)if(change.type==='submission'&&change.value.type==='input'&&change.value.status==='done')queueMicrotask(()=>enqueue(change.value));});
 const all=[];for(const id of knownConversations().values())all.push(...await scanSubmissions(id));
 let activation=await repo.metadata('activation_submission');
 if(activation===undefined){activation=all.reduce((max,item)=>later(item.id,max)?String(item.id):max,'0');await repo.metadata('activation_submission',activation);}
 else for(const submission of all)if(later(submission.id,activation))enqueue(submission);
 async function snapshotForSubmission(conversationId,submissionId){
  const nativeId=knownConversations().get(String(conversationId));if(nativeId===undefined)throw Error('NOT_FOUND');
  const submission=(await scanSubmissions(nativeId)).find(item=>String(item.id)===String(submissionId));if(!submission)throw Error('NOT_FOUND');
  const conversation=await harness.conversation(nativeId,BACKGROUND_CONTEXT);if(!conversation)throw Error('NOT_FOUND');
  const snapshot=buildMemorySnapshot(String(nativeId),await readEntries(conversation,submission.answer));
  return {ref:{conversationId:String(nativeId),piConversationId:nativeId,submissionId:String(submission.id),answerEntryId:String(submission.answer)},snapshot};
 }
 if(idleWriter)idleWriter.attach(async ref=>{
  const nativeId=knownConversations().get(ref.conversationId);if(nativeId===undefined)return 'skipped';
  for(const state of ['queued','placed']){const page=await storage.scanSubmissions({conversationId:nativeId,status:state},1,undefined,BACKGROUND_CONTEXT);if(page.items.some(item=>item.type==='input'))return 'busy';}
  const all=await scanSubmissions(nativeId),latest=all.at(-1);if(!latest||String(latest.id)!==ref.submissionId||await repo.turnsSinceWriter(ref.conversationId)<8)return 'skipped';
  const data=await snapshotForSubmission(ref.conversationId,ref.submissionId),user=data.snapshot.entries.find(entry=>entry.id===String(latest.entry)),answer=data.snapshot.entries.find(entry=>entry.id===String(latest.answer));
  if(!user||!answer||data.snapshot.entries.reduce((sum,item)=>sum+item.text.length,0)<100)return 'source_unavailable';
  await memoryTasks.schedule(harness,data.ref,data.snapshot,'writer');return 'completed';
 });
 harness.resume();
 return {snapshotForSubmission,async drain(){await tail;},async close(){stopped=true;unsubscribe();await tail;}};
}
