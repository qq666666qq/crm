import {test} from 'node:test';import assert from 'node:assert/strict';
import {buildMemorySnapshot} from './snapshot.mjs';

test('从 Pi 条目关联 CRM 来源并统计实际工具调用',()=>{
 const entries=[
  {id:1,kind:'pi.user',model:[{role:'user',content:'查询客户'}]},
  {id:2,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'toolCall',id:'call-1',name:'crm_search',arguments:{resource:'companies'}}]}]},
  {id:3,byTaskId:33,kind:'pi.tool-result',data:{diagnostics:[]},model:[{role:'toolResult',toolCallId:'call-1',toolName:'crm_search',content:[{type:'text',text:'{"items":[{"id":"company-1"}]}'}],isError:false}]},
  {id:4,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'客户需要样品'}]}]},
 ];
 const snapshot=buildMemorySnapshot('c1',entries);
 assert.equal(snapshot.messageCount,2);assert.equal(snapshot.toolCallCount,1);
 assert.deepEqual(snapshot.entries[1].sources,[{conversationId:'c1',entryId:'4',resource:'companies',resourceId:'company-1'}]);
});

test('无法确认外部数据来源时不把关联对话用于自动记忆',()=>{
 const entries=[{id:1,kind:'pi.user',model:[{role:'user',content:'查询'}]},{id:2,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'toolCall',id:'x',name:'other_tool',arguments:{}}]}]},{id:3,byTaskId:12,kind:'pi.tool-result',data:{diagnostics:[]},model:[{role:'toolResult',toolCallId:'x',toolName:'other_tool',content:[{type:'text',text:'机密'}]}]},{id:4,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'机密摘要'}]}]}];
 const snapshot=buildMemorySnapshot('c1',entries);assert.equal(snapshot.toolCallCount,1);assert.equal(snapshot.entries.length,0);assert.equal(snapshot.skipped,1);
});

test('后续回答沿用先前上下文的客户权限范围',()=>{
 const entries=[{id:1,kind:'pi.user',model:[{content:'查客户'}]},{id:2,kind:'pi.assistant',model:[{content:[{type:'toolCall',id:'call',name:'crm_get',arguments:{resource:'companies',id:'company-1'}}]}]},{id:3,byTaskId:10,kind:'pi.tool-result',model:[{toolCallId:'call',content:[{type:'text',text:'{}'}]}]},{id:4,kind:'pi.assistant',model:[{content:[{type:'text',text:'客户需求'}]}]},{id:5,kind:'pi.user',model:[{content:'继续'}]},{id:6,kind:'pi.assistant',model:[{content:[{type:'text',text:'延续客户需求'}]}]}];
 const snapshot=buildMemorySnapshot('c1',entries);assert.equal(snapshot.entries.at(-1).sources[0].resourceId,'company-1');
});

test('记忆工具的结果继承原记忆的客户权限范围',()=>{
 const entries=[{id:1,kind:'pi.user',model:[{content:'查询记忆'}]},{id:2,kind:'pi.assistant',model:[{content:[{type:'toolCall',id:'call',name:'memory_search',arguments:{query:'客户'}}]}]},{id:3,byTaskId:10,kind:'pi.tool-result',model:[{toolCallId:'call',content:[{type:'text',text:JSON.stringify({items:[{id:'memory-1',version:2,content:'客户需求',sources:[{conversation_id:'old',entry_id:'old-entry',resource:'companies',resource_id:'company-1'}]}]})}]}]},{id:4,kind:'pi.assistant',model:[{content:[{type:'text',text:'客户需求'}]}]}];
 const snapshot=buildMemorySnapshot('c1',entries);assert.ok(snapshot.entries.at(-1).sources.some(x=>x.resourceId==='company-1'));assert.ok(snapshot.entries.at(-1).sources.some(x=>x.conversationId==='old'&&x.parentMemoryId==='memory-1'&&x.parentVersion===2));
});
