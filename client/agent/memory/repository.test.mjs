import {test} from 'node:test';import assert from 'node:assert/strict';
import {openNodeSqliteDatabase} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createMemoryRepository} from './repository.mjs';

test('记忆按账号隔离、支持中文检索，并在客户权限撤销后隐藏',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');let allowed=true;
 try{
  const a=await createMemoryRepository(db,{scope:'account-a',authorize:async()=>allowed});
  const b=await createMemoryRepository(db,{scope:'account-b',authorize:async()=>true});
  const saved=await a.save({operationKey:'turn-1',kind:'project',content:'客户计划采购厨房设备',sources:[{conversationId:'c1',entryId:'e1',resource:'companies',resourceId:'company-1'}]});
  assert.equal((await a.search('采购厨房')).items[0].id,saved.id);
  assert.equal((await b.search('采购厨房')).items.length,0);
  assert.equal((await a.save({operationKey:'turn-1',kind:'project',content:'重复',sources:[]})).id,saved.id);
  allowed=false;assert.equal(await a.get(saved.id),null);assert.equal((await a.search('采购厨房')).items.length,0);
  allowed=true;await assert.rejects(a.update(saved.id,2,{content:'新内容'}),/VERSION_CONFLICT/);
 }finally{await db.close();}
});

test('Skill 提醒严格要求超过五条消息和十五次工具调用，并限制重复提醒',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{
  const repo=await createMemoryRepository(db,{scope:'account'});
  const ref={conversationId:'c',answerEntryId:'a',completedRuns:3,messageCount:5,toolCallCount:15};
  assert.equal((await repo.recordTurn({...ref,submissionId:'1'})).harvest_status,'none');
  assert.equal((await repo.recordTurn({...ref,submissionId:'2',messageCount:6})).harvest_status,'eligible');
  assert.equal((await repo.recordTurn({...ref,submissionId:'3',messageCount:6,toolCallCount:16})).harvest_status,'none');
  assert.equal((await repo.recordTurn({...ref,submissionId:'4',messageCount:6,toolCallCount:30})).harvest_status,'eligible');
  assert.equal((await repo.recommendations('c')).length,2);
 }finally{await db.close();}
});

test('Skill 候选必须经过复审和用户确认，版本可回滚',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{
  const repo=await createMemoryRepository(db,{scope:'account'}),ref={conversationId:'c',submissionId:'s',answerEntryId:'a',completedRuns:3,messageCount:6,toolCallCount:15};await repo.recordTurn(ref);
  const candidate=await repo.createSkillCandidate(ref,{operation:'create',name:'核对交期',content:'先核对约定交期。',reason:'对话中反复确认',review:{approved:true,reason:'有来源'},sources:[{conversationId:'c',entryId:'e'}]});
  assert.equal((await repo.activeSkills()).length,0);await assert.rejects(repo.publishSkill(candidate.id,'bad'),/CANDIDATE_CONFLICT/);
  const version=await repo.publishSkill(candidate.id,candidate.digest);assert.equal(version.version,1);assert.equal((await repo.activeSkills())[0].content,'先核对约定交期。');
  const ref2={...ref,submissionId:'s2',toolCallCount:30};await repo.recordTurn(ref2);
  const revised=await repo.createSkillCandidate(ref2,{operation:'replace',name:'核对交期',content:'先核对交期和数量。',reason:'补充',review:{approved:true,reason:'有来源'},sources:[{conversationId:'c',entryId:'e'}]});
  await repo.publishSkill(revised.id,revised.digest);await repo.rollbackSkill(version.id,2);assert.equal((await repo.activeSkills())[0].content,'先核对约定交期。');
 }finally{await db.close();}
});

test('来源记忆删除后，其衍生记忆不会继续被检索',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{
  const repo=await createMemoryRepository(db,{scope:'account'}),parent=await repo.save({operationKey:'parent',kind:'reference',content:'客户要求两周交货',sources:[{conversationId:'c',entryId:'e'}]});
  await repo.save({operationKey:'child',kind:'reflection',content:'应先核对两周交期',sources:[{conversationId:'c',entryId:'e2',parentMemoryId:parent.id,parentVersion:1}]});
  assert.equal((await repo.search('核对两周')).items.length,1);await repo.update(parent.id,1,{status:'deleted'});
  assert.equal((await repo.search('核对两周')).items.length,0);
 }finally{await db.close();}
});

