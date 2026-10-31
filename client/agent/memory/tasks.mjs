import {defineTask,defineExtension,defineDocFamily} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';

const TaskKey=defineDocFamily({kind:'crm.memory.task-key',version:1,scope:'session',family:true,initial:()=>({taskId:null}),checkpointWhen:()=>true});
const errorCodes=new Set(['MODEL_NOT_CONFIGURED','MODEL_NOT_AVAILABLE','INCOMPLETE_MODEL_OUTPUT','INVALID_MODEL_JSON','INVALID_MEMORY_RESULT','SOURCE_NOT_FOUND']);
function code(error){return errorCodes.has(error?.message)?error.message:'MEMORY_TASK_FAILED';}
// Keep source IDs intact while bounding background model input on long conversations.
function inputForModel(snapshot){let remaining=32000;const selected=[];for(let i=snapshot.entries.length-1;i>=0&&remaining>0;i--){const {id,role,text}=snapshot.entries[i];const excerpt=text.slice(0,Math.min(4000,remaining));if(excerpt){selected.push({id,role,text:excerpt});remaining-=excerpt.length;}}return JSON.stringify(selected.reverse());}
function skillInput(snapshot){return JSON.stringify({entries:snapshot.entries.slice(-20).map(({id,role,text})=>({id,role,text:text.slice(0,2000)})),trace:(snapshot.trace||[]).slice(-15).map(({name,arguments:args,result})=>({name,arguments:args,result:result.slice(0,2000)}))});}
function skillSources(snapshot){const items=[...snapshot.entries.slice(-20),...(snapshot.trace||[]).slice(-15)],unique=new Map();for(const item of items)for(const source of item.sources||[]){const key=source.parentMemoryId?`parent:${source.parentMemoryId}:${source.parentVersion}:${source.resource||''}:${source.resourceId||''}`:source.resource?`${source.resource}:${source.resourceId}`:`${source.conversationId}:${source.entryId}`;if(!unique.has(key))unique.set(key,source);}return [...unique.values()];}
function citedSources(snapshot,ids,submissionId){
 if(!Array.isArray(ids)||ids.length===0||ids.length>20)throw Error('SOURCE_NOT_FOUND');
 const byId=new Map(snapshot.entries.map(entry=>[entry.id,entry]));const unique=new Map();
 for(const id of ids){const entry=byId.get(String(id));if(!entry)throw Error('SOURCE_NOT_FOUND');for(const source of entry.sources){const item={...source,submissionId};unique.set(JSON.stringify(item),item);}}
 if(unique.size===0||unique.size>100)throw Error('SOURCE_NOT_FOUND');return [...unique.values()];
}

