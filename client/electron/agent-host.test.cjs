const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createAgentHost}=require('./agent-host.cjs');

function fixture(){
 const timers=new Map(),children=[],statuses=[];let sequence=0;
 const state={authenticated:true,generation:1,privateMode:false};
 const setTimer=(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;};
 const clearTimer=id=>timers.delete(id);
 const launch=()=>{const child=new EventEmitter();child.sent=[];child.postMessage=value=>child.sent.push(value);child.kill=()=>{child.killed=true;};children.push(child);return {child};};
 const host=createAgentHost({session:()=>({...state}),launch,onStatus:value=>statuses.push(value),setTimer,clearTimer,makeId:()=> 'request-1'});
 const fire=ms=>{const entry=[...timers].find(([,item])=>item.ms===ms);assert.ok(entry,`missing timer ${ms}`);timers.delete(entry[0]);entry[1].fn();};
 return {host,state,children,statuses,timers,fire};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('停止后等待旧工作进程真正退出，才重新启动',async()=>{
 const f=fixture(),first=await f.host.start();first.emit('message',{type:'ready'});f.host.stop();
 const restarting=f.host.start();await tick();assert.equal(f.children.length,1);f.fire(10000);assert.equal(first.killed,true);assert.equal(f.children.length,1);
 first.emit('exit',0);await restarting;assert.equal(f.children.length,2);
 f.host.stop();f.children[1].emit('exit',0);await f.host.stopped();
});

test('异常退出按上限退避重启，连续失败后停止',async()=>{
 const f=fixture();let child=await f.host.start();child.emit('message',{type:'ready'});
 for(const delay of [1000,2000,4000]){child.emit('exit',1);f.fire(delay);await tick();child=f.children.at(-1);child.emit('message',{type:'ready'});}
 child.emit('exit',1);assert.equal(f.children.length,4);assert.equal(f.statuses.at(-1).reason,'RETRY_EXHAUSTED');assert.equal(f.timers.size,0);
});

test('切换账号取消旧会话的自动恢复',async()=>{
 const f=fixture(),first=await f.host.start();first.emit('message',{type:'ready'});first.emit('exit',1);assert.ok([...f.timers.values()].some(item=>item.ms===1000));
 f.state.generation++;f.host.stop();assert.equal(f.timers.size,0);await tick();assert.equal(f.children.length,1);
});

test('存储故障先停止旧进程，再安排恢复',async()=>{
 const f=fixture(),first=await f.host.start();first.emit('message',{type:'ready'});first.emit('message',{type:'runtime-failed'});
 assert.ok(first.sent.some(item=>item.type==='close'));assert.equal(f.children.length,1);assert.equal([...f.timers.values()].some(item=>item.ms===1000),false);
 first.emit('exit',0);await tick();f.fire(1000);await tick();assert.equal(f.children.length,2);
 f.host.stop();f.children[1].emit('exit',0);await f.host.stopped();
});

test('临时会话异常退出时不自动重建丢失的会话',async()=>{
 const f=fixture();f.state.privateMode=true;const first=await f.host.start();first.emit('message',{type:'ready'});first.emit('exit',1);
 assert.equal(f.statuses.at(-1).reason,'PRIVATE_SESSION_LOST');assert.equal(f.timers.size,0);assert.equal(f.children.length,1);
});


test('启动超时会停止未就绪的进程并报告失败',async()=>{
 const f=fixture(),child=await f.host.start();f.fire(20000);
 assert.equal(f.statuses.at(-1).reason,'STARTUP_TIMEOUT');assert.ok(child.sent.some(item=>item.type==='close'));
 child.emit('exit',0);await f.host.stopped();
});


test('恢复后短时间内的成功请求不会清除崩溃次数',async()=>{
 const f=fixture();let child=await f.host.start();child.emit('message',{type:'ready'});
 for(const delay of [1000,2000,4000]){
  child.emit('exit',1);f.fire(delay);await tick();child=f.children.at(-1);child.emit('message',{type:'ready'});
  const response=f.host.request('presets');await tick();child.emit('message',{id:'request-1',data:[]});await response;
 }
 child.emit('exit',1);assert.equal(f.statuses.at(-1).reason,'RETRY_EXHAUSTED');assert.equal(f.timers.size,0);
});


test('等待超时只结束等待，续接保留用户请求标识',async()=>{
 const f=fixture(),child=await f.host.start(),requestId='12345678-1234-1234-1234-123456789abc';child.emit('message',{type:'ready'});
 const first=f.host.request('chat',{text:'问题',requestId});await tick();f.fire(120000);await assert.rejects(first,/暂时不可用/);
 assert.equal(child.sent.filter(item=>item.type==='close').length,0);
 const second=f.host.request('chat',{text:'问题',requestId});await tick();assert.deepEqual(child.sent.filter(item=>item.type==='chat').map(item=>item.requestId),[requestId,requestId]);child.emit('message',{id:'request-1',data:{answer:'回答'}});assert.equal((await second).answer,'回答');
 f.host.stop();child.emit('exit',0);await f.host.stopped();
});
