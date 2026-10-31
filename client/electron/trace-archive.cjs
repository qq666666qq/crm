'use strict';

const {createHash}=require('node:crypto');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {buildLangfusePayload,tracesUrl}=require('./langfuse-export.cjs');
const {toOtlp}=require('./trace-export.cjs');

// The worker owns Pi's database. Only one page of identifiers and one full
// trace travel to the main process at a time.
function createTraceArchive({request,upload,context,isCurrent,pageSize=50}){
 const running=new Map();
 function current(ctx){if(!isCurrent(ctx))throw Error('SESSION_CHANGED');}
 function begin(){
  const ctx=context();current(ctx);
  const cfg=ctx.config||{};
  const destination=cfg.baseUrl&&cfg.publicKey?`${tracesUrl(cfg.baseUrl)}\0${cfg.publicKey}`:'local-export';
  return {...ctx,target:createHash('sha256').update(destination).digest('hex')};
 }
 async function call(ctx,type,payload={}){current(ctx);const result=await request(type,payload);current(ctx);return result;}
 async function* pages(ctx,type,value){
  let cursor=null,previous=null;
  do{
   const page=await call(ctx,type,{value:{...value,target:ctx.target,limit:pageSize,...(cursor!==null?{cursor}:{})}});
   if(!page||!Array.isArray(page.items))throw Error('INVALID_TRACE_PAGE');
   for(const item of page.items){if(!item||typeof item.id!=='string')throw Error('INVALID_TRACE_PAGE');yield item;}
   cursor=page.next??null;
   if(cursor!==null){const serialized=JSON.stringify(cursor);if(serialized===previous)throw Error('INVALID_TRACE_CURSOR');previous=serialized;}
  }while(cursor!==null);
 }
 async function* entries(ctx){
  yield* pages(ctx,'trace-page',{});
  const conversations=await call(ctx,'trace-conversations');
  if(!Array.isArray(conversations))throw Error('INVALID_TRACE_PAGE');
  for(const conversationId of conversations)yield* pages(ctx,'trace-history-page',{conversationId:String(conversationId)});
 }
 async function detail(ctx,id){
  const item=await call(ctx,'trace-get',{value:{id,target:ctx.target}});
  if(!item?.detail||item.detail.id!==id)throw Error('TRACE_NOT_FOUND');
  return item;
 }
 async function status(){
  const ctx=begin();let pending=0,lastError=null;
  for await(const item of entries(ctx))if(item.state!=='uploaded'){pending++;if(item.error)lastError=item.error;}
  return {pending,lastError};
 }
 async function uploadOne(id,providedContext){
  const ctx=providedContext||begin(),key=`${ctx.generation}:${ctx.target}:${id}`;
  if(running.has(key))return running.get(key);
  const work=(async()=>{
   try{
    const item=await detail(ctx,id);
    if(item.state==='uploaded')return {ok:true,alreadyUploaded:true};
    if(item.state==='partial')return {ok:false,error:'LANGFUSE_PARTIAL_FAILURE'};
    if(!ctx.config?.baseUrl||!ctx.config?.publicKey||!ctx.config?.secretKey)return {ok:false,error:'LANGFUSE_NOT_CONFIGURED'};
    const result=await upload(buildLangfusePayload(item.detail,ctx.buildOptions||{}),ctx.config);
    current(ctx);
    const state=result.ok?'uploaded':result.error==='LANGFUSE_PARTIAL_FAILURE'?'partial':'pending';
    try{await call(ctx,'trace-mark',{value:{id,target:ctx.target,state,error:result.ok?null:String(result.error||'LANGFUSE_UPLOAD_FAILED').slice(0,100)}});}
    catch(error){if(error.message==='SESSION_CHANGED')throw error;return {ok:false,error:'LANGFUSE_DELIVERY_STATE_UNSAVED'};}
    return result;
   }catch(error){return {ok:false,error:error?.message==='SESSION_CHANGED'?'SESSION_CHANGED':'LANGFUSE_UPLOAD_FAILED'};}
  })();
  running.set(key,work);try{return await work;}finally{if(running.get(key)===work)running.delete(key);}
 }
 async function uploadAll(){
  const ctx=begin();let uploaded=0,failed=0,total=0,lastError=null;
  for await(const item of entries(ctx)){
   if(item.state==='uploaded')continue;
   total++;const result=await uploadOne(item.id,ctx);
   if(result.ok)uploaded++;else{failed++;lastError=result.error||'LANGFUSE_UPLOAD_FAILED';if(lastError==='SESSION_CHANGED')break;}
  }
  return {uploaded,failed,total,lastError};
 }
 async function writeExport(write,legacy=[],fallback=[]){
  if(typeof write!=='function'||!Array.isArray(legacy)||!Array.isArray(fallback))throw Error('INVALID_TRACE_EXPORT');
  const ctx=begin(),remaining=new Map(legacy.map(item=>[item.id,item])),unsaved=new Map(fallback.map(item=>[item.id,item]));let first=true,details=0;
  async function append(resource){current(ctx);await write((first?'':',')+JSON.stringify(resource));current(ctx);first=false;}
  await write('{"resourceSpans":[');current(ctx);
  for await(const item of entries(ctx)){
   const stored=await detail(ctx,item.id);
   for(const resource of buildLangfusePayload(stored.detail,ctx.buildOptions||{}).resourceSpans)await append(resource);
   remaining.delete(item.id);unsaved.delete(item.id);details++;
  }
  for(const item of unsaved.values()){
   for(const resource of buildLangfusePayload(item,ctx.buildOptions||{}).resourceSpans)await append(resource);
   remaining.delete(item.id);details++;
  }
  const summaries=toOtlp([...remaining.values()]);
  for(const resource of summaries.resourceSpans)if(resource.scopeSpans?.some(scope=>scope.spans?.length))await append(resource);
  current(ctx);await write(']}');current(ctx);
  return {details,legacy:remaining.size};
 }
 return {status,uploadOne,uploadAll,writeExport};
}

// A failed or cancelled export never truncates an existing selected file.
async function writeTraceExportFile(archive,filename,legacy,fallback,check=()=>{}){
 const temporary=path.join(path.dirname(filename),`.${path.basename(filename)}.${randomUUID()}.tmp`);let handle,created=false;
 try{
  check();handle=await fs.open(temporary,'wx',0o600);created=true;
  const report=await archive.writeExport(chunk=>handle.writeFile(chunk,'utf8'),legacy,fallback);
  await handle.sync();await handle.close();handle=null;check();
  await fs.rename(temporary,filename);return report;
 }finally{if(handle)await handle.close().catch(()=>{});if(created)await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
module.exports={createTraceArchive,writeTraceExportFile};
