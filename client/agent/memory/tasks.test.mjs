import {test} from 'node:test';import assert from 'node:assert/strict';
import {Harness,MemoryStorage,createRegistry} from '@earendil-works/pi-durable';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {openNodeSqliteDatabase} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createMemoryRepository} from './repository.mjs';import {createMemoryTasks} from './tasks.mjs';

test('Pi 反思任务根据真实来源保存记忆，重复调度不产生重复记录',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test'}),prefixes=new Map();
 const gateway={reflect:async()=>({should_reflect:true,lesson:'先核对交期',sourceEntryIds:['e1']}),extract:async()=>({items:[]})};
 const tasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes}),registry=createRegistry();registry.install(tasks.extension);
 const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{
  const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'s1',answerEntryId:'a1'},snapshot={entries:[{id:'e1',role:'user',text:'请核对交期',sources:[{conversationId:String(conversation.id),entryId:'e1'}]}]};
  const first=await tasks.schedule(harness,ref,snapshot,'reflection');const second=await tasks.schedule(harness,ref,snapshot,'reflection');assert.equal(first,second);
  const result=await harness.waitForTask(first,context);assert.equal(result.state.outcome.status,'completed');
  assert.equal((await repo.search('核对交期')).items.length,1);assert.equal(prefixes.get(ref.conversationId)[0].lesson,'先核对交期');
 }finally{await harness.close(context);await db.close();}
});

test('失去客户权限时不会把来源发送给反思模型',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test',authorize:async()=>false});let calls=0;
 const tasks=createMemoryTasks({repo,gateway:{reflect:async()=>{calls++;}},ready:()=>true,prefixes:new Map()}),registry=createRegistry();registry.install(tasks.extension);const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'s2',answerEntryId:'a2'},snapshot={entries:[{id:'e1',role:'user',text:'客户',sources:[{conversationId:String(conversation.id),entryId:'e1',resource:'companies',resourceId:'x'}]}]};const id=await tasks.schedule(harness,ref,snapshot,'reflection');await harness.waitForTask(id,context);assert.equal(calls,0);assert.equal((await repo.tasks(ref.conversationId))[0].status,'blocked_permission');}finally{await harness.close(context);await db.close();}
});
test('来源权限恢复后可重试被阻止的反思任务且只保存一次',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');let allowed=false,calls=0;const repo=await createMemoryRepository(db,{scope:'test',authorize:async()=>allowed}),tasks=createMemoryTasks({repo,gateway:{reflect:async()=>{calls++;return {should_reflect:true,lesson:'核对客户交期',sourceEntryIds:['e1']};}},ready:()=>true,prefixes:new Map()}),registry=createRegistry();registry.install(tasks.extension);const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'retry',answerEntryId:'a'},snapshot={entries:[{id:'e1',role:'user',text:'客户交期',sources:[{conversationId:String(conversation.id),entryId:'e1',resource:'companies',resourceId:'x'}]}]};const first=await tasks.schedule(harness,ref,snapshot,'reflection');await harness.waitForTask(first,context);assert.equal(calls,0);assert.equal((await repo.tasks(ref.conversationId))[0].status,'blocked_permission');allowed=true;const second=await tasks.schedule(harness,ref,snapshot,'reflection');assert.notEqual(first,second);await harness.waitForTask(second,context);assert.equal(calls,1);assert.equal((await repo.search('核对客户交期')).items.length,1);assert.equal(await tasks.schedule(harness,ref,snapshot,'reflection'),second);}finally{await harness.close(context);await db.close();}
});

test('用户触发 Skill 沉淀后由 Pi 生成并复审，发布仍由用户决定',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test'}),events=[];
 const gateway={proposeSkill:async()=>{events.push('generate');return {operation:'create',name:'交期核对',content:'先核对交期。',reason:'来自对话'};},review:async()=>{events.push('review');return {approved:true,reason:'依据充分'};}};
 const memoryTasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes:new Map()}),registry=createRegistry();registry.install(memoryTasks.extension);const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{
  const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'s3',answerEntryId:'a3',completedRuns:3,messageCount:6,toolCallCount:15};await repo.recordTurn(ref);
  const source={conversationId:ref.conversationId,entryId:'e1'},snapshot={entries:[{id:'e1',role:'user',text:'核对交期',sources:[source]}],trace:[{name:'crm_search',arguments:{resource:'companies'},result:'{}',sources:[source]}]};
  const id=await memoryTasks.schedule(harness,ref,snapshot,'harvest');await harness.waitForTask(id,context);
  assert.deepEqual(events,['generate','review']);const candidates=await repo.listSkillCandidates(ref.conversationId);assert.equal(candidates.length,1);assert.equal(candidates[0].status,'reviewed');assert.equal((await repo.activeSkills()).length,0);
  await repo.publishSkill(candidates[0].id,candidates[0].digest);assert.equal((await repo.activeSkills()).length,1);
 }finally{await harness.close(context);await db.close();}
});

test('长对话的记忆提取保留来源编号并限制发送给模型的内容',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test'});let sent;
 const tasks=createMemoryTasks({repo,gateway:{extract:async input=>{sent=JSON.parse(input);return {items:[]};}},ready:()=>true,prefixes:new Map()}),registry=createRegistry();registry.install(tasks.extension);const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'long',answerEntryId:'a'},snapshot={entries:Array.from({length:30},(_,i)=>({id:'e'+i,role:'user',text:'长'.repeat(5000),sources:[{conversationId:String(conversation.id),entryId:'e'+i}]}))};const id=await tasks.schedule(harness,ref,snapshot,'writer');await harness.waitForTask(id,context);assert.ok(sent.reduce((n,item)=>n+item.text.length,0)<=32000);assert.equal(sent.at(-1).id,'e29');assert.ok(sent.every(item=>item.text.length<=4000));}finally{await harness.close(context);await db.close();}
});

