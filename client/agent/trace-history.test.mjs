import {test} from 'node:test';import assert from 'node:assert/strict';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createModels} from '@earendil-works/pi-ai/models';
import {Harness,MemoryStorage,createRegistry} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {crmReadExtension} from './crm-tools.mjs';
import {createTraceStore} from './trace-store.mjs';
import {createTraceHistory} from './trace-history.mjs';

test('从既有 Pi 消息恢复旧对话和工具结果，标明无法恢复的模型输入',async()=>{
 const faux=fauxProvider(),model=faux.getModel(),models=createModels(),storage=new MemoryStorage(),registry=createRegistry();models.setProvider(faux.provider);
 const crm=crmReadExtension(async()=>({items:[{id:'demo',name:'测试客户'}]}));registry.install(crm);
 const harness=await Harness.open(storage,{models,registry},context);
 try{
  const conversation=await harness.root(context,{agent:{model:{provider:model.provider,modelId:model.id},extensions:[crm]}});
  faux.setResponses([fauxAssistantMessage([fauxToolCall('crm_search',{resource:'companies',query:'测试客户'},{id:'call-1'})],{stopReason:'toolUse'}),fauxAssistantMessage('找到测试客户')]);
  const sub=await conversation.submit({type:'input',content:'查询测试客户'},context);await sub.wait(context);
  const traces=createTraceStore(harness,storage),history=createTraceHistory({harness,storage,conversations:()=>new Map([[String(conversation.id),conversation.id]]),traceStore:traces});
  traces.setHistoricalLookup(id=>history.get(id));
  const page=await history.page({conversationId:String(conversation.id),limit:10});assert.equal(page.items.length,1);
  const detail=page.items[0];assert.equal(detail.userMessage,'查询测试客户');assert.equal(detail.answer,'找到测试客户');
  assert.equal(detail.reconstructed,true);assert.ok(detail.generations.every(item=>item.input===null&&item.inputUnavailable===true));
  assert.equal(detail.toolCalls[0].name,'crm_search');assert.match(JSON.stringify(detail.toolCalls[0].output),/测试客户/);
  assert.equal((await history.get(detail.id)).id,detail.id);
  await traces.mark(detail.id,'a'.repeat(64),'uploaded');assert.equal((await traces.delivery(detail.id,'a'.repeat(64))).state,'uploaded');
  await assert.rejects(history.page({conversationId:'999',limit:10}),/NOT_FOUND/);
  await traces.save({id:'new-run',kind:'chat',sessionId:String(conversation.id),submissionId:String(sub.id)});
  assert.equal((await history.page({conversationId:String(conversation.id),limit:10})).items.length,0);
 }finally{await harness.close(context);}
});

test('旧请求失败时恢复已保存的输入和工具结果，遇到下一轮用户消息即停止',async()=>{
 const messages=[
  {id:1,kind:'pi.user',model:[{role:'user',content:'第一轮问题',timestamp:1767225600000}]},
  {id:2,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'toolCall',id:'call-1',name:'search',arguments:{q:'客户'}}],timestamp:1767225601000,stopReason:'toolUse'}]},
  {id:3,kind:'pi.tool-result',model:[{role:'toolResult',toolCallId:'call-1',content:[{type:'text',text:'已保存结果'}],timestamp:1767225602000}]},
  {id:4,kind:'pi.user',model:[{role:'user',content:'下一轮问题',timestamp:1767225603000}]},
  {id:5,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'下一轮回答'}],timestamp:1767225604000}]},
 ];
 const submission={id:10,conversationId:1,type:'input',status:'unanswered',entry:1,reason:'provider_error'};
 const storage={async scanSubmissions(query){assert.equal(query.status,undefined);return {items:[submission],next:null};},async submission(){return submission;}};
 const harness={async conversation(){return {async entries(){return {items:messages,next:null};}};}};
 const history=createTraceHistory({harness,storage,conversations:()=>new Map([['1',1]]),traceStore:{async hasSubmission(){return false;}}});
 const result=(await history.page({conversationId:'1'})).items[0];
 assert.equal(result.status,'failed');assert.equal(result.userMessage,'第一轮问题');assert.equal(result.error,'provider_error');
 assert.match(JSON.stringify(result.toolCalls),/已保存结果/);assert.doesNotMatch(JSON.stringify(result),/下一轮/);
});
