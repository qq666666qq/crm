import {test} from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';import {mkdtemp,rm,access,readFile,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
test('独立进程恢复 SQLite 会话并拒绝未开放的操作',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'crm-worker-'));const run=()=>new Promise((resolve,reject)=>{const child=fork(new URL('./worker.mjs',import.meta.url),[],{env:{...process.env,CRM_AGENT_DATA_DIR:dir,CRM_AGENT_PRIVATE:'0'},stdio:['ignore','ignore','ignore','ipc']});child.send({type:'initialize',key:'1'.repeat(64)});let id;child.on('message',m=>{if(m.type==='ready'){id=m.conversationId;child.send({type:'shell',id:'1'});}else if(m.id==='1'){assert.equal(m.error,'UNSUPPORTED_OPERATION');child.send({type:'close'});}});child.on('error',reject);child.on('exit',code=>code===0?resolve(id):reject(new Error(`exit ${code}`)));});try{const one=await run(),two=await run();assert.ok(one!=null);assert.equal(one,two);}finally{await rm(dir,{recursive:true,force:true});}});
test('临时对话模式不创建会话数据库且重启后开启新会话',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'crm-private-'));const run=()=>new Promise((resolve,reject)=>{const child=fork(new URL('./worker.mjs',import.meta.url),[],{env:{...process.env,CRM_AGENT_DATA_DIR:dir,CRM_AGENT_PRIVATE:'1'},stdio:['ignore','ignore','ignore','ipc']});let id;child.on('message',m=>{if(m.type==='ready'){id=m.conversationId;child.send({type:'close'});}});child.on('error',reject);child.on('exit',code=>code===0?resolve(id):reject(Error(`exit ${code}`)));});try{const first=await run(),second=await run();assert.ok(first!=null&&second!=null);await assert.rejects(access(path.join(dir,'session.sqlite')),{code:'ENOENT'});}finally{await rm(dir,{recursive:true,force:true});}});
test('初始化之前收到的请求会等到运行时就绪',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'crm-early-'));try{await new Promise((resolve,reject)=>{const child=fork(new URL('./worker.mjs',import.meta.url),[],{env:{...process.env,CRM_AGENT_DATA_DIR:dir,CRM_AGENT_PRIVATE:'1'},stdio:['ignore','ignore','ignore','ipc']});const timer=setTimeout(()=>{child.kill();reject(Error('等待超时'));},10000);child.send({type:'presets',id:'early'});child.on('message',m=>{if(m.id==='early'){try{assert.equal(m.data.length,3);child.send({type:'close'});}catch(e){child.kill();reject(e);}}});child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`exit ${code}`));});});}finally{await rm(dir,{recursive:true,force:true});}});
test('连续到达的对话请求不会相互覆盖运行记录',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-worker-busy-'));
 try{await new Promise((resolve,reject)=>{
  const child=fork(new URL('./worker.mjs',import.meta.url),[],{env:{...process.env,OPENAI_API_KEY:'',CRM_AGENT_DATA_DIR:dir,CRM_AGENT_PRIVATE:'1'},stdio:['ignore','ignore','ignore','ipc']});
  const replies=new Set(),details=[],saved=new Map();const timer=setTimeout(()=>{child.kill();reject(Error('等待超时'));},10000);
  child.on('message',message=>{
   if(message.type==='ready'){child.send({type:'chat',id:'first',text:'第一条'});child.send({type:'chat',id:'second',text:'第二条'});}
   if(message.type==='run-detail-ready')details.push(message.id);
   if(['first','second'].includes(message.id)){replies.add(message.id);if(replies.size===2)for(const id of details)child.send({type:'trace-get',id:'detail:'+id,value:{id,target:'a'.repeat(64)}});}
   if(typeof message.id==='string'&&message.id.startsWith('detail:')){saved.set(message.id.slice(7),message.data?.detail);if(saved.size===details.length)child.send({type:'close'});}
  });
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);try{assert.equal(code,0);assert.ok(details.length>=1&&details.length<=2);assert.deepEqual(details.map(id=>saved.get(id).userMessage),details.length===1?['第一条']:['第一条','第二条']);resolve();}catch(error){reject(error);}});
 });}finally{await rm(dir,{recursive:true,force:true});}
});

test('临时工作进程重启后不保留执行状态，也不触碰持久记录',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-private-worker-trace-')),file=path.join(dir,'runs.jsonl');
 const original=JSON.stringify({event:'started',id:'existing',at:'2026-01-01T00:00:00.000Z',kind:'chat'})+'\n';
 async function run(chat){return new Promise((resolve,reject)=>{
  const child=fork(new URL('./worker.mjs',import.meta.url),[],{env:{...process.env,OPENAI_API_KEY:'',CRM_AGENT_DATA_DIR:dir,CRM_AGENT_PRIVATE:'1'},stdio:['ignore','ignore','ignore','ipc']});
  let result;const timer=setTimeout(()=>{child.kill();reject(Error('等待超时'));},10000);
  child.on('message',message=>{
   if(message.type==='ready')child.send(chat?{type:'chat',id:'chat',text:'测试'}:{type:'traces',id:'list'});
   if(message.id==='chat')child.send({type:'traces',id:'list'});
   if(message.id==='list'){result=message.data;child.send({type:'close'});}
  });
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve(result):reject(Error(`exit ${code}`));});
 });}
 try{await writeFile(file,original,'utf8');const first=await run(true),second=await run(false);assert.equal(first.length,1);assert.equal(first[0].status,'failed');assert.deepEqual(second,[]);assert.equal(await readFile(file,'utf8'),original);}
 finally{await rm(dir,{recursive:true,force:true});}
});


test('收到关闭时先完成已接收对话的状态和轨迹，再拒绝新工作',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'crm-worker-close-'));
 try{await new Promise((resolve,reject)=>{
  const child=fork(new URL('./worker.mjs',import.meta.url),[],{env:{...process.env,OPENAI_API_KEY:'',CRM_AGENT_DATA_DIR:dir,CRM_AGENT_PRIVATE:'1'},stdio:['ignore','ignore','ignore','ipc']});const seen=[];const timer=setTimeout(()=>{child.kill();reject(Error('等待超时'));},10000);
  child.on('message',message=>{seen.push(message);if(message.type==='ready'){child.send({type:'chat',id:'before',text:'待关闭对话'});child.send({type:'close'});child.send({type:'presets',id:'after'});}});
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);try{assert.equal(code,0);assert.ok(seen.some(m=>m.id==='before'&&m.error));assert.ok(seen.some(m=>m.type==='run-detail-ready'));assert.equal(seen.some(m=>m.id==='after'&&m.data),false);resolve();}catch(error){reject(error);}});
 });}finally{await rm(dir,{recursive:true,force:true});}
});
