import {defineTask,defineExtension,defineDoc} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';

const IndexTask=defineDoc({kind:'crm.memory.semantic-index',version:1,scope:'session',initial:()=>({taskId:null}),checkpointWhen:()=>true});
const valid=vector=>Array.isArray(vector)&&vector.length>0&&vector.length<=8192&&vector.every(x=>typeof x==='number'&&Number.isFinite(x));

// A Pi task scans bounded pages and sleeps after a full pass. Its checkpoint survives restarts.
export function createSemanticIndex({repo,embed,ready,getModel=async()=> 'text-embedding-3-small',onProgress=()=>{}}){
 const enabled=async()=>await repo.metadata('semantic_enabled')==='1';
 const status=async(value)=>{await repo.metadata('semantic_index_status',JSON.stringify(value));onProgress({kind:'semantic_index',...value});};
 const task=defineTask({name:'crm.memory.semantic-index',version:1,initial:()=>({phase:'scan',cursor:0,indexed:0,attempt:0}),phases:{
  scan:async(current,runtime,context)=>{
   const {cursor,indexed,attempt}=current.state.checkpoint;
   if(!await enabled()){await status({status:'disabled'});return runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:'disabled'}}}),context);}
   if(!ready()){await status({status:'waiting_model',indexed});return runtime.sleepUntil(runtime.now()+30000,{phase:'scan',cursor,indexed,attempt},context);}
   try{
    const model=await getModel(),page=await repo.embeddingPage(model,{after:cursor,limit:20}),missing=[];
    for(const row of page.items)if(row.vector==null){const latest=await repo.get(row.id);if(latest?.status==='active'&&latest.version===row.version)missing.push(row);}
    let added=0;
    if(missing.length){
     if(!await enabled())return runtime.commit(()=>({status:'running',checkpoint:{phase:'scan',cursor,indexed,attempt:0}}),context);
     // Re-check every source immediately before sending its contents to the provider.
     const permitted=[];for(const row of missing){const latest=await repo.get(row.id);if(latest?.status==='active'&&latest.version===row.version)permitted.push(row);}
     if(permitted.length){await status({status:'indexing',indexed});const vectors=await embed(permitted.map(row=>row.content.slice(0,2000)),model,runtime.signal);
      if(!Array.isArray(vectors)||vectors.length!==permitted.length||vectors.some(v=>!valid(v)||v.length!==vectors[0].length))throw Error('INVALID_EMBEDDING');
      if(runtime.signal.aborted)throw Error('TASK_ABORTED');
      for(let i=0;i<permitted.length;i++){if(!await enabled()||await getModel()!==model)break;const latest=await repo.get(permitted[i].id);if(latest?.status==='active'&&latest.version===permitted[i].version){await repo.saveEmbedding(permitted[i],model,vectors[i]);added++;}}
     }
    }
    const total=indexed+added;
    if(page.end){await status({status:'completed',indexed:total});return runtime.sleepUntil(runtime.now()+300000,{phase:'scan',cursor:0,indexed:0,attempt:0},context);}
    await status({status:'indexing',indexed:total});return runtime.commit(()=>({status:'running',checkpoint:{phase:'scan',cursor:page.next,indexed:total,attempt:0}}),context);
   }catch(error){if(runtime.signal.aborted)throw error;const next=attempt+1;await status({status:'unavailable',indexed,attempt:next});return runtime.sleepUntil(runtime.now()+Math.min(300000,30000*next),{phase:'scan',cursor,indexed,attempt:next},context);}
  }
 },abort:async(_current,runtime,context)=>{await status({status:'interrupted'});await runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),context);}});
 const extension=defineExtension({name:'crm.memory.semantic-index',tasks:[task]});
 async function ensure(harness,conversationId){
  if(!await enabled())return null;
  const previous=await harness.snapshot(IndexTask,BACKGROUND_CONTEXT);let replace=null;
  if(previous?.taskId!=null){const record=await harness.getTask(previous.taskId,BACKGROUND_CONTEXT);if(!record||record.state.status==='terminal')replace=previous.taskId;else {harness.resume();return previous.taskId;}}
  const id=await harness.commit(async tx=>{const doc=await tx.doc(IndexTask);if(doc.taskId==null||(replace!=null&&doc.taskId===replace))doc.taskId=await tx.createTask(task,{}, {ownership:{kind:'conversation'},conversationId,background:true});return doc.taskId;},BACKGROUND_CONTEXT);
  harness.resume();return id;
 }
 async function getStatus(){try{return JSON.parse(await repo.metadata('semantic_index_status')||'{}');}catch{return {};}}
 async function stop(harness){const doc=await harness.snapshot(IndexTask,BACKGROUND_CONTEXT);if(doc?.taskId!=null){const record=await harness.getTask(doc.taskId,BACKGROUND_CONTEXT);if(record&&record.state.status!=='terminal'){await harness.abortTask(doc.taskId,BACKGROUND_CONTEXT);await harness.waitForTask(doc.taskId,BACKGROUND_CONTEXT);}}await status({status:'disabled'});}
 return {extension,ensure,stop,getStatus};
}
