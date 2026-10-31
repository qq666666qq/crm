import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {createModels} from '@earendil-works/pi-ai/models';
import {SqliteStorage} from '@earendil-works/pi-durable/storage/sqlite';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {openEncryptedDatabase} from './encrypted-sqlite.mjs';
import {createTraceStore} from './trace-store.mjs';

const sample=id=>({id,kind:'chat',sessionId:'1',submissionId:id,started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z',status:'completed',userMessage:'示例问题',answer:'示例回答',generations:[{input:'完整上下文',output:'完整回复'}],toolCalls:[]});
const target='a'.repeat(64),other='b'.repeat(64);
async function open(file){const db=await openEncryptedDatabase(file,'1'.repeat(64)),storage=await SqliteStorage.open(db),harness=await Harness.open(storage,{models:createModels(),registry:createRegistry()},context);return {db,storage,harness,store:createTraceStore(harness,storage)};}

test('轨迹存入已有 Pi 文档结构，重启后按导出目标恢复状态',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-trace-store-')),file=path.join(dir,'session.sqlite');let state;
 try{
  state=await open(file);const before=(await state.db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(x=>x.name);
  await state.store.save(sample('run-1'));await state.store.mark('run-1',target,'uploaded');
  assert.equal(await state.store.hasSubmission('1','run-1'),true);
  const after=(await state.db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(x=>x.name);assert.deepEqual(after,before);
  await state.harness.close(context);state=null;state=await open(file);
  const same=await state.store.page({target,limit:5}),different=await state.store.page({target:other,limit:5});
  assert.equal(same.items[0].state,'uploaded');assert.equal(different.items[0].state,'pending');
  assert.equal(same.items[0].detail.generations[0].input,'完整上下文');
 }finally{if(state)await state.harness.close(context);try{await rm(dir,{recursive:true,force:true});}catch{}}
});

test('分页、重复保存和记录冲突均有明确结果',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-trace-page-')),file=path.join(dir,'session.sqlite');let state;
 try{state=await open(file);for(let i=0;i<5;i++)await state.store.save(sample('run-'+i));await state.store.save(sample('run-0'));
  await assert.rejects(state.store.save({...sample('run-0'),answer:'另一内容'}),/TRACE_ID_CONFLICT/);
  const first=await state.store.page({target,limit:2});assert.equal(first.items.length,2);assert.ok(first.next);
  const second=await state.store.page({target,limit:2,cursor:first.next});assert.equal(second.items.length,2);assert.notEqual(first.items[0].detail.id,second.items[0].detail.id);
  await state.store.mark(first.items[0].detail.id,target,'partial','LANGFUSE_PARTIAL_FAILURE');
  assert.equal((await state.store.get(first.items[0].detail.id,target)).state,'partial');
 }finally{if(state)await state.harness.close(context);try{await rm(dir,{recursive:true,force:true});}catch{}}
});
