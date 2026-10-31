const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createLangfuseQueue}=require('./langfuse-queue.cjs');

test('保留全部本次会话记录，成功后不重复上传',async()=>{
 let calls=0;const queue=createLangfuseQueue(async()=>{calls++;return {ok:true};});
 for(let i=0;i<150;i++)queue.add({id:String(i)});
 assert.equal(queue.pending(),150);
 const result=await queue.uploadAll();
 assert.equal(result.uploaded,150);assert.equal(result.failed,0);
 assert.equal(queue.all().length,150);assert.equal(queue.pending(),0);
 await queue.uploadAll();assert.equal(calls,150);
});

test('自动和手动上传相遇时只提交一次',async()=>{
 let calls=0,resolve;const waiting=new Promise(r=>{resolve=r;});
 const queue=createLangfuseQueue(async()=>{calls++;await waiting;return {ok:true};});
 queue.add({id:'one'});const first=queue.upload('one'),second=queue.uploadAll();
 resolve();await Promise.all([first,second]);assert.equal(calls,1);assert.equal(queue.pending(),0);
});

test('普通失败可重试，部分成功需要明确处理而不自动整条重传',async()=>{
 let calls=0;const queue=createLangfuseQueue(async()=>{calls++;return calls===1?{ok:false,error:'OFFLINE'}:calls===2?{ok:false,error:'LANGFUSE_PARTIAL_FAILURE'}:{ok:true};});
 queue.add({id:'one'});assert.equal((await queue.uploadAll()).failed,1);
 assert.equal(queue.lastError(),'OFFLINE');
 assert.equal((await queue.uploadAll()).lastError,'LANGFUSE_PARTIAL_FAILURE');
 assert.equal((await queue.uploadAll()).lastError,'LANGFUSE_PARTIAL_FAILURE');assert.equal(calls,2);
 assert.equal(queue.lastError(),'LANGFUSE_PARTIAL_FAILURE');
});

test('清除旧会话后，旧上传结果不会改变新会话的记录',async()=>{
 let resolve,calls=0;const waiting=new Promise(r=>{resolve=r;});
 const queue=createLangfuseQueue(async()=>{calls++;await waiting;return {ok:true};});
 queue.add({id:'same'});const old=queue.upload('same');queue.clear();queue.add({id:'same'});
 resolve();await old;assert.equal(queue.pending(),1);assert.equal(calls,0);
});

test('已经发出的旧请求结束后不能更新新会话的记录',async()=>{
 let resolve,started;const entered=new Promise(r=>{started=r;}),waiting=new Promise(r=>{resolve=r;});
 const queue=createLangfuseQueue(async()=>{started();await waiting;return {ok:true};});
 queue.add({id:'same'});const old=queue.upload('same');await entered;queue.clear();queue.add({id:'same'});
 resolve();await old;assert.equal(queue.pending(),1);
});

test('批量上传途中切换会话不会发送新会话的同名记录',async()=>{
 let resolve,started,calls=0;const entered=new Promise(r=>{started=r;}),waiting=new Promise(r=>{resolve=r;});
 const queue=createLangfuseQueue(async()=>{calls++;started();await waiting;return {ok:true};});
 queue.add({id:'first'});queue.add({id:'second'});const batch=queue.uploadAll();await entered;
 queue.clear();queue.add({id:'second'});resolve();await batch;
 assert.equal(calls,1);assert.equal(queue.pending(),1);
});
