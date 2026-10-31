import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {openRuntime} from './runtime.mjs';

test('真实 Pi 运行记录每次模型请求和完整的工具调用',async()=>{
 const faux=fauxProvider(),model=faux.getModel(),records=[];
 const runtime=await openRuntime(':memory:',{
  modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true,
  crmRequest:async()=>({items:[{id:'company-1',name:'模拟客户'}]}),
  onRunTelemetry:record=>records.push(record),
 });
 try{
  faux.setResponses([
   fauxAssistantMessage([fauxToolCall('crm_search',{resource:'companies',query:'模拟客户'},{id:'call-1'})],{stopReason:'toolUse'}),
   fauxAssistantMessage('找到了模拟客户。'),
  ]);
  const result=await runtime.chat('查找模拟客户','run-1');
  assert.equal(result.answer,'找到了模拟客户。');
  assert.equal(records.length,1);
  assert.equal(records[0].runId,'run-1');
  assert.match(records[0].submissionId,/^\d+$/);
  assert.equal(records[0].generations.length,2);
  assert.match(JSON.stringify(records[0].generations[0].input),/查找模拟客户/);
  assert.match(JSON.stringify(records[0].generations[1].input),/模拟客户/);
  assert.equal(records[0].toolCalls.length,1);
  assert.equal(records[0].toolCalls[0].name,'crm_search');
  assert.equal(records[0].toolCalls[0].status,'ok');
  assert.match(JSON.stringify(records[0].toolCalls[0].output),/模拟客户/);
  assert.equal(records[0].generations[0].status,'ok');
 }finally{await runtime.close();}
});

test('不同会话的轨迹不会混在一起',async()=>{
 const faux=fauxProvider(),model=faux.getModel(),records=[];
 const runtime=await openRuntime(':memory:',{modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true,onRunTelemetry:record=>records.push(record)});
 try{
  faux.setResponses([fauxAssistantMessage('第一条答案'),fauxAssistantMessage('第二条答案')]);
  await runtime.chat('第一个问题','one');
  await runtime.newConversation();
  await runtime.chat('第二个问题','two');
  assert.deepEqual(records.map(x=>x.runId),['one','two']);
  assert.doesNotMatch(JSON.stringify(records[1]),/第一个问题/);
 }finally{await runtime.close();}
});

test('参数不合法的工具调用仍出现在轨迹中，且不会执行真实工具',async()=>{
 const faux=fauxProvider(),model=faux.getModel(),records=[];let requests=0;
 const runtime=await openRuntime(':memory:',{modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true,crmRequest:async()=>{requests++;return {};},onRunTelemetry:record=>records.push(record)});
 try{
  faux.setResponses([fauxAssistantMessage([fauxToolCall('crm_search',{resource:'非法类型'},{id:'bad-call'})],{stopReason:'toolUse'}),fauxAssistantMessage('无法执行')]);
  await runtime.chat('查询','invalid-run');assert.equal(requests,0);
  const call=records[0].toolCalls.find(item=>item.id==='bad-call');assert.ok(call);assert.equal(call.status,'error');
  assert.match(JSON.stringify(call.output),/./);
 }finally{await runtime.close();}
});

test('自进化的提示词优化、候选和比较各有真实模型轨迹',async()=>{
 const faux=fauxProvider(),model=faux.getModel(),records=[];
 const runtime=await openRuntime(':memory:',{modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true,onAuxRunDetail:record=>records.push(record)});
 try{
  faux.setResponses([fauxAssistantMessage('原始回答')]);const answer=await runtime.chat('原始问题');
  faux.setResponses([fauxAssistantMessage('优化问题'),fauxAssistantMessage('候选回答'),fauxAssistantMessage('比较意见')]);
  await runtime.evolve(answer.traceId);
  const evolution=records.find(item=>item.kind==='evolution');assert.ok(evolution);
  assert.equal(evolution.generations.length,3);
  assert.match(JSON.stringify(evolution.generations[0]),/原始问题/);
  assert.match(JSON.stringify(evolution.generations[1]),/候选回答/);
  assert.match(JSON.stringify(evolution.generations[2]),/比较意见/);
 }finally{await runtime.close();}
});

test('手动运行的 Harness 任务也产生实际模型轨迹',async()=>{
 const faux=fauxProvider(),model=faux.getModel(),records=[];
 const runtime=await openRuntime(':memory:',{modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true,onAuxRunDetail:record=>records.push(record)});
 try{
  faux.setResponses([fauxAssistantMessage('OK')]);await runtime.harness2Run([{id:'one',input:'执行任务',expected:'OK'}]);
  const record=records.find(item=>item.kind==='harness.execute');assert.ok(record);
  assert.match(JSON.stringify(record.generations),/执行任务/);assert.match(JSON.stringify(record.generations),/OK/);
 }finally{await runtime.close();}
});

test('语义检索记录实际输入和向量结果',async()=>{
 const records=[],runtime=await openRuntime(':memory:',{enableMemory:true,memoryScope:'test',modelReady:()=>true,embeddingProvider:async texts=>texts.map(()=>[0.25,0.75]),onAuxRunDetail:record=>records.push(record)});
 try{
  await runtime.memorySemantic(true);await runtime.memorySearch('交期');
  const record=records.find(item=>item.kind==='memory.embedding');assert.ok(record);
  assert.match(JSON.stringify(record.generations[0].input),/交期/);
  assert.deepEqual(record.generations[0].output,[[0.25,0.75]]);
  await runtime.memorySemantic(false);
 }finally{await runtime.close();}
});
