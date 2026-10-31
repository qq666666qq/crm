import {test} from 'node:test';import assert from 'node:assert/strict';
import {Harness,MemoryStorage,createRegistry} from '@earendil-works/pi-durable';
import {createModels} from '@earendil-works/pi-ai/models';import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {openNodeSqliteDatabase} from '@earendil-works/pi-durable/storage/sqlite/node';
import {SqliteStorage} from '@earendil-works/pi-durable/storage/sqlite';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createMemoryRepository} from './repository.mjs';import {createMemoryTasks} from './tasks.mjs';import {createTurnCoordinator} from './turn-coordinator.mjs';

test('Pi 对话完成后自动调度反思，重复补查不重复生成',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),repo=await createMemoryRepository(db,{scope:'test'}),faux=fauxProvider(),model=faux.getModel(),models=createModels();models.setProvider(faux.provider);let calls=0;
 const gateway={reflect:async text=>{calls++;return {should_reflect:true,lesson:'核对客户需求',sourceEntryIds:[JSON.parse(text)[0].id]};},extract:async()=>({items:[]})};
 const memoryTasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes:new Map()}),registry=createRegistry(),storage=new MemoryStorage();registry.install(memoryTasks.extension);
 const harness=await Harness.open(storage,{registry,models},context);let coordinator;
 try{
  const root=await harness.root(context,{agent:{model:{provider:model.provider,modelId:model.id},extensions:[]}}),known=()=>new Map([[String(root.id),root.id]]);
  coordinator=await createTurnCoordinator({harness,storage,repo,memoryTasks,knownConversations:known});
  faux.setResponses([fauxAssistantMessage('已核对需求')]);const sub=await root.submit({type:'input',content:'请核对客户需求'},context);await sub.wait(context);
  await new Promise(resolve=>setImmediate(resolve));await coordinator.drain();
  const job=(await repo.tasks(String(root.id))).find(x=>x.kind==='reflection');assert.ok(job?.task_id);await harness.waitForTask(Number(job.task_id),context);
  assert.equal((await repo.search('核对客户需求')).items.length,1);assert.equal(calls,1);
  await coordinator.close();coordinator=await createTurnCoordinator({harness,storage,repo,memoryTasks,knownConversations:known});await coordinator.drain();assert.equal(calls,1);
 }finally{await coordinator?.close();await harness.close(context);await db.close();}
});

test('对话提交后进程退出，重启会补查且只保存一次反思',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-memory-recovery-')),file=path.join(dir,'session.sqlite'),faux=fauxProvider(),model=faux.getModel(),models=createModels();models.setProvider(faux.provider);let calls=0;
 const gateway={reflect:async text=>{calls++;return {should_reflect:true,lesson:'恢复后核对交期',sourceEntryIds:[JSON.parse(text)[0].id]};},extract:async()=>({items:[]})};
 async function open(){const db=await openNodeSqliteDatabase(file),repo=await createMemoryRepository(db,{scope:'test'}),memoryTasks=createMemoryTasks({repo,gateway,ready:()=>true,prefixes:new Map()}),registry=createRegistry();registry.install(memoryTasks.extension);const storage=await SqliteStorage.open(db),harness=await Harness.open(storage,{registry,models},context),root=await harness.root(context,{agent:{model:{provider:model.provider,modelId:model.id},extensions:[]}}),knownConversations=()=>new Map([[String(root.id),root.id]]);return {repo,memoryTasks,storage,harness,root,knownConversations};}
 try{
  let app=await open(),coordinator=await createTurnCoordinator(app);await coordinator.close();faux.setResponses([fauxAssistantMessage('收到')]);const submission=await app.root.submit({type:'input',content:'请核对交期'},context);await submission.wait(context);await app.harness.close(context);
  app=await open();coordinator=await createTurnCoordinator(app);await coordinator.drain();const job=(await app.repo.tasks(String(app.root.id))).find(item=>item.kind==='reflection');assert.ok(job?.task_id);await app.harness.waitForTask(Number(job.task_id),context);assert.equal((await app.repo.search('恢复后核对交期')).items.length,1);await coordinator.close();await app.harness.close(context);
  app=await open();coordinator=await createTurnCoordinator(app);await coordinator.drain();assert.equal(calls,1);assert.equal((await app.repo.search('恢复后核对交期')).items.length,1);await coordinator.close();await app.harness.close(context);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('恢复监听可先准备，启动前不处理已完成的对话',async()=>{
 let listener,items=[],processed=0,resumes=0;
 const submission={id:1,conversationId:1,type:'input',status:'done',entry:1,answer:2};
 const entries=[{id:1,kind:'pi.user',model:[{content:'问题'}]},{id:2,kind:'pi.assistant',model:[{content:'回答'}]}];
 const storage={scanSubmissions:async()=>({items,next:null})};
 const harness={subscribeCommits:fn=>{listener=fn;return()=>{};},conversation:async()=>({entries:async()=>({items:entries,next:null})}),resume:()=>{resumes++;}};
 const repo={metadata:async()=>undefined,recordTurn:async()=>{processed++;return {created_at:new Date().toISOString()};},queueTask:async()=>{},finishSkipped:async()=>{}};
 const memoryTasks={schedule:async()=>{}};
 const coordinator=await createTurnCoordinator({harness,storage,repo,memoryTasks,knownConversations:()=>new Map([['1',1]]),autoStart:false});
 try{items=[submission];listener({changes:[{type:'submission',value:submission}]});await new Promise(resolve=>setImmediate(resolve));await coordinator.drain();assert.equal(processed,0);assert.equal(resumes,0);coordinator.start();await coordinator.drain();assert.equal(processed,1);assert.equal(resumes,1);}
 finally{await coordinator.close();}
});
