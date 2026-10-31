import {test} from 'node:test';import assert from 'node:assert/strict';
import {openNodeSqliteDatabase} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createMemoryRepository} from './repository.mjs';import {createMemorySearch} from './search.mjs';

test('双路检索可找到语义相关记忆，且不向模型发送无权访问的内容',async()=>{
 const db=await openNodeSqliteDatabase(':memory:'),sent=[];let revoked=false;
 try{
  const repo=await createMemoryRepository(db,{scope:'a',authorize:async(_resource,id)=>!revoked||id!=='denied'});
  await repo.save({operationKey:'1',kind:'project',content:'客户希望下月发货',sources:[{conversationId:'c',entryId:'e'}]});
  await repo.save({operationKey:'2',kind:'project',content:'受限客户秘密',sources:[{conversationId:'c',entryId:'e2',resource:'companies',resourceId:'denied'}]});
  revoked=true;
  const search=createMemorySearch({repo,enabled:()=>true,embed:async texts=>{sent.push(...texts);return texts.map(()=>[1,0]);}});
  const result=await search('交付时间');assert.equal(result.mode,'hybrid');assert.equal(result.items[0].content,'客户希望下月发货');assert.equal(sent.some(value=>value.includes('受限')),false);
  const failed=createMemorySearch({repo,enabled:()=>true,embed:async()=>{throw Error('offline');}});const fallback=await failed('发货');assert.equal(fallback.mode,'keyword');assert.equal(fallback.items.length,1);assert.equal(fallback.reason,'unavailable');
 }finally{await db.close();}
});
test('语义请求被取消时回退到本地关键词结果',async()=>{const db=await openNodeSqliteDatabase(':memory:');try{const repo=await createMemoryRepository(db,{scope:'test'});await repo.save({operationKey:'one',kind:'project',content:'订单下月发货',sources:[{conversationId:'c',entryId:'e'}]});const controller=new AbortController();controller.abort();const search=createMemorySearch({repo,enabled:()=>true,embed:async(_texts,_model,signal)=>{if(signal.aborted)throw Error('ABORTED');return [[1,0]];}});const result=await search('下月发货',{signal:controller.signal});assert.equal(result.mode,'keyword');assert.equal(result.reason,'unavailable');assert.equal(result.items[0].content,'订单下月发货');}finally{await db.close();}});
