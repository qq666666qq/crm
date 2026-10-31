import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
import {openRuntime} from './runtime.mjs';import {migrateLegacySession} from './legacy-migration.mjs';

test('原会话迁入加密库并保留原文件',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-pi-migrate-'));
 const old=path.join(dir,'conversations.sqlite'),target=path.join(dir,'conversations.encrypted.sqlite'),key='1'.repeat(64),faux=fauxProvider(),model=faux.getModel(),options={modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true};
 try{
  faux.setResponses([fauxAssistantMessage('原始回答')]);let runtime=await openRuntime(old,options);await runtime.chat('原始问题');await runtime.close();
  assert.equal((await migrateLegacySession(old,target,key)).migrated,true);
  await access(old);runtime=await openRuntime(target,{...options,databaseKey:key});assert.ok((await runtime.history()).some(x=>x.text==='原始问题'));await runtime.close();
  assert.equal((await migrateLegacySession(old,target,key)).migrated,false);
 }finally{try{await rm(dir,{recursive:true,force:true});}catch{}}
});

test('加密目标已有会话时明确报告并保留两边数据',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-pi-migrate-existing-')),old=path.join(dir,'conversations.sqlite'),target=path.join(dir,'conversations.encrypted.sqlite'),key='3'.repeat(64),faux=fauxProvider(),model=faux.getModel(),options={modelProvider:faux.provider,modelSelection:{provider:model.provider,modelId:model.id},modelReady:()=>true};
 try{faux.setResponses([fauxAssistantMessage('旧回答'),fauxAssistantMessage('新回答')]);let runtime=await openRuntime(old,options);await runtime.chat('旧对话');await runtime.close();runtime=await openRuntime(target,{...options,databaseKey:key});await runtime.chat('已有加密对话');await runtime.close();
  assert.deepEqual(await migrateLegacySession(old,target,key),{migrated:false,reason:'existing_target'});
  runtime=await openRuntime(target,{...options,databaseKey:key});assert.ok((await runtime.history()).some(item=>item.text==='已有加密对话'));await runtime.close();runtime=await openRuntime(old,options);assert.ok((await runtime.history()).some(item=>item.text==='旧对话'));await runtime.close();
 }finally{try{await rm(dir,{recursive:true,force:true});}catch{}}
});