export function createMemoryTasks({repo,gateway,ready,prefixes,onProgress=()=>{}}){
 let modelQueue=Promise.resolve();
 function serialModel(fn,signal){const run=modelQueue.then(()=>{if(signal.aborted)throw Error('TASK_ABORTED');return fn();});modelQueue=run.catch(()=>{});return run;}
 const task=defineTask({name:'crm.memory.process',version:1,initial:input=>({phase:input.kind==='harvest'?'generate':'run',attempt:0}),phases:{
  run:async(current,runtime,context)=>{
   const {ref,snapshot,kind}=current.input,attempt=current.state.checkpoint.attempt;
   const status=async(value,extra={})=>{await repo.taskStatus(ref,kind,value,{taskId:String(runtime.taskId),attempt,...extra});onProgress({conversationId:ref.conversationId,submissionId:ref.submissionId,kind,status:value});};
   const finish=async(value)=>{await status(value);await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:value}}}),context);};
   if(!snapshot.entries.length)return finish('skipped');
   if(!ready()) {await status('waiting_model');return runtime.sleepUntil(runtime.now()+30000,{phase:'run',attempt},context);}
   if(!await repo.checkSources(snapshot.entries.flatMap(entry=>entry.sources)))return finish('blocked_permission');
   try{
    const modelInput=inputForModel(snapshot),shownIds=new Set(JSON.parse(modelInput).map(entry=>entry.id));
    const shownSnapshot={...snapshot,entries:snapshot.entries.filter(entry=>shownIds.has(entry.id))};
    await status('running');let result=await runtime.memo('model-result',context);
    if(result===undefined){result=await serialModel(()=>kind==='writer'?gateway.extract(modelInput,runtime.signal,ref):gateway.reflect(modelInput,runtime.signal,ref),runtime.signal);result=await runtime.memo('model-result',result,context);}
    if(runtime.signal.aborted)throw Error('TASK_ABORTED');
    if(kind==='writer'){
     if(!Array.isArray(result.items)||result.items.length>10)throw Error('INVALID_MEMORY_RESULT');
     for(let index=0;index<result.items.length;index++){
      const item=result.items[index];if(!item||!['project','reference','feedback'].includes(item.kind)||typeof item.content!=='string'||!item.content.trim()||item.content.length>4000)throw Error('INVALID_MEMORY_RESULT');
      const operationKey=`${ref.submissionId}:writer:${index}`;if(await repo.operationExists(operationKey))continue;
      const sources=citedSources(shownSnapshot,item.sourceEntryIds,ref.submissionId);if(!await repo.checkSources(sources))return finish('blocked_permission');
      const related=await repo.related(item.content);let conflicts=[];
      const exact=related.find(existing=>existing.status==='pending'&&existing.kind===item.kind&&existing.content===item.content.trim());
      if(exact){await repo.mergeExactPending({id:exact.id,expectedVersion:exact.version,operationKey,kind:item.kind,content:item.content,sources});continue;}
      if(related.length){
       let relations=null;try{if(typeof gateway.compareMemory==='function'){const response=await serialModel(async()=>{if(!await repo.checkSources(sources))throw Error('FORBIDDEN');for(const existing of related){const current=await repo.get(existing.id);if(!current||current.status!==existing.status||current.version!==existing.version)throw Error('VERSION_CONFLICT');}return gateway.compareMemory(JSON.stringify({candidate:item.content,existing:related}),runtime.signal,ref);},runtime.signal);const entries=response?.relations;if(Array.isArray(entries)&&entries.length===related.length&&new Set(entries.map(x=>x.id)).size===related.length&&entries.every(x=>related.some(y=>y.id===x.id)&&['same','conflict','distinct','uncertain'].includes(x.relation)&&typeof x.reason==='string'&&x.reason.length<=500))relations=entries;}}catch(error){if(runtime.signal.aborted)throw error;}
       for(const existing of related){const current=await repo.get(existing.id);if(!current||current.status!==existing.status||current.version!==existing.version)return finish('blocked_permission');}
       conflicts=related.flatMap(existing=>{const relation=relations?.find(x=>x.id===existing.id);if(existing.content===item.content.trim())return [{id:existing.id,version:existing.version,reason:'内容相同，来源或类别仍需核对'}];return !relation||relation.relation!=='distinct'?[{id:existing.id,version:existing.version,reason:relation?.reason||'存在相似记忆，需要人工核对'}]:[];});
      }
      if(!await repo.checkSources(sources))return finish('blocked_permission');
      await repo.save({operationKey,kind:item.kind,content:item.content,sources,conflicts});
     }
     return finish(result.items.length?'completed':'skipped');
    }
    if(typeof result.should_reflect!=='boolean')throw Error('INVALID_MEMORY_RESULT');
    if(!result.should_reflect)return finish('skipped');
    if(typeof result.lesson!=='string'||!result.lesson.trim()||result.lesson.length>700)throw Error('INVALID_MEMORY_RESULT');
    const sources=citedSources(shownSnapshot,result.sourceEntryIds,ref.submissionId);if(!await repo.checkSources(sources))return finish('blocked_permission');
    await repo.save({operationKey:`${ref.submissionId}:reflection`,kind:'reflection',content:result.lesson,sources});
    const list=prefixes.get(ref.conversationId)||[];if(!list.some(item=>item.submissionId===ref.submissionId))list.push({submissionId:ref.submissionId,lesson:result.lesson,sources});prefixes.set(ref.conversationId,list.slice(-3));
    return finish('completed');
   }catch(error){
    if(runtime.signal.aborted)throw error;
    const errorCode=code(error);if(attempt<2){await status('retrying',{attempt:attempt+1,errorCode});return runtime.sleepUntil(runtime.now()+10000*(attempt+1),{phase:'run',attempt:attempt+1},context);}
    await status('failed',{attempt:attempt+1,errorCode});return runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:'failed',errorCode}}}),context);
   }
  },
  generate:async(current,runtime,context)=>{
   const {ref,snapshot}=current.input,attempt=current.state.checkpoint.attempt;
   const status=async(value,extra={})=>{await repo.taskStatus(ref,'harvest',value,{taskId:String(runtime.taskId),attempt,...extra});onProgress({conversationId:ref.conversationId,submissionId:ref.submissionId,kind:'harvest',status:value});};
   const finish=async(value)=>{await status(value);await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:value}}}),context);};
   if(!(await repo.recommendations(ref.conversationId)).some(item=>item.submission_id===ref.submissionId))return finish('expired');
   if(!snapshot.entries.length||!(snapshot.trace||[]).length)return finish('source_unavailable');
   const sources=skillSources(snapshot);if(!sources.length||sources.length>100)return finish('source_unavailable');
   if(!await repo.checkSources(sources))return finish('blocked_permission');
   if(!ready()){await status('waiting_model');return runtime.sleepUntil(runtime.now()+30000,{phase:'generate',attempt},context);}
   try{
    await status('generating');let proposal=await runtime.memo('skill-proposal',context);
    if(proposal===undefined){const existing=(await repo.activeSkills()).map(item=>({name:item.name,version:item.version}));proposal=await serialModel(()=>gateway.proposeSkill(JSON.stringify({trajectory:JSON.parse(skillInput(snapshot)),existingSkills:existing}),runtime.signal,ref),runtime.signal);proposal=await runtime.memo('skill-proposal',proposal,context);}
    if(runtime.signal.aborted)throw Error('TASK_ABORTED');
    if(!['skip','create','replace','delete'].includes(proposal?.operation)||typeof proposal.reason!=='string')throw Error('INVALID_MEMORY_RESULT');
    if(proposal.operation==='skip'){await repo.consumeRecommendation(ref);return finish('skipped');}
    if(typeof proposal.name!=='string'||!proposal.name.trim()||proposal.name.length>100||typeof proposal.content!=='string'||Buffer.byteLength(proposal.content)>32768||(proposal.operation!=='delete'&&!proposal.content.trim())||proposal.reason.length>4000)throw Error('INVALID_MEMORY_RESULT');
    const active=(await repo.activeSkills()).find(item=>item.name===proposal.name);if(proposal.operation!=='create'&&!active)throw Error('INVALID_MEMORY_RESULT');
    const combined=[...sources,...(active?.sources||[])],unique=new Map(combined.map(source=>[JSON.stringify(source),source])),allSources=[...unique.values()];if(allSources.length>100||!await repo.checkSources(allSources))return finish('blocked_permission');
    await status('reviewing');return runtime.commit(()=>({status:'running',checkpoint:{phase:'review',attempt:0,proposal,sources:allSources,priorContent:active?.content||'',priorVersion:active?.version??null}}),context);
   }catch(error){if(runtime.signal.aborted)throw error;const errorCode=code(error);if(attempt<2){await status('retrying',{attempt:attempt+1,errorCode});return runtime.sleepUntil(runtime.now()+10000*(attempt+1),{phase:'generate',attempt:attempt+1},context);}await status('failed',{attempt:attempt+1,errorCode});return runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:'failed',errorCode}}}),context);}
  },
  review:async(current,runtime,context)=>{
   const {ref,snapshot}=current.input,{attempt,proposal,sources,priorContent,priorVersion}=current.state.checkpoint;
   const status=async(value,extra={})=>{await repo.taskStatus(ref,'harvest',value,{taskId:String(runtime.taskId),attempt,...extra});onProgress({conversationId:ref.conversationId,submissionId:ref.submissionId,kind:'harvest',status:value});};
   const finish=async(value)=>{await status(value);await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:value}}}),context);};
   if(!await repo.checkSources(sources))return finish('blocked_permission');
   if(!ready()){await status('waiting_model');return runtime.sleepUntil(runtime.now()+30000,{phase:'review',attempt,proposal,sources,priorContent,priorVersion},context);}
   try{
    await status('reviewing');let review=await runtime.memo('skill-review',context);
    if(review===undefined){review=await serialModel(()=>gateway.review(JSON.stringify({proposal,priorContent,context:JSON.parse(skillInput(snapshot))}),runtime.signal,ref),runtime.signal);review=await runtime.memo('skill-review',review,context);}
    if(runtime.signal.aborted)throw Error('TASK_ABORTED');
    if(typeof review?.approved!=='boolean'||typeof review.reason!=='string'||review.reason.length>4000)throw Error('INVALID_MEMORY_RESULT');
    if(!await repo.checkSources(sources))return finish('blocked_permission');
    const candidate=await repo.createSkillCandidate(ref,{...proposal,review,sources,expectedActiveVersion:priorVersion});return finish(candidate.status==='reviewed'?'awaiting_confirmation':'review_rejected');
   }catch(error){if(runtime.signal.aborted)throw error;const errorCode=code(error);if(attempt<2){await status('retrying',{attempt:attempt+1,errorCode});return runtime.sleepUntil(runtime.now()+10000*(attempt+1),{phase:'review',attempt:attempt+1,proposal,sources,priorContent,priorVersion},context);}await status('failed',{attempt:attempt+1,errorCode});return runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:'failed',errorCode}}}),context);}
  }
 },abort:async(current,runtime,context)=>{await repo.taskStatus(current.input.ref,current.input.kind,'interrupted',{taskId:String(runtime.taskId)});await runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),context);}});
 const extension=defineExtension({name:'crm.memory.tasks',tasks:[task]});
 async function schedule(harness,ref,snapshot,kind){
  if(!['writer','reflection','harvest'].includes(kind))throw Error('INVALID_MEMORY_TASK');
  await repo.queueTask(ref,kind);
  const key=`${ref.conversationId}:${ref.submissionId}:${kind}`;
  let retryId=null;
  const previous=await harness.snapshot(TaskKey,key,BACKGROUND_CONTEXT);
  if(previous?.taskId!=null){const existing=await harness.getTask(previous.taskId,BACKGROUND_CONTEXT);const outcome=existing?.state?.status==='terminal'?existing.state.outcome:null;if(outcome?.status==='aborted'||outcome?.status==='completed'&&['failed','blocked_permission','source_unavailable'].includes(outcome.result?.status))retryId=previous.taskId;}
  if(retryId!=null)await repo.taskStatus(ref,kind,'queued');
  const id=await harness.commit(async tx=>{const doc=await tx.doc(TaskKey,key,null);if(doc.taskId==null||(retryId!=null&&doc.taskId===retryId))doc.taskId=await tx.createTask(task,{ref,snapshot,kind},{ownership:{kind:'conversation'},conversationId:ref.piConversationId,background:true});return doc.taskId;},BACKGROUND_CONTEXT);
  await repo.linkTask(ref,kind,id);await harness.resume();return id;
 }
 return {extension,schedule};
}