test('记忆提取时由模型比较相似内容，冲突或比较失败都交给用户确认',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test'}),registry=createRegistry();let comparison=0;
 const gateway={extract:async()=>({items:[{kind:'reference',content:'客户交期是三周',sourceEntryIds:['e1']}]}),compareMemory:async input=>{comparison++;const existing=JSON.parse(input).existing;return {relations:existing.map(item=>({id:item.id,relation:'conflict',reason:'交期不同'}))};}};
 const tasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes:new Map()});registry.install(tasks.extension);const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'conflict',answerEntryId:'a'},source={conversationId:ref.conversationId,entryId:'e1'},snapshot={entries:[{id:'e1',role:'user',text:'客户交期是三周',sources:[source]}]};await repo.save({operationKey:'old',kind:'reference',content:'客户交期是两周',sources:[source]});
  const id=await tasks.schedule(harness,ref,snapshot,'writer');await harness.waitForTask(id,context);const pending=await repo.list({status:'pending'});assert.equal(comparison,1);assert.equal(pending.length,1);assert.equal(pending[0].conflicts[0].reason,'交期不同');assert.ok((await repo.search('客户交期是三周')).items.every(item=>item.content!=='客户交期是三周'));
  gateway.compareMemory=async()=>{throw Error('model unavailable');};gateway.extract=async()=>({items:[{kind:'reference',content:'客户交期是五周',sourceEntryIds:['e1']}]});const next={...ref,submissionId:'conflict2'};const second=await tasks.schedule(harness,next,snapshot,'writer');await harness.waitForTask(second,context);assert.equal((await repo.list({status:'pending'})).length,2);
 }finally{await harness.close(context);await db.close();}
});
test('用户已有待确认记忆时后台提取不会把相同内容直接保存为已确认',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test'}),gateway={extract:async()=>({items:[{kind:'project',content:'客户偏好一周交货',sourceEntryIds:['e1']}]})},tasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes:new Map()}),registry=createRegistry();registry.install(tasks.extension);const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'duplicate',answerEntryId:'a'},source={conversationId:ref.conversationId,entryId:'e1'};await repo.save({operationKey:'manual-proposal',kind:'project',content:'客户偏好一周交货',status:'pending',sources:[source]});const id=await tasks.schedule(harness,ref,{entries:[{id:'e1',role:'user',text:'请记住客户偏好一周交货',sources:[source]}]},'writer');await harness.waitForTask(id,context);assert.equal((await repo.list({status:'pending'})).length,1);assert.equal((await repo.list({status:'active'})).length,0);}finally{await harness.close(context);await db.close();}
});

test('重复提取相同的待确认记忆会保留新来源，重复执行不会重复添加',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test'}),gateway={extract:async()=>({items:[{kind:'project',content:'客户偏好一周交货',sourceEntryIds:['e2']}]})},tasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes:new Map()}),registry=createRegistry();registry.install(tasks.extension);const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'duplicate-source',answerEntryId:'a'},first={conversationId:ref.conversationId,entryId:'e1'},second={conversationId:ref.conversationId,entryId:'e2'};const item=await repo.save({operationKey:'manual-proposal',kind:'project',content:'客户偏好一周交货',status:'pending',sources:[first]});const id=await tasks.schedule(harness,ref,{entries:[{id:'e2',role:'user',text:'客户偏好一周交货',sources:[second]}]},'writer');await harness.waitForTask(id,context);
  const saved=await repo.get(item.id);assert.equal(saved.status,'pending');assert.equal(saved.version,2);assert.deepEqual(new Set(saved.sources.map(source=>source.entry_id)),new Set(['e1','e2']));assert.equal((await repo.list({status:'pending'})).length,1);assert.equal(await repo.operationExists('duplicate-source:writer:0'),true);await tasks.schedule(harness,ref,{entries:[]},'writer');assert.equal((await repo.get(item.id)).sources.length,2);
 }finally{await harness.close(context);await db.close();}
});

test('重复提取不能绕过已确认内容的新来源审核，也不能合并不同类别',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test'}),gateway={extract:async()=>({items:[{kind:'reference',content:'客户偏好一周交货',sourceEntryIds:['e2']}]})},tasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes:new Map()}),registry=createRegistry();registry.install(tasks.extension);const harness=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);
 try{const conversation=await harness.root(context),ref={conversationId:String(conversation.id),piConversationId:conversation.id,submissionId:'duplicate-active',answerEntryId:'a'},first={conversationId:ref.conversationId,entryId:'e1'},second={conversationId:ref.conversationId,entryId:'e2'};const active=await repo.save({operationKey:'old',kind:'reference',content:'客户偏好一周交货',sources:[first]});const id=await tasks.schedule(harness,ref,{entries:[{id:'e2',role:'user',text:'客户偏好一周交货',sources:[second]}]},'writer');await harness.waitForTask(id,context);
  assert.equal((await repo.get(active.id)).sources.length,1);const pending=await repo.list({status:'pending'});assert.equal(pending.length,1);assert.equal(pending[0].conflicts[0].id,active.id);
  const other=await repo.save({operationKey:'other-kind',kind:'feedback',content:'客户偏好一周交货',status:'pending',sources:[first]});await assert.rejects(repo.mergeExactPending({id:other.id,expectedVersion:1,operationKey:'different-kind',kind:'project',content:'客户偏好一周交货',sources:[second]}),/VERSION_CONFLICT/);
 }finally{await harness.close(context);await db.close();}
});
