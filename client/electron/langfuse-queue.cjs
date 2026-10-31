'use strict';

// The queue contains only this login session's in-memory records.
function createLangfuseQueue(send){
 const records=new Map(),running=new Map();let epoch=0;
 function add(detail){if(!detail||typeof detail.id!=='string'||!detail.id)throw Error('INVALID_RUN');if(!records.has(detail.id))records.set(detail.id,{detail,status:'pending'});}
 function all(){return [...records.values()].map(row=>row.detail);}
 function pending(){return [...records.values()].filter(row=>row.status!=='uploaded').length;}
 function lastError(){return [...records.values()].reverse().find(row=>row.status!=='uploaded'&&row.error)?.error||null;}
 function clear(){epoch++;records.clear();running.clear();}
 async function upload(id){
  const row=records.get(id);if(!row)return {ok:false,error:'RUN_NOT_FOUND'};
  if(row.status==='uploaded')return {ok:true,alreadyUploaded:true};
  if(row.status==='partial')return {ok:false,error:'LANGFUSE_PARTIAL_FAILURE'};
  if(running.has(id))return running.get(id);
  const originalEpoch=epoch;
  const task=Promise.resolve().then(()=>epoch===originalEpoch&&records.get(id)===row?send(row.detail):{ok:false,error:'SESSION_CHANGED'}).catch(()=>({ok:false,error:'LANGFUSE_UPLOAD_FAILED'})).then(result=>{
   if(epoch===originalEpoch&&records.get(id)===row){row.status=result.ok?'uploaded':result.error==='LANGFUSE_PARTIAL_FAILURE'?'partial':'pending';row.error=result.error;}
   return result;
  }).finally(()=>{if(epoch===originalEpoch&&running.get(id)===task)running.delete(id);});
  running.set(id,task);return task;
 }
 async function uploadAll(){
  const originalEpoch=epoch;
  const ids=[...records].filter(([,row])=>row.status!=='uploaded').map(([id])=>id);
  let uploaded=0,failed=0,lastError=null;
  for(let index=0;index<ids.length;index++){if(epoch!==originalEpoch){failed+=ids.length-index;lastError='SESSION_CHANGED';break;}const result=await upload(ids[index]);if(result.ok)uploaded++;else{failed++;lastError=result.error||'LANGFUSE_UPLOAD_FAILED';}}
  return {uploaded,failed,total:ids.length,lastError};
 }
 return {add,all,pending,lastError,clear,upload,uploadAll};
}
module.exports={createLangfuseQueue};
