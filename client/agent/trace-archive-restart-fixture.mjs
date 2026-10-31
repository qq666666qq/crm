import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {openRuntime} from './runtime.mjs';

const {createTraceArchive}=createRequire(import.meta.url)('../electron/trace-archive.cjs');
const [phase,file]=process.argv.slice(2),faux=fauxProvider(),model=faux.getModel(),captures=[];
const options={databaseKey:'1'.repeat(64),modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true,crmRequest:async()=>({items:[{name:'虚构客户'}]}),onRunTelemetry:record=>captures.push(record)};
const runtime=await openRuntime(file,options);
try{
 if(phase==='create'){
  faux.setResponses([fauxAssistantMessage('旧回答')]);await runtime.chat('旧问题','old-run');
  faux.setResponses([fauxAssistantMessage([fauxToolCall('crm_search',{resource:'companies',query:'虚构客户'})],{stopReason:'toolUse'}),fauxAssistantMessage('新回答')]);
  const started=new Date().toISOString(),response=await runtime.chat('新问题','new-run'),finished=new Date().toISOString(),capture=captures.at(-1);
  await runtime.traceSave({id:'new-run',kind:'chat',sessionId:String(runtime.conversationId),submissionId:capture.submissionId,started_at:started,finished_at:finished,status:'completed',userMessage:'新问题',answer:response.answer,model:response.model,generations:capture.generations,toolCalls:capture.toolCalls});
 }else{
  const methods={'trace-page':value=>runtime.tracePage(value),'trace-history-page':value=>runtime.traceHistoryPage(value),'trace-conversations':()=>runtime.traceConversations(),'trace-get':value=>runtime.traceGet(value),'trace-mark':value=>runtime.traceMark(value)};
  const sent=[],archive=createTraceArchive({request:(type,{value}={})=>methods[type](value),upload:async payload=>{sent.push(payload);return {ok:true};},context:()=>({generation:1,config:{baseUrl:'https://example.test',publicKey:'public',secretKey:'secret'},buildOptions:{userId:'scope'}}),isCurrent:()=>true,pageSize:1});
  if(phase==='upload'){
   assert.equal((await archive.status()).pending,2);const result=await archive.uploadAll();assert.equal(result.uploaded,2);
   const output=JSON.stringify(sent);assert.match(output,/旧问题/);assert.match(output,/新问题/);assert.match(output,/虚构客户/);assert.match(output,/input_unavailable/);
   const chunks=[];await archive.writeExport(value=>chunks.push(value),[]);const exported=JSON.parse(chunks.join(''));assert.match(JSON.stringify(exported),/新回答/);
  }else if(phase==='verify'){
   assert.equal((await archive.status()).pending,0);assert.equal((await archive.uploadAll()).total,0);
  }else throw Error('INVALID_PHASE');
 }
}finally{await runtime.close();}
console.log('ok');
