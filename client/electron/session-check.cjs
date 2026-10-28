const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');

async function harness() {
  const handlers = new Map(), notices = [], streams = [], requests = [];
  let rejectNext = false, window;
  class Window {
    constructor() { window = this; this.webContents = { send: (name, data) => notices.push([name, data]), on() {}, setWindowOpenHandler() {} }; }
    isDestroyed() { return false; } loadURL() {} loadFile() {} once() {} isMinimized() { return false; } show() {} focus() {}
  }
  const electron = { app: {whenReady: () => Promise.resolve(), on() {}, quit() {}, isPackaged: false, commandLine: {hasSwitch: () => false}}, BrowserWindow: Window, Menu: {setApplicationMenu() {}}, ipcMain: {handle: (name, handler) => handlers.set(name, handler)}, Notification: {isSupported: () => false} };
  const fetchMock = async (url, options) => {
    const pathname = url.pathname;
    requests.push({ pathname, headers: options.headers, signal: options.signal });
    if (pathname.endsWith('/auth/login')) return {ok:true,status:200,json:async()=>({access_token:'secret'})};
    if (pathname.endsWith('/auth/tenants')) return {ok:true,status:200,json:async()=>({items:[{id:'A'},{id:'B'}]})};
    if (pathname.endsWith('/auth/me')) return {ok:true,status:200,json:async()=>({tenant_id:options.headers['X-Tenant-ID']})};
    if (pathname.endsWith('/auth/register') || pathname.endsWith('/auth/join') || pathname.endsWith('/auth/password/change')) return {ok:true,status:200,json:async()=>({status:'ok'})};
    if (pathname.endsWith('/auth/logout')) return {ok:true,status:200,json:async()=>({})};
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
  const context = {require: name => name==='electron' ? electron : name==='node:path' ? path : name==='node:crypto' ? crypto : require(name), __dirname, process:{env:{},platform:process.platform}, URL, AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout, fetch:fetchMock};
  vm.runInNewContext(source, context, {filename:'main.cjs'});
  await Promise.resolve();
  const event = {sender:window.webContents};
  const call = (name,...args) => handlers.get('crm:'+name)(event,...args);
  return {call, streams, requests, notices, rejectNext:()=>{rejectNext=true;}};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

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