test('拒绝 Skill 候选后不能发布，重复拒绝安全且复审基线变化会被拒绝',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{
  const repo=await createMemoryRepository(db,{scope:'account'}),ref={conversationId:'c',submissionId:'one',answerEntryId:'a',completedRuns:3,messageCount:6,toolCallCount:15};await repo.recordTurn(ref);
  const input={operation:'create',name:'核对',content:'检查数量',reason:'依据',review:{approved:true,reason:'可用'},sources:[{conversationId:'c',entryId:'e'}],expectedActiveVersion:null};
  const candidate=await repo.createSkillCandidate(ref,input);await assert.rejects(repo.rejectSkill(candidate.id,'0'.repeat(64)),/CANDIDATE_CONFLICT/);
  await repo.rejectSkill(candidate.id,candidate.digest);await repo.rejectSkill(candidate.id,candidate.digest);await assert.rejects(repo.publishSkill(candidate.id,candidate.digest),/SKILL_REVIEW_REQUIRED/);
  const next={...ref,submissionId:'two',toolCallCount:30};await repo.recordTurn(next);const published=await repo.createSkillCandidate(next,input);await repo.publishSkill(published.id,published.digest);
  const third={...ref,submissionId:'three',toolCallCount:45};await repo.recordTurn(third);await assert.rejects(repo.createSkillCandidate(third,{...input,operation:'replace',expectedActiveVersion:2}),/VERSION_CONFLICT/);
 }finally{await db.close();}
});

test('待确认记忆显示有权限的相关内容，确认时检查旧记忆版本',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{
  let allowed=true;const repo=await createMemoryRepository(db,{scope:'account',authorize:async()=>allowed});
  const old=await repo.save({operationKey:'old',kind:'reference',content:'客户交期是两周',sources:[{conversationId:'c',entryId:'e',resource:'companies',resourceId:'company'}]});
  assert.equal((await repo.related('客户交期是三周'))[0].id,old.id);
  const candidate=await repo.save({operationKey:'new',kind:'reference',content:'客户交期是三周',sources:[{conversationId:'c',entryId:'e2'}],conflicts:[{id:old.id,version:1,reason:'交期不同'}]});
  let pending=(await repo.list({status:'pending'}))[0];assert.equal(pending.conflicts[0].content,'客户交期是两周');
  await repo.update(old.id,1,{content:'客户交期是四周'});await assert.rejects(repo.review(candidate.id,1,'accept',[{id:old.id,version:1,status:'active'}]),/VERSION_CONFLICT/);
  allowed=false;pending=(await repo.list({status:'pending'}))[0];assert.equal(pending.conflictCount,1);assert.equal(pending.conflicts.length,0);await assert.rejects(repo.review(candidate.id,1,'accept',[]),/VERSION_CONFLICT/);
  allowed=true;await repo.review(candidate.id,1,'accept',[{id:old.id,version:2,status:'active'}]);assert.equal((await repo.get(candidate.id)).status,'active');
 }finally{await db.close();}
});
test('记忆库以可恢复的增量方式升级旧版本，并拒绝未来版本',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{let repo=await createMemoryRepository(db,{scope:'account'});const item=await repo.save({operationKey:'old',kind:'project',content:'原有记忆',sources:[{conversationId:'c',entryId:'e'}]});await db.run('DROP TABLE memory_conflicts');await db.run('DROP TABLE memory_operation_aliases');await db.run('UPDATE crm_memory_schema SET version=1');repo=await createMemoryRepository(db,{scope:'account'});assert.equal((await db.get('SELECT version FROM crm_memory_schema')).version,3);assert.equal((await repo.get(item.id)).content,'原有记忆');await db.run('UPDATE crm_memory_schema SET version=999');await assert.rejects(createMemoryRepository(db,{scope:'account'}),/MEMORY_SCHEMA_UNSUPPORTED/);}finally{await db.close();}
});
test('相似的待确认记忆可以对照后分别处理，状态变化不能被旧确认覆盖',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{const repo=await createMemoryRepository(db,{scope:'account'}),source=[{conversationId:'c',entryId:'e'}];const first=await repo.save({operationKey:'first',kind:'project',content:'客户偏好一周交货',status:'pending',sources:source});const second=await repo.save({operationKey:'second',kind:'project',content:'客户偏好两周交货',sources:source,conflicts:[{id:first.id,version:1,reason:'交期不同'}]});let item=await repo.get(second.id);assert.equal(item.conflicts[0].status,'pending');await repo.review(first.id,1,'accept',[]);await assert.rejects(repo.review(second.id,1,'accept',[{id:first.id,version:1,status:'pending'}]),/VERSION_CONFLICT/);item=await repo.get(second.id);assert.equal(item.conflicts[0].status,'active');await repo.review(second.id,1,'accept',[{id:first.id,version:2,status:'active'}]);assert.equal((await repo.get(second.id)).status,'active');}finally{await db.close();}
});

