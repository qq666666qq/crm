import {test} from 'node:test';import assert from 'node:assert/strict';
import {Harness,MemoryStorage,createRegistry} from '@earendil-works/pi-durable';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {createEvolutionStore} from './evolution-store.mjs';

test('恢复时使用同一运行编号不会重复保存结果或覆盖人工选择',async()=>{
 const harness=await Harness.open(new MemoryStorage(),{registry:createRegistry(),models:createModels()},context);
 try{const root=await harness.root(context),store=createEvolutionStore(harness,async()=>true),id='f1dd6840-768d-4a20-b951-6c45acdc20c9',result={baselineTraceId:'1',baseline:'原回答',candidate:'候选回答'};
  const first=await store.save(root.id,result,[],id);await store.decide(root.id,id,first.version,'baseline');const retried=await store.save(root.id,result,[],id);
  assert.equal(retried.decision,'baseline');assert.equal(retried.version,2);assert.equal((await store.list(root.id,'1')).length,1);
 }finally{await harness.close(context);}
});
