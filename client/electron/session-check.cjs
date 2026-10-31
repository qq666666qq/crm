const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {makeTestStorage} = require('./test-safe-storage.cjs');

async function harness(initialSession=null, authFailure=null, dataDir='C:/agent-data', schedule=setTimeout, telemetrySender=null) {
  const handlers = new Map(), notices = [], streams = [], requests = [], externalUrls = [], workers = [], traceStores=new Map(); let saved=initialSession;
  let rejectNext = false, failLeadOnce=false, writeStatus=null, window;const createdLeads=new Map();
  class Window {
    constructor() { window = this; this.webContents = { send: (name, data) => notices.push([name, data]), on() {}, setWindowOpenHandler() {} }; }
    isDestroyed() { return false; } loadURL() {} loadFile() {} once() {} isMinimized() { return false; } show() {} focus() {}
  }
  const electron = { safeStorage:makeTestStorage(), app: {requestSingleInstanceLock:()=>true,whenReady: () => Promise.resolve(), on() {}, quit() {}, getPath: ()=>dataDir, isPackaged: false, commandLine: {hasSwitch: () => false}}, BrowserWindow: Window, Menu: {setApplicationMenu() {}}, shell: {openExternal: async url => externalUrls.push(url)}, utilityProcess:{fork:(_file,_args,options)=>{const child=new EventEmitter(),scope=options.env.CRM_AGENT_DATA_DIR;if(!traceStores.has(scope))traceStores.set(scope,{records:new Map(),states:new Map()});const store=traceStores.get(scope);child.options=options;child.sent=[];child.saveTrace=detail=>store.records.set(detail.id,detail);child.postMessage=m=>{child.sent.push(m);if(m.type==='close')setImmediate(()=>child.emit('exit',0));else if(m.type!=='crm-read-result'&&m.type!=='initialize')setImmediate(()=>{const v=m.value||{},key=v.target+':'+v.id;let data=[{id:'rag'}];if(m.type==='trace-page')data={items:[...store.records.keys()].map(id=>({id,...(store.states.get(v.target+':'+id)||{state:'pending'})})),next:null};else if(m.type==='trace-conversations')data=[];else if(m.type==='trace-get')data=store.records.has(v.id)?{detail:store.records.get(v.id),...(store.states.get(key)||{state:'pending'})}:null;else if(m.type==='trace-mark'){store.states.set(key,{state:v.state,error:v.error});data={ok:true};}child.emit('message',{id:m.id,data});});};child.kill=()=>child.emit('exit',0);workers.push(child);return child;}}, ipcMain: {handle: (name, handler) => handlers.set(name, handler)}, Notification: {isSupported: () => false} };
  const fetchMock = async (url, options) => {
    const pathname = url.pathname;
    requests.push({ pathname, headers: options.headers, signal: options.signal, method: options.method, body: options.body });
    if(writeStatus&&['POST','PATCH'].includes(options.method)&&!pathname.includes('/auth/'))return {ok:false,status:writeStatus,json:async()=>({error:{code:writeStatus===403?'FORBIDDEN':'VERSION_CONFLICT',message:'请求被拒绝'}})};
    if (authFailure && pathname.endsWith('/auth/tenants')) {if(authFailure==='offline') throw new Error('offline'); return {ok:false,status:401,json:async()=>({})};}
    if (pathname.endsWith('/auth/login')) return {ok:true,status:200,json:async()=>({access_token:'secret'})};
    if (pathname.endsWith('/auth/tenants')) return {ok:true,status:200,json:async()=>({items:[{id:'A'},{id:'B'}]})};
    if (pathname.endsWith('/auth/me')) return {ok:true,status:200,json:async()=>({tenant_id:options.headers['X-Tenant-ID'],user_id:'user-1'})};
    if (pathname.endsWith('/auth/register') || pathname.endsWith('/auth/join') || pathname.endsWith('/auth/password/change')) return {ok:true,status:200,json:async()=>({status:'ok'})};
    if (pathname.endsWith('/auth/logout')) return {ok:true,status:200,json:async()=>({})};
    if (pathname.endsWith('/leads') && options.method==='POST') {const key=options.headers['Idempotency-Key'];if(!createdLeads.has(key))createdLeads.set(key,{id:'created-lead'});if(failLeadOnce){failLeadOnce=false;throw Error('timeout after commit');}return {ok:true,status:201,json:async()=>createdLeads.get(key)};}
    if (pathname.endsWith('/companies') && options.method==='POST') return {ok:true,status:201,json:async()=>({id:'created-company'})};
    if (options.method==='POST' && (pathname.endsWith('/contacts')||pathname.endsWith('/opportunities')||pathname.endsWith('/follow-up-tasks')||pathname.endsWith('/activities'))) return {ok:true,status:201,json:async()=>({id:'created-record'})};
    if (pathname.endsWith('/companies') && url.search) return {ok:true,status:200,json:async()=>({items:[{name:'Example'}]})};
    if (pathname.endsWith('/sync/events')) {
      let emit;
      const stream = { signal:options.signal, emit: data => emit?.({done:false,value:new TextEncoder().encode(data)}), close:()=>emit?.({done:true}) };
      streams.push(stream);
      return {ok:true,status:200,body:{getReader:()=>({read:()=>new Promise((resolve,reject)=>{ emit=resolve; options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}); }),cancel:async()=>{}})}};
    }
    if (rejectNext) { rejectNext=false; return {ok:false,status:401,json:async()=>({error:{code:'UNAUTHORIZED',message:'expired'}})}; }
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  };
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'),'utf8');
  const context = {require: name => name==='electron' ? electron : name==='./langfuse-export.cjs' && telemetrySender ? {...require(name),uploadLangfuse:telemetrySender} : name==='./agent-key.cjs' ? {agentDatabaseKey:()=> '1'.repeat(64)} : name==='./session-cache.cjs' ? {sessionCache:()=>({save:(token,tenant)=>{saved={token,tenant};},load:()=>saved,clear:()=>{saved=null;}})} : name==='node:path' ? path : name==='node:crypto' ? crypto : require(name), __dirname, process:{env:{},platform:process.platform}, URL, AbortController, TextDecoder, TextEncoder, setTimeout:schedule, clearTimeout, fetch:fetchMock};
  vm.runInNewContext(source, context, {filename:'main.cjs'});
  await Promise.resolve();
  const event = {sender:window.webContents};
  const call = (name,...args) => handlers.get('crm:'+name)(event,...args);
  return {call, streams, requests, notices, externalUrls, workers, createdLeads, storage:electron.safeStorage, failLeadOnce:()=>{failLeadOnce=true;}, setWriteStatus:status=>{writeStatus=status;}, cached:()=>saved, rejectNext:()=>{rejectNext=true;}};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('Langfuse 上传实际模型与工具记录，企业切换清除当前待上传队列',async()=>{
 const sent=[];const h=await harness(null,null,'C:/agent-data',setTimeout,async payload=>{sent.push(payload);return {ok:true};});
 await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');
 await h.call('langfuse','config',{baseUrl:'https://example.test',publicKey:'public',secretKey:'secret',autoUpload:false});
 const updated=await h.call('langfuse','config',{baseUrl:'https://example.test',publicKey:'',secretKey:'',autoUpload:false});assert.equal(updated.configured,true);
 h.workers[0].emit('message',{type:'run-detail',detail:{id:'run-a',started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z',status:'completed',userMessage:'原始问题',answer:'完整回答',generations:[{input:[{role:'user',content:'原始问题'}],output:'完整回答',status:'ok'}],toolCalls:[{name:'search',args:{q:'客户'},output:'客户资料',status:'ok'}]}});
 assert.equal((await h.call('langfuse','status')).pending,1);
 const result=await h.call('langfuse','upload');assert.equal(result.uploaded,1);assert.equal((await h.call('langfuse','status')).pending,0);
 assert.match(JSON.stringify(sent[0]),/原始问题/);assert.match(JSON.stringify(sent[0]),/客户资料/);
 assert.equal((await h.call('langfuse','upload')).total,0);assert.equal(sent.length,1);
 await h.call('select-tenant','B');const switched=await h.call('langfuse','status');assert.equal(switched.pending,0);assert.equal(switched.configured,false);await h.call('logout');
});

test('Langfuse 从数据库读取轨迹，重新登录后仍可上传且成功状态保留',async()=>{
 const sent=[],h=await harness(null,null,'C:/agent-data',setTimeout,async payload=>{sent.push(payload);return {ok:true};});
 await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');
 h.workers[0].saveTrace({id:'saved-run',kind:'chat',started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z',status:'completed',userMessage:'历史问题',answer:'历史回答',generations:[{input:'模型原文',output:'回答',status:'ok'}],toolCalls:[{name:'search',args:{q:'客户'},output:'工具原文',status:'ok'}]});
 await h.call('logout');await h.call('login','person@example.com','password');await h.call('select-tenant','A');
 await h.call('langfuse','config',{baseUrl:'https://example.test',publicKey:'public',secretKey:'secret',autoUpload:false});
 assert.equal((await h.call('langfuse','status')).pending,1);assert.equal((await h.call('langfuse','upload')).uploaded,1);
 assert.match(JSON.stringify(sent),/历史问题/);assert.match(JSON.stringify(sent),/模型原文/);assert.match(JSON.stringify(sent),/工具原文/);
 await h.call('logout');await h.call('login','person@example.com','password');await h.call('select-tenant','A');
 await h.call('langfuse','config',{baseUrl:'https://example.test',publicKey:'public',secretKey:'secret',autoUpload:false});assert.equal((await h.call('langfuse','status')).pending,0);assert.equal(sent.length,1);await h.call('logout');
});

test('自动上传只在轨迹保存到数据库后读取该记录',async()=>{
 const sent=[],h=await harness(null,null,'C:/agent-data',setTimeout,async payload=>{sent.push(payload);return {ok:true};});
 await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');
 await h.call('langfuse','config',{baseUrl:'https://example.test',publicKey:'public',secretKey:'secret',autoUpload:true});
 const child=h.workers[0];child.saveTrace({id:'saved-auto',kind:'chat',started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z',status:'completed',userMessage:'已保存的问题',answer:'已保存的答案'});
 child.emit('message',{type:'run-detail-ready',id:'saved-auto'});
 for(let i=0;i<50&&sent.length===0;i++)await tick();
 assert.equal(sent.length,1);assert.match(JSON.stringify(sent),/已保存的问题/);
 for(let i=0;i<50&&(await h.call('langfuse','status')).pending;i++)await tick();
 assert.equal((await h.call('langfuse','status')).pending,0);await h.call('logout');
});

test('恢复登录必须向服务端重新验证，网络失败保留缓存，撤销后清除',async()=>{const initial={token:'secret',tenant:'A'};const ok=await harness(initial);const restored=await ok.call('restore-session');assert.equal(restored.ok,true);assert.equal(restored.data.tenant_id,'A');assert.ok(ok.requests.some(r=>r.pathname.endsWith('/auth/me')));await ok.call('logout');assert.equal(ok.cached(),null);const offline=await harness(initial,'offline');assert.equal((await offline.call('restore-session')).status,503);assert.ok(offline.cached());const revoked=await harness(initial,'revoked');assert.equal((await revoked.call('restore-session')).status,401);assert.equal(revoked.cached(),null);});
test('模拟后台任务在停用、切换企业和退出时停止',async()=>{const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'crm-background-auth-'));try{const h=await harness(null,null,dir);assert.throws(()=>h.call('mock-background','status'),/Authentication required/);await h.call('login','person@example.com','password');await h.call('select-tenant','A');assert.equal((await h.call('mock-background','start','notion-demo')).running,true);await h.call('mock-sync','disable');assert.equal((await h.call('mock-background','status')).running,false);await h.call('mock-sync','enable');await h.call('mock-background','start','notion-demo');await h.call('select-tenant','B');assert.equal((await h.call('mock-background','status')).running,false);await h.call('mock-background','start','notion-demo');await h.call('logout');await h.call('login','person@example.com','password');await h.call('select-tenant','A');assert.equal((await h.call('mock-background','status')).running,true);await h.call('mock-background','stop');await h.call('logout');}finally{fs.rmSync(dir,{recursive:true,force:true});}});

test('Agent 按租户隔离且退出时停止，不向子进程传递登录令牌', async () => {
  const h=await harness();
  await assert.rejects(()=>h.call('agent','presets'),/Authentication required/);
  await h.call('login','person@example.com','password'); await h.call('select-tenant','A');
  assert.equal((await h.call('agent','privacy-mode',false)).private,false);
  assert.match((await h.call('agent','legacy-location')).path,/session\.sqlite$/);
  assert.deepEqual(await h.call('agent','presets'),[{id:'rag'}]);
  const first=h.workers[0]; assert.equal(JSON.stringify(first.options.env).includes('secret'),false);
  assert.equal(first.options.env.CRM_AGENT_PRIVATE,'0');
  assert.ok(first.sent.some(message=>message.type==='initialize' && message.key.length===64));
  await h.call('select-tenant','B'); assert.equal(h.workers.length,1);
  await h.call('agent','presets'); assert.notEqual(h.workers[1].options.env.CRM_AGENT_DATA_DIR,first.options.env.CRM_AGENT_DATA_DIR);
  await h.call('logout'); await assert.rejects(()=>h.call('agent','presets'),/Authentication required/);
});

test('记忆分页只接受已登录用户和限定参数',async()=>{const h=await harness();await assert.rejects(()=>h.call('agent','memory-page',{status:'pending',cursor:null}),/Authentication required/);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','memory-page',{status:'pending',cursor:null,tenant_id:'other'});const request=h.workers[0].sent.find(item=>item.type==='memory-page');assert.equal(request.value.status,'pending');assert.equal(request.value.cursor,null);assert.equal(request.value.tenant_id,undefined);await assert.rejects(()=>h.call('agent','memory-page',{status:'deleted',cursor:null}));await h.call('logout');});

test('自进化任务状态和进度只发给当前登录会话',async()=>{const h=await harness();await assert.rejects(()=>h.call('agent','evolution-tasks'),/Authentication required/);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','evolution-tasks');const child=h.workers[0];child.emit('message',{type:'evolution-progress',event:{traceId:'1',stage:'run'}});assert.ok(h.notices.some(([name,event])=>name==='crm:evolution-progress'&&event.stage==='run'));await h.call('logout');const count=h.notices.length;child.emit('message',{type:'evolution-progress',event:{traceId:'1',stage:'completed'}});assert.equal(h.notices.length,count);});

test('强制停止 Agent 后必须等到进程退出才能重新打开会话',async()=>{let forceStop;const schedule=(fn,ms)=>ms===10000?(forceStop=fn,{}):setTimeout(fn,ms),h=await harness(null,null,'C:/agent-data',schedule);let restart;await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');const child=h.workers[0],post=child.postMessage;let killed=false;child.postMessage=message=>message.type==='close'?undefined:post(message);child.kill=()=>{killed=true;};try{await h.call('agent','privacy-mode',true);restart=h.call('agent','presets');await tick();assert.equal(h.workers.length,1);forceStop();await tick();assert.equal(killed,true);assert.equal(h.workers.length,1);child.emit('exit',0);await restart;assert.equal(h.workers.length,2);}finally{child.emit('exit',0);if(restart)await restart.catch(()=>{});await h.call('logout');}});

test('旧 Agent 迟迟未退出时返回错误，退出后仍可重新打开',async()=>{let forceStop,stopWait;const schedule=(fn,ms)=>ms===10000?(forceStop=fn,{}):ms===15000?(stopWait=fn,{}):setTimeout(fn,ms),h=await harness(null,null,'C:/agent-data',schedule);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');const child=h.workers[0],post=child.postMessage;child.postMessage=message=>message.type==='close'?undefined:post(message);child.kill=()=>{};try{await h.call('agent','privacy-mode',true);const restart=h.call('agent','presets');await tick();forceStop();stopWait();await assert.rejects(restart,/AGENT_STOP_TIMEOUT/);assert.equal(h.workers.length,1);child.emit('exit',0);await h.call('agent','presets');assert.equal(h.workers.length,2);}finally{child.emit('exit',0);await h.call('logout');}});

test('Agent 读取只经过宿主白名单并使用当前登录身份',async()=>{const h=await harness();await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');const worker=h.workers[0];worker.emit('message',{type:'crm-read',id:'read-1',operation:'search',args:{resource:'companies',query:'Example'}});await tick();await tick();const response=worker.sent.find(x=>x.type==='crm-read-result'&&x.id==='read-1');assert.equal(response.data.items[0].name,'Example');const request=h.requests.find(x=>x.pathname.endsWith('/companies'));assert.equal(request.headers.Authorization,'Bearer secret');assert.equal(request.headers['X-Tenant-ID'],'A');worker.emit('message',{type:'crm-read',id:'bad',operation:'search',args:{resource:'companies',tenant_id:'B'}});await tick();assert.equal(worker.sent.find(x=>x.id==='bad').error,'CRM_READ_FAILED');await h.call('logout');});

test('Agent 线索申请需人工确认，拒绝不写入，确认使用固定幂等键',async()=>{const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'crm-approval-flow-'));try{const h=await harness(null,null,dir);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');const worker=h.workers[0];const request={title:'客户咨询',manual_note:'客户想了解样品'};worker.emit('message',{type:'crm-propose',id:'proposal-1',callId:'call-1',operation:'propose-lead',args:request});await tick();const item=(await h.call('approvals','list'))[0];assert.equal(item.status,'pending');assert.equal(h.requests.filter(r=>r.pathname.endsWith('/leads')).length,0);await h.call('approvals','reject',item.id);assert.equal(h.requests.filter(r=>r.pathname.endsWith('/leads')).length,0);worker.emit('message',{type:'crm-propose',id:'proposal-2',callId:'call-2',operation:'propose-lead',args:request});await tick();const approved=(await h.call('approvals','list')).find(x=>x.status==='pending');await assert.rejects(()=>h.call('approvals','confirm',approved.id,'0'.repeat(64)));const result=await h.call('approvals','confirm',approved.id,approved.digest);assert.equal(result.status,'succeeded');const write=h.requests.find(r=>r.pathname.endsWith('/leads'));assert.equal(write.headers['Idempotency-Key'],approved.id);assert.equal(write.headers['X-Operation-Source'],'agent');assert.equal(write.headers['X-Tenant-ID'],'A');await assert.rejects(()=>h.call('approvals','confirm',approved.id,approved.digest));await h.call('logout');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('Agent 创建公司须经本人确认并沿用当前身份',async()=>{const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'crm-company-approval-'));try{const h=await harness(null,null,dir);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');h.workers[0].emit('message',{type:'crm-propose',id:'company',callId:'company-call',runId:'f1dd6840-768d-4a20-b951-6c45acdc20c9',operation:'propose-company',args:{name:'示例客户',country:'中国'}});await tick();const item=(await h.call('approvals','list'))[0];assert.equal(item.type,'create_company');assert.equal(h.requests.filter(r=>r.pathname.endsWith('/companies')&&r.method==='POST').length,0);assert.equal((await h.call('approvals','confirm',item.id,item.digest)).status,'succeeded');const write=h.requests.find(r=>r.pathname.endsWith('/companies')&&r.method==='POST');assert.equal(write.headers['X-Tenant-ID'],'A');assert.equal(write.headers['Idempotency-Key'],item.id);assert.equal(write.headers['X-Agent-Run-ID'],item.runId);assert.equal(JSON.parse(write.body).owner_id,undefined);await h.call('logout');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('联系人、商机、任务申请只有确认后才向指定接口写入',async()=>{const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'crm-create-approval-'));try{const h=await harness(null,null,dir);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');const company='f1dd6840-768d-4a20-b951-6c45acdc20c9';for(const [op,args] of [['propose-contact',{company_id:company,name:'张三',email:'test@example.com'}],['propose-opportunity',{company_id:company,name:'样品'}],['propose-task',{company_id:company,title:'跟进',due_at:'2026-10-29T08:00:00Z'}]]){h.workers[0].emit('message',{type:'crm-propose',id:op,callId:op,operation:op,args});await tick();const item=(await h.call('approvals','list')).find(x=>x.callId===op);assert.ok(item);assert.equal(h.requests.filter(r=>r.pathname===item.request.path&&r.method==='POST').length,0);assert.equal((await h.call('approvals','confirm',item.id,item.digest)).status,'succeeded');const write=h.requests.find(r=>r.pathname===item.request.path&&r.method==='POST');assert.equal(write.headers['Idempotency-Key'],item.id);assert.equal(write.headers['X-Tenant-ID'],'A');}await h.call('logout');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('权限拒绝和版本冲突不会被视为成功或自动重试',async()=>{const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'crm-approval-conflict-'));try{const h=await harness(null,null,dir);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');const id='f1dd6840-768d-4a20-b951-6c45acdc20c9';for(const [op,args,status] of [['propose-company-update',{id,expected_version:1,industry:'制造'},403],['propose-task-complete',{id,expected_version:1,note:'已联系'},409]]){h.workers[0].emit('message',{type:'crm-propose',id:op,callId:op,operation:op,args});await tick();const item=(await h.call('approvals','list')).find(x=>x.callId===op);h.setWriteStatus(status);const result=await h.call('approvals','confirm',item.id,item.digest);assert.equal(result.status,'failed');await assert.rejects(()=>h.call('approvals','confirm',item.id,item.digest));h.setWriteStatus(null);}await h.call('logout');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('沟通记录必须确认后才提交并绑定当前企业',async()=>{const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'crm-activity-approval-'));try{const h=await harness(null,null,dir);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');const company_id='f1dd6840-768d-4a20-b951-6c45acdc20c9';h.workers[0].emit('message',{type:'crm-propose',id:'activity',callId:'activity-call',operation:'propose-activity',args:{company_id,activity_type:'phone',summary:'核对样品',occurred_at:'2026-10-29T08:00:00Z'}});await tick();const item=(await h.call('approvals','list'))[0];assert.equal(item.type,'create_activity');assert.equal(h.requests.filter(r=>r.pathname.endsWith('/activities')).length,0);assert.equal((await h.call('approvals','confirm',item.id,item.digest)).status,'succeeded');const write=h.requests.find(r=>r.pathname.endsWith('/activities'));assert.equal(write.headers['Idempotency-Key'],item.id);assert.equal(write.headers['X-Tenant-ID'],'A');await h.call('logout');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('提交后超时使用同一幂等键恢复，不重复创建',async()=>{const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'crm-approval-retry-'));try{const h=await harness(null,null,dir);await h.call('login','person@example.com','password');await h.call('select-tenant','A');await h.call('agent','presets');const worker=h.workers[0],args={title:'客户咨询',manual_note:'客户询问样品'};worker.emit('message',{type:'crm-propose',id:'one',callId:'call-retry',operation:'propose-lead',args});await tick();worker.emit('message',{type:'crm-propose',id:'two',callId:'call-retry',operation:'propose-lead',args});await tick();assert.equal((await h.call('approvals','list')).length,1);const item=(await h.call('approvals','list'))[0];h.failLeadOnce();assert.equal((await h.call('approvals','confirm',item.id,item.digest)).status,'retry');assert.equal((await h.call('approvals','confirm',item.id,item.digest)).status,'succeeded');const requests=h.requests.filter(x=>x.pathname.endsWith('/leads'));assert.equal(requests.length,2);assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);assert.equal(h.createdLeads.size,1);await h.call('logout');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('重新登录不会自动重放提交中的审批',async()=>{const {approvalStore}=require('./agent-approvals.cjs');const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'crm-approval-resume-'));try{const h=await harness(null,null,dir);const scope=crypto.createHash('sha256').update('http://127.0.0.1:8000:A:user-1').digest('hex');const store=approvalStore(path.join(dir,'approvals',scope),h.storage,scope);const item=store.create('create_lead',{title:'测试线索',manual_note:'测试依据'},'call');store.transition(item.id,['pending'],'submitting',{},item.digest);await h.call('login','person@example.com','password');await h.call('select-tenant','A');assert.equal((await h.call('approvals','list'))[0].status,'submitting');assert.equal(h.requests.filter(r=>r.pathname.endsWith('/leads')).length,0);const result=await h.call('approvals','confirm',item.id,item.digest);assert.equal(result.status,'succeeded');assert.equal(h.requests.find(r=>r.pathname.endsWith('/leads')).headers['Idempotency-Key'],item.id);await h.call('logout');}finally{fs.rmSync(dir,{recursive:true,force:true});}});

test('ego 安装指南只允许已登录用户打开固定官方地址', async () => {
  const h = await harness();
  await assert.rejects(()=>h.call('ego-install-guide'),/Authentication required/);
  await h.call('login','person@example.com','password');
  await h.call('select-tenant','A');
  await h.call('ego-install-guide','https://example.org');
  assert.deepEqual(h.externalUrls,['https://www.egolite.ai/document/en/docs/windows/quick-start']);
  await h.call('logout');
});

test('tenant switch cancels old HTTP and stream and uses only the new tenant', async () => {
  const h = await harness();
  await h.call('login','person@example.com','password');
  assert.equal((await h.call('select-tenant','A')).data.tenant_id,'A');
  await tick();
  const oldRequest = h.call('request','/api/v1/companies','GET').catch(e=>e.message);
  await tick();
  assert.equal((await h.call('select-tenant','B')).data.tenant_id,'B');
  assert.equal(await oldRequest,'aborted');
  await tick();
  assert.equal(h.streams.length,2);
  assert.equal(h.streams[0].signal.aborted,true);
  assert.equal(h.streams[1].signal.aborted,false);
  const last = h.requests.filter(x=>x.pathname.endsWith('/sync/events')).at(-1);
  assert.equal(last.headers['X-Tenant-ID'],'B');
  await h.call('logout');
  assert.equal(h.streams[1].signal.aborted,true);
  await assert.rejects(()=>h.call('request','/api/v1/companies','GET'),/Authentication required/);
});

test('an expired session stops the stream and clears credentials', async () => {
  const h = await harness();
  await h.call('login','person@example.com','password');
  await h.call('select-tenant','A');
  await tick();
  h.rejectNext();
  const response = await h.call('request','/api/v1/companies','GET');
  assert.equal(response.status,401);
  assert.equal(h.streams[0].signal.aborted,true);
  assert.ok(h.notices.some(([name])=>name==='crm:revoked'));
  await assert.rejects(()=>h.call('request','/api/v1/companies','GET'),/Authentication required/);
});

test('SSE revocation clears the session and stops the stream', async () => {
  const h = await harness();
  await h.call('login','person@example.com','password');
  await h.call('select-tenant','A');
  await tick();
  h.streams[0].emit('event: revoked\ndata: {}\n\n');
  await tick();
  assert.equal(h.streams[0].signal.aborted,true);
  assert.ok(h.notices.some(([name])=>name==='crm:revoked'));
  await assert.rejects(()=>h.call('request','/api/v1/companies','GET'),/Authentication required/);
});


test('a disconnected stream reconnects with its last event cursor', async () => {
  const h = await harness();
  await h.call('login','person@example.com','password');
  await h.call('select-tenant','A');
  await tick();
  h.streams[0].emit('id: 12\nevent: changes\ndata: {"events":[],"cursor":12}\n\n');
  await tick();
  h.streams[0].close();
  const deadline = Date.now()+3000;
  while (h.streams.length < 2 && Date.now() < deadline) await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.streams.length,2);
  const reconnect = h.requests.filter(x=>x.pathname.endsWith('/sync/events')).at(-1);
  assert.equal(reconnect.headers['Last-Event-ID'],'12');
  assert.equal(reconnect.headers['X-Tenant-ID'],'A');
  await h.call('logout');
});


test('leaving the tenant chooser revokes the login session', async () => {
  const h = await harness();
  await h.call('login','person@example.com','password');
  await h.call('logout');
  const logout = h.requests.find(x=>x.pathname.endsWith('/auth/logout'));
  assert.ok(logout);
  assert.equal(logout.headers.Authorization,'Bearer secret');
  assert.equal(logout.headers['X-Tenant-ID'],undefined);
});


test('authentication actions use the approved endpoints and clear a changed session', async () => {
  const h=await harness();
  await assert.rejects(()=>h.call('auth-action','arbitrary',{}),/Invalid authentication action/);
  await assert.rejects(()=>h.call('auth-action','join',{}),/Authentication required/);
  assert.equal((await h.call('auth-action','register',{email:'a@example.com'})).ok,true);
  assert.equal(h.requests.at(-1).headers.Authorization,undefined);
  await h.call('login','person@example.com','password');
  assert.equal((await h.call('auth-action','join',{tenant_id:'A'})).ok,true);
  assert.equal(h.requests.at(-1).headers.Authorization,'Bearer secret');
  await h.call('select-tenant','A'); await tick();
  assert.equal((await h.call('auth-action','change',{current_password:'old',new_password:'new'})).ok,true);
  assert.equal(h.streams[0].signal.aborted,true);
  await assert.rejects(()=>h.call('request','/api/v1/companies','GET'),/Authentication required/);
});