test('相同待确认内容追加来源需要当前版本和来源权限，操作编号可安全重试',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{
  let allowed=true;const repo=await createMemoryRepository(db,{scope:'account',authorize:async()=>allowed});const source={conversationId:'c',entryId:'e1'};const item=await repo.save({operationKey:'first',kind:'project',content:'已约定两周交货',status:'pending',sources:[source]});
  const input={id:item.id,expectedVersion:1,operationKey:'duplicate',kind:'project',content:'已约定两周交货',sources:[{conversationId:'c',entryId:'e2',resource:'companies',resourceId:'a'}]};
  allowed=false;await assert.rejects(repo.mergeExactPending(input),/FORBIDDEN/);assert.equal((await repo.get(item.id)).version,1);
  allowed=true;await repo.mergeExactPending(input);assert.equal((await repo.get(item.id)).version,2);assert.equal((await repo.get(item.id)).sources.length,2);assert.equal(await repo.operationExists('duplicate'),true);
  await repo.mergeExactPending(input);assert.equal((await repo.get(item.id)).sources.length,2);await assert.rejects(repo.mergeExactPending({...input,operationKey:'stale'}),/VERSION_CONFLICT/);
  await repo.review(item.id,2,'accept',[]);await assert.rejects(repo.mergeExactPending({...input,expectedVersion:3,operationKey:'confirmed'}),/VERSION_CONFLICT/);
 }finally{await db.close();}
});

test('记忆管理逐页返回有权访问的完整记录，越过无权记录且不会跨账号',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{
  let writing=true;const repo=await createMemoryRepository(db,{scope:'account',authorize:async(_type,id)=>writing||id!=='hidden'}),other=await createMemoryRepository(db,{scope:'other',authorize:async()=>true});
  for(let i=0;i<240;i++)await repo.save({operationKey:'hidden-'+i,kind:'project',content:'不可见记录 '+i,status:'pending',sources:[{conversationId:'c',entryId:'h'+i,resource:'companies',resourceId:'hidden'}]});
  for(let i=0;i<35;i++)await repo.save({operationKey:'visible-'+i,kind:'project',content:'可见记录 '+i,status:'pending',sources:[{conversationId:'c',entryId:'v'+i}]});
  await other.save({operationKey:'other',kind:'project',content:'其他账号记录',status:'pending',sources:[{conversationId:'c',entryId:'x'}]});writing=false;
  const first=await repo.listPage({status:'pending',limit:20});assert.equal(first.items.length,20);assert.ok(first.nextCursor);const second=await repo.listPage({status:'pending',limit:20,cursor:first.nextCursor});assert.equal(second.items.length,15);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,35);assert.ok([...first.items,...second.items].every(item=>item.content.startsWith('可见')));
  await assert.rejects(repo.listPage({status:'pending',cursor:'invalid'}),/INVALID_QUERY/);
 }finally{await db.close();}
});

test('本地关键词可以从自然语言问题召回相关中文记忆，并过滤无关和无权内容',async()=>{
 const db=await openNodeSqliteDatabase(':memory:');try{
  let allowed=true;const repo=await createMemoryRepository(db,{scope:'account',authorize:async()=>allowed});
  await repo.save({operationKey:'relevant',kind:'project',content:'客户计划下个月交付厨房设备',sources:[{conversationId:'c',entryId:'e1'}]});
  await repo.save({operationKey:'unrelated',kind:'project',content:'客户下周准备参观工厂',sources:[{conversationId:'c',entryId:'e2'}]});
  await repo.save({operationKey:'private',kind:'project',content:'客户计划下个月交付机密样品',sources:[{conversationId:'c',entryId:'e3',resource:'companies',resourceId:'x'}]});allowed=false;
  const result=await repo.search('请问客户何时交付？');assert.ok(result.items.some(item=>item.content==='客户计划下个月交付厨房设备'&&item.match_type==='partial'));assert.ok(!result.items.some(item=>item.content.includes('参观工厂')||item.content.includes('机密')));
  const exact=(await repo.search('厨房设备')).items[0];assert.equal(exact.content,'客户计划下个月交付厨房设备');assert.equal(exact.match_type,'exact');
 }finally{await db.close();}
});
