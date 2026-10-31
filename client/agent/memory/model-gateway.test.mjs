import {test} from 'node:test';import assert from 'node:assert/strict';
import {createModelGateway} from './model-gateway.mjs';

test('复审固定使用温度零，截断或无效 JSON 不视为通过',async()=>{
 let options;const models={getModel:()=>({id:'test'}),complete:async(_model,_context,opts)=>{options=opts;return {stopReason:'stop',content:[{type:'text',text:'{"approved":true}'}]};}};
 const gateway=createModelGateway(models,{provider:'test',modelId:'test'},()=>true);
 assert.deepEqual(await gateway.review('候选'),{approved:true});assert.equal(options.temperature,0);assert.equal(options.maxTokens,8192);
 models.complete=async()=>({stopReason:'length',content:[{type:'text',text:'{"approved":true}'}]});
 await assert.rejects(gateway.review('候选'),/INCOMPLETE_MODEL_OUTPUT/);
 models.complete=async()=>({stopReason:'stop',content:[{type:'text',text:'不是 JSON'}]});
 await assert.rejects(gateway.review('候选'),/INVALID_MODEL_JSON/);
});

test('记忆任务导出实际的模型输入、输出和失败状态',async()=>{
 const records=[],models={getModel:()=>({id:'test'}),complete:async()=>({stopReason:'stop',content:[{type:'text',text:'{"should_reflect":false}'}]})};
 const gateway=createModelGateway(models,{provider:'test',modelId:'test'},()=>true,{onRunDetail:record=>records.push(record)});
 await gateway.reflect('原始上下文',undefined,{conversationId:'conv-1',submissionId:'submit-1'});
 assert.equal(records.length,1);assert.equal(records[0].kind,'memory.reflect');assert.equal(records[0].status,'completed');assert.equal(records[0].sessionId,'conv-1');assert.equal(records[0].submissionId,'submit-1');
 assert.match(JSON.stringify(records[0].generations[0].input),/原始上下文/);
 assert.match(JSON.stringify(records[0].generations[0].output),/should_reflect/);
 models.complete=async()=>({stopReason:'length',content:[{type:'text',text:'截断输出'}]});
 await assert.rejects(gateway.reflect('另一个上下文'),/INCOMPLETE_MODEL_OUTPUT/);
 assert.equal(records[1].status,'failed');assert.match(JSON.stringify(records[1].generations[0].output),/截断输出/);
});
