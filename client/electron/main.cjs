const { app, BrowserWindow, ipcMain, Notification, Menu, shell, utilityProcess, safeStorage, dialog } = require('electron');
const {sessionCache} = require('./session-cache.cjs');
const {moduleStore} = require('./module-store.cjs');
const {moduleRecords} = require('./module-records.cjs');
const {mockSync} = require('./mock-sync.cjs');
const {backgroundRunner} = require('./background-runner.cjs');
const {datasetCsv} = require('./dataset-export.cjs');
const {buildLangfusePayload, uploadLangfuse,tracesUrl} = require('./langfuse-export.cjs');
const {createLangfuseQueue} = require('./langfuse-queue.cjs');
const {createTraceArchive,writeTraceExportFile} = require('./trace-archive.cjs');
const {inspectLegacy} = require('./legacy-session.cjs');
const fs = require('node:fs/promises');
const {readPath} = require('./agent-crm.cjs');
const {approvalStore} = require('./agent-approvals.cjs');
const {agentDatabaseKey} = require('./agent-key.cjs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const api = new URL(process.env.CRM_API_URL || 'http://127.0.0.1:8000');
if (!['https:', 'http:'].includes(api.protocol) || api.username || api.password || (api.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(api.hostname))) throw new Error('CRM_API_URL must use HTTPS, except for loopback development');
let windowRef, token = null, tenant = null, userId = null, generation = 0, streamAbort = null, agent = null, agentPrivate = false;
let agentStopping = Promise.resolve();
const pending = new Set();
// Preserve the key for an identical retry after an uncertain network outcome.
const retryKeys = new Map();
const approvalsInFlight = new Set();
const mockBackground=backgroundRunner({run:(target,key)=>mockSyncStore().run(target,key)});
const runDetails = createLangfuseQueue(detail=>{const cfg=langfuseSettings();return uploadLangfuse(buildLangfusePayload(detail,langfuseBuildOpts(cfg)),cfg);});
let langfuseConfig = null, traceStorageError = null;
const traceArchive=createTraceArchive({
  request:(type,payload)=>agentRequest(type,payload),
  upload:(payload,config)=>uploadLangfuse(payload,config),
  context:()=>({generation,config:langfuseSettings(),buildOptions:langfuseBuildOpts(langfuseSettings())}),
  isCurrent:ctx=>ctx.generation===generation&&Boolean(token&&tenant&&userId),
});

function send(channel, data) { if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, data); }
function clearRequests() { generation++; for (const c of pending) c.abort(); pending.clear(); if (streamAbort) streamAbort.abort(); streamAbort = null; }
function stopAgent() {
  const child=agent;if(!child)return agentStopping;agent=null;
  const stopped=new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();};const timer=setTimeout(()=>{try{child.kill();}catch{}},10000);child.once('exit',finish);try{child.postMessage({type:'close'});}catch{try{child.kill();}catch{}}});
  agentStopping=Promise.all([agentStopping,stopped]).then(()=>{});return agentStopping;
}
function cache() { return sessionCache(safeStorage, app.getPath('userData'), api.origin); }
function modules() { if(!token||!tenant||!userId)throw new Error('Authentication required');const scope=createHash('sha256').update(`${api.origin}:${tenant}:${userId}`).digest('hex');return moduleStore(path.join(app.getPath('userData'),'modules',scope)); }
function moduleData(){if(!token||!tenant||!userId)throw Error('Authentication required');const scope=createHash('sha256').update(`${api.origin}:${tenant}:${userId}`).digest('hex');return moduleRecords(path.join(app.getPath('userData'),'module-records',scope),safeStorage,scope,modules());}
function mockSyncStore(){if(!token||!tenant||!userId)throw Error('Authentication required');const scope=createHash('sha256').update(`${api.origin}:${tenant}:${userId}`).digest('hex');return mockSync(path.join(app.getPath('userData'),'mock-sync',scope),safeStorage,scope);}
function resumeMockBackground(){try{const config=mockSyncStore().config();if(config.enabled&&config.backgroundTarget)mockBackground.start(config.backgroundTarget);}catch{mockBackground.stop();}}
function approvals() { if(!token||!tenant||!userId)throw new Error('Authentication required');const scope=createHash('sha256').update(`${api.origin}:${tenant}:${userId}`).digest('hex');return approvalStore(path.join(app.getPath('userData'),'approvals',scope),safeStorage,scope); }
function langfuseSettings(){const cfg=langfuseConfig||{};return {baseUrl:cfg.baseUrl||process.env.LANGFUSE_BASE_URL,publicKey:cfg.publicKey||process.env.LANGFUSE_PUBLIC_KEY,secretKey:cfg.secretKey||process.env.LANGFUSE_SECRET_KEY,autoUpload:cfg.autoUpload!==undefined?Boolean(cfg.autoUpload):process.env.LANGFUSE_AUTO_UPLOAD==='1',release:process.env.CRM_APP_VERSION||undefined,environment:process.env.CRM_ENV||'desktop'};}
function langfuseConfigured(){const s=langfuseSettings();return Boolean(s.baseUrl&&s.publicKey&&s.secretKey);}
function langfuseBuildOpts(cfg){return {userId:tenant&&userId?createHash('sha256').update(`${api.origin}:${tenant}:${userId}`).digest('hex').slice(0,16):undefined,release:cfg.release,environment:cfg.environment,tags:['crm','desktop']};}
async function storeRunDetail(detail){if(!detail||typeof detail.id!=='string'||!detail.id)return;runDetails.add(detail);send('crm:langfuse-status',{pending:runDetails.pending()});const cfg=langfuseSettings();if(!cfg.autoUpload||!langfuseConfigured())return;const current=generation,result=await runDetails.upload(detail.id);if(current===generation)send('crm:langfuse-status',{ok:result.ok,error:result.error||null,pending:runDetails.pending()});}
async function handleSavedTrace(id){const current=generation,cfg=langfuseSettings();if(cfg.autoUpload&&langfuseConfigured()){const result=await traceArchive.uploadOne(id);if(current===generation)send('crm:langfuse-status',{ok:result.ok,error:result.error||null});}else if(current===generation)send('crm:langfuse-status',{});}
async function langfuseStatus(){const cfg=langfuseSettings(),saved=await traceArchive.status();return {configured:langfuseConfigured(),baseUrl:cfg.baseUrl||'',autoUpload:cfg.autoUpload,pending:saved.pending+runDetails.pending(),lastError:traceStorageError||saved.lastError||runDetails.lastError()};}
function clearSession(forget = false) { mockBackground.stop(); stopAgent(); agentPrivate=false; clearRequests(); retryKeys.clear(); runDetails.clear(); langfuseConfig=null; traceStorageError=null; token = null; tenant = null; userId = null; if (forget) { try { cache().clear(); } catch {} } }
async function startAgent() {
  if (!token || !tenant || !userId) throw new Error('Authentication required');
  const requestedGeneration=generation;let stopTimeout;
  try{await Promise.race([agentStopping,new Promise((_,reject)=>{stopTimeout=setTimeout(()=>reject(new Error('AGENT_STOP_TIMEOUT')),15000);})]);}finally{clearTimeout(stopTimeout);}
  if(requestedGeneration!==generation||!token||!tenant||!userId)throw new Error('Session changed');
  if (agent) return agent;
  const scope = createHash('sha256').update(`${api.origin}:${tenant}:${userId}`).digest('hex');
  const data = path.join(app.getPath('userData'), 'agent', scope);
  const databaseKey=agentPrivate?null:agentDatabaseKey(safeStorage,data,scope);
  const child = utilityProcess.fork(path.join(__dirname, '../agent/worker.mjs'), [], {env:{CRM_AGENT_DATA_DIR:data, CRM_AGENT_PRIVATE:agentPrivate?'1':'0', SystemRoot:process.env.SystemRoot || ''}, stdio:'pipe'});
  agent = child;
  child.on('message', async message => {
    if(!['crm-read','crm-propose'].includes(message?.type)||typeof message.id!=='string'||message.id.length>80)return;
    const originalGeneration=generation;
    try {
      if(agent!==child||!token||!tenant||!userId)throw Error('Session unavailable');
      if(message.type==='crm-propose'){
        const type={'propose-company':'create_company','propose-contact':'create_contact','propose-opportunity':'create_opportunity','propose-task':'create_task','propose-activity':'create_activity','propose-company-update':'update_company','propose-contact-update':'update_contact','propose-task-complete':'complete_task','propose-lead':'create_lead','propose-conversion':'convert_lead','propose-lead-update':'update_lead','propose-opportunity-update':'update_opportunity'}[message.operation]||null;
        const item=approvals().create(type,message.args,message.callId,message.runId||undefined);send('crm:approval',{});
        child.postMessage({type:'crm-read-result',id:message.id,data:{id:item.id,status:item.status,message:item.status==='pending'?'已提交用户审核，尚未执行':'该工具调用已有记录，请查看实际状态'}});return;
      }
      const result=await call(readPath(message.operation,message.args));
      if(agent!==child||generation!==originalGeneration)return;
      if(!result.ok||JSON.stringify(result.data).length>100000)throw Error('CRM request failed');
      child.postMessage({type:'crm-read-result',id:message.id,data:result.data});
    } catch { if(agent===child&&generation===originalGeneration)child.postMessage({type:'crm-read-result',id:message.id,error:'CRM_READ_FAILED'}); }
  });
  child.on('exit', () => { if (agent === child) agent = null; });
  child.on('message', message => { if (agent===child && message && message.type === 'run-detail') void storeRunDetail(message.detail); });
  child.on('message', message => { if(agent===child&&typeof message?.id==='string'&&message.type==='run-detail-ready')void handleSavedTrace(message.id).catch(()=>{}); });
  child.on('message', message => { if(agent===child&&message?.type==='trace-storage-error'){traceStorageError='TRACE_STORAGE_FAILED';send('crm:langfuse-status',{error:traceStorageError});} });
  child.on('message', message => { if (agent===child && token && tenant && userId && message?.type==='memory-progress') send('crm:memory-progress',message.event); });
  child.on('message', message => { if (agent===child && token && tenant && userId && message?.type==='evolution-progress' && message.event) send('crm:evolution-progress',message.event); });
  if(databaseKey)child.postMessage({type:'initialize',key:databaseKey});
  return child;
}
async function agentRequest(type, payload={}) {
  const requestGeneration=generation,child = await startAgent(), id = randomUUID();
  if(requestGeneration!==generation||agent!==child)throw Error('Session changed');
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>finish(new Error('Agent 暂时不可用')),type==='harness2-run'?600000:['chat','evolve'].includes(type)?120000:15000);
    function finish(error, data) { clearTimeout(timer); child.off('message',onMessage); child.off('exit',onExit); error ? reject(error) : resolve(data); }
    function onExit() { finish(new Error('Agent 已停止')); }
    function onMessage(message) { if(message?.type==='startup-error'){finish(new Error('会话存储无法打开，请检查本机加密设置'));return;} if(message?.id===id && (agent!==child||generation!==requestGeneration)){finish(new Error('Session changed'));return;} if(message?.id===id && message.type==='evolution-progress'){if(agent===child)send('crm:evolution-progress',{stage:message.stage});return;} if(message?.id===id) finish(message.error ? new Error('Agent 请求失败') : null,message.data); }
    child.on('message',onMessage); child.on('exit',onExit); child.postMessage({type,id,...payload});
  });
}
function trusted(event) { if (!windowRef || event.sender !== windowRef.webContents) throw new Error('Unauthorized IPC sender'); }
function endpoint(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/v1/') || pathname.startsWith('/api/v1//') || pathname.includes('\\')) throw new Error('Invalid API path');
  const url = new URL(pathname, api);
  if (url.origin !== api.origin || !url.pathname.startsWith('/api/v1/')) throw new Error('Invalid API destination');
  return url;
}
async function call(pathname, method = 'GET', body, activeToken = token, activeTenant = tenant, agentWrite = null) {
  if (!['GET','POST','PATCH','DELETE'].includes(method)) throw new Error('Invalid HTTP method');
  const controller = new AbortController(); pending.add(controller);
  const current = generation;
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { Accept: 'application/json' };
    if (activeToken) headers.Authorization = `Bearer ${activeToken}`;
    if (activeTenant) headers['X-Tenant-ID'] = activeTenant;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let retryKey;
    if (method !== 'GET' && !pathname.startsWith('/api/v1/auth/')) {
      if(agentWrite){headers['Idempotency-Key']=agentWrite.id;headers['X-Operation-Source']='agent';if(agentWrite.runId)headers['X-Agent-Run-ID']=agentWrite.runId;}
      else {
        retryKey = JSON.stringify([activeTenant, method, pathname, body]);
        if (!retryKeys.has(retryKey)) {
          if (retryKeys.size >= 100) throw new Error('Too many unresolved requests; reconnect before retrying');
          retryKeys.set(retryKey, require('node:crypto').randomUUID());
        }
        headers['Idempotency-Key'] = retryKeys.get(retryKey);
      }
    }
    const result = await fetch(endpoint(pathname), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    const data = await result.json().catch(() => ({}));
    if (current !== generation) throw new Error('Session changed');
    if (retryKey && result.status < 500) retryKeys.delete(retryKey);
    if (!result.ok) {
      if (result.status === 401 && !pathname.endsWith('/auth/login')) { clearSession(true); send('crm:revoked', {}); }
      if (result.status === 403 && !pathname.endsWith('/auth/me')) send('crm:permission', {});
      return { ok: false, status: result.status, error: data.error || { code: 'INTERNAL_ERROR', message: '请求失败' } };
    }
    return { ok: true, data };
  } finally { clearTimeout(timer); pending.delete(controller); }
}
async function subscribe() {
  if (!token || !tenant) return;
  const controller = new AbortController(); streamAbort = controller;
  const version = generation; let cursor = null; let retry = 1000;
  while (!controller.signal.aborted && version === generation) {
    const attempt = new AbortController();
    const cancelAttempt = () => attempt.abort();
    controller.signal.addEventListener('abort', cancelAttempt, { once: true });
    try {
      const headers = { Authorization: `Bearer ${token}`, 'X-Tenant-ID': tenant, Accept: 'text/event-stream' };
      if (cursor !== null) headers['Last-Event-ID'] = String(cursor);
      const response = await fetch(endpoint('/api/v1/sync/events'), { headers, signal: attempt.signal, redirect: 'error' });
      if (response.status === 401 || response.status === 403) { clearSession(true); send('crm:revoked', {}); return; }
      if (!response.ok || !response.body) throw new Error('Sync unavailable');
      send('crm:connection', 'connected'); retry = 1000;
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (!controller.signal.aborted) {
        let timer;
        const part = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sync heartbeat timed out')), 45000); })]).finally(() => clearTimeout(timer));
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 1024 * 1024) throw new Error('Sync buffer limit exceeded');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          let event = 'message', id = null, payload = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('data:')) payload += line.slice(5).trimStart();
          }
          if (event === 'revoked') { clearSession(true); send('crm:revoked', {}); return; }
          if (event === 'changes') {
            try { const data = JSON.parse(payload); if (!Array.isArray(data.events) || !Number.isSafeInteger(data.cursor)) throw new Error('Invalid event'); send('crm:sync', data); if (id && /^\d+$/.test(id)) cursor = Number(id); }
            catch { cursor = null; send('crm:sync', { reset: true, events: [] }); }
          }
        }
      }
      await reader.cancel().catch(() => {});
      if (!controller.signal.aborted) throw new Error('Connection closed');
    } catch (err) {
      attempt.abort();
      if (controller.signal.aborted || version !== generation) return;
      send('crm:connection', 'reconnecting'); send('crm:sync', { reset: false, events: [{ action: 'resync' }] });
      await new Promise(resolve => setTimeout(resolve, retry)); retry = Math.min(retry * 2, 15000);
    } finally { attempt.abort(); controller.signal.removeEventListener('abort', cancelAttempt); }
  }
}

Menu.setApplicationMenu(null);
const primaryInstance=app.requestSingleInstanceLock();
if(!primaryInstance)app.quit();
else app.on('second-instance',()=>{if(windowRef&&!windowRef.isDestroyed()){if(windowRef.isMinimized())windowRef.restore();windowRef.show();windowRef.focus();}});
if(primaryInstance)app.whenReady().then(() => {
  windowRef = new BrowserWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 640, backgroundColor: '#f5f7fa', icon: path.join(__dirname, '../assets/brand.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.on('will-navigate', e => e.preventDefault());
  if (!app.isPackaged && !app.commandLine.hasSwitch('production')) windowRef.loadURL('http://127.0.0.1:5173/');
  else windowRef.loadFile(path.join(__dirname, '../dist/index.html'));
  windowRef.once('ready-to-show', () => { if (windowRef.isMinimized()) windowRef.restore(); windowRef.show(); windowRef.focus(); });
  ipcMain.handle('crm:login', async (event, email, password) => {
    trusted(event); clearSession(true);
    const result = await call('/api/v1/auth/login', 'POST', { email, password }, null, null);
    if (!result.ok) return result;
    token = result.data.access_token;
    const list = await call('/api/v1/auth/tenants');
    if (!list.ok) clearSession();
    return list;
  });
  ipcMain.handle('crm:auth-action', async (event, action, body) => {
    trusted(event);
    const paths = {register:'/auth/register', verify:'/auth/register/verify', resetRequest:'/auth/password/reset-request', reset:'/auth/password/reset', change:'/auth/password/change', join:'/auth/join'};
    if (!Object.hasOwn(paths, action)) throw new Error('Invalid authentication action');
    const needsAuth = action === 'change' || action === 'join';
    if (needsAuth && !token) throw new Error('Authentication required');
    const result = await call('/api/v1'+paths[action], 'POST', body, needsAuth ? token : null, null);
    if (result.ok && action === 'change') { clearSession(true); send('crm:revoked', {}); }
    return result;
  });
  ipcMain.handle('crm:tenants', async event => { trusted(event); if (!token) throw new Error('Authentication required'); return call('/api/v1/auth/tenants', 'GET', undefined, token, null); });
  ipcMain.handle('crm:select-tenant', async (event, id) => {
    trusted(event); if (!token || typeof id !== 'string') throw new Error('Authentication required');
    mockBackground.stop(); stopAgent(); agentPrivate=false; userId = null; clearRequests(); retryKeys.clear(); runDetails.clear(); langfuseConfig=null; traceStorageError=null; tenant = id;
    const me = await call('/api/v1/auth/me');
    if (me.ok) { userId = me.data.user_id; cache().save(token, tenant); subscribe(); resumeMockBackground(); } else tenant = null;
    return me;
  });
  ipcMain.handle('crm:restore-session', async event => {
    trusted(event);
    const saved = cache().load();
    if (!saved || token) return {ok:false, status:401, error:{code:'UNAUTHORIZED', message:'请登录'}};
    token = saved.token; tenant = saved.tenant;
    try {
      const list = await call('/api/v1/auth/tenants', 'GET', undefined, token, null);
      if (!list.ok) { if (list.status === 401 || list.status === 403) clearSession(true); else clearSession(); return list; }
      if (!list.data.items.some(item => item.id === tenant)) { clearSession(true); return {ok:false,status:403,error:{code:'FORBIDDEN',message:'企业权限已失效'}}; }
      const me = await call('/api/v1/auth/me');
      if (!me.ok) { if (me.status === 401 || me.status === 403) clearSession(true); else clearSession(); return me; }
      userId = me.data.user_id; subscribe(); resumeMockBackground();
      return {ok:true,data:{tenants:list.data.items,tenant_id:tenant,user:me.data}};
    } catch { clearSession(); return {ok:false,status:503,error:{code:'NETWORK_ERROR',message:'无法连接服务器，请检查网络后重试'}}; }
  });
  ipcMain.handle('crm:request', async (event, pathname, method, body) => {
    trusted(event); if (!token || !tenant) throw new Error('Authentication required');
    if (pathname.startsWith('/api/v1/auth/') || pathname.startsWith('/api/v1/sync/')) throw new Error('Reserved API path');
    return call(pathname, method, body);
  });
  ipcMain.handle('crm:refresh', async event => {
    trusted(event); if (!token || !tenant) throw new Error('Authentication required');
    const result = await call('/api/v1/auth/me');
    if (!result.ok && (result.status === 401 || result.status === 403)) { clearSession(true); send('crm:revoked', {}); }
    return result;
  });
  ipcMain.handle('crm:logout', async event => { trusted(event); try { if (token) await call('/api/v1/auth/logout', 'POST'); } finally { clearSession(true); } return true; });
  ipcMain.handle('crm:notify', (event, title, body) => { trusted(event); if (Notification.isSupported() && typeof title === 'string' && typeof body === 'string') new Notification({title:title.slice(0,120), body:body.slice(0,300)}).show(); });
  ipcMain.handle('crm:modules', (event, action, value, revision) => { trusted(event);const store=modules();if(action==='list')return store.list();if(action==='preview')return store.preview(value);if(action==='install'&&typeof revision==='string')return store.install(value,revision);throw new Error('Invalid module action'); });
  ipcMain.handle('crm:module-records',(event,action,id,value)=>{trusted(event);if(typeof id!=='string')throw Error('Invalid module');const store=moduleData();if(action==='list')return store.list(id);if(action==='create')return store.create(id,value);if(action==='update'&&value&&typeof value==='object')return store.update(id,value.id,value.version,value.values);if(action==='delete'&&value&&typeof value==='object')return store.remove(id,value.id,value.version);throw Error('Invalid operation');});
  ipcMain.handle('crm:mock-sync',(event,action,destination,key)=>{trusted(event);const store=mockSyncStore();if(action==='list')return store.list();if(action==='config')return store.config();if(action==='enable')return store.setEnabled(true);if(action==='disable'){mockBackground.stop();return store.setEnabled(false);}if(action==='run')return store.run(destination,key);throw Error('Invalid operation');});
  ipcMain.handle('crm:mock-background',(event,action,target)=>{trusted(event);const store=mockSyncStore();if(action==='status')return mockBackground.status();if(action==='stop'){store.setBackground(null);mockBackground.stop();return mockBackground.status();}if(action==='start'){if(!store.config().enabled)throw Error('模拟模块已停用');const result=mockBackground.start(target);try{store.setBackground(target);}catch(e){mockBackground.stop();throw e;}return result;}throw Error('Invalid operation');});
  ipcMain.handle('crm:export-dataset',async(event,cases)=>{trusted(event);if(!token||!tenant||!userId)throw Error('Authentication required');const csv=datasetCsv(cases);const selection=await dialog.showSaveDialog(windowRef,{title:'保存测试用例',defaultPath:'crm-test-cases.csv',filters:[{name:'CSV',extensions:['csv']}]});if(selection.canceled||!selection.filePath)return {saved:false};await fs.writeFile(selection.filePath,csv,{encoding:'utf8'});return {saved:true};});
  ipcMain.handle('crm:export-traces',async event=>{trusted(event);if(!token||!tenant||!userId)throw Error('Authentication required');const current=generation;const selection=await dialog.showSaveDialog(windowRef,{title:'保存执行记录',defaultPath:'crm-traces.json',filters:[{name:'JSON',extensions:['json']}]});if(selection.canceled||!selection.filePath)return {saved:false};if(current!==generation)throw Error('Session changed');const records=await agentRequest('traces',{all:true});const report=await writeTraceExportFile(traceArchive,selection.filePath,records,runDetails.all(),()=>{if(current!==generation)throw Error('Session changed');});return {saved:true,...report};});
  ipcMain.handle('crm:langfuse', async (event, action, value) => {
    trusted(event);
    if (!token || !tenant || !userId) throw new Error('Authentication required');
    if (action === 'config') {
      if (value && typeof value === 'object') {
        const next = {};
        if (typeof value.baseUrl === 'string') {next.baseUrl = value.baseUrl.trim().slice(0, 300);if(next.baseUrl)tracesUrl(next.baseUrl);}
        if (typeof value.publicKey === 'string' && value.publicKey.trim()) next.publicKey = value.publicKey.trim().slice(0, 300);
        if (typeof value.secretKey === 'string' && value.secretKey.trim()) next.secretKey = value.secretKey.trim().slice(0, 300);
        if (typeof value.autoUpload === 'boolean') next.autoUpload = value.autoUpload;
        langfuseConfig = {...(langfuseConfig || {}), ...next};
      }
      const cfg = langfuseSettings();
      return {configured: langfuseConfigured(), baseUrl: cfg.baseUrl || '', autoUpload: cfg.autoUpload};
    }
    if (action === 'status') {
      return langfuseStatus();
    }
    if (action === 'upload') {
      if (!langfuseConfigured()) throw new Error('Langfuse 未配置');
      const current=generation,saved=await traceArchive.uploadAll();if(current!==generation)throw Error('Session changed');const fallback=await runDetails.uploadAll();
      return {uploaded:saved.uploaded+fallback.uploaded,failed:saved.failed+fallback.failed,total:saved.total+fallback.total,lastError:fallback.lastError||saved.lastError};
    }
    throw new Error('Invalid langfuse action');
  });
  ipcMain.handle('crm:approvals', async (event,action,id,digest) => {
    trusted(event);const store=approvals();if(action==='list')return store.list();
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))throw Error('审批标识无效');
    if(action==='reject')return store.transition(id,['pending'],'rejected');
    if(action!=='confirm'||typeof digest!=='string'||!/^[0-9a-f]{64}$/.test(digest))throw Error('无效操作');
    if(approvalsInFlight.has(id))throw Error('审批正在执行');approvalsInFlight.add(id);
    let item;try{item=store.transition(id,['pending','retry','submitting'],'submitting',{},digest);}catch(e){approvalsInFlight.delete(id);throw e;}const gen=generation;
    try {const result=await call(item.request.path,item.request.method,item.request.body,token,tenant,{id:item.id,runId:item.runId});if(gen!==generation)throw Error('会话变化');if(result.ok)return store.transition(id,['submitting'],'succeeded',{result:result.data});if(result.status>=500)return store.transition(id,['submitting'],'retry',{message:'结果不确定，可安全重试'});return store.transition(id,['submitting'],'failed',{message:result.error?.message||'请求失败'});}
    catch {if(gen===generation)return store.transition(id,['submitting'],'retry',{message:'结果不确定，可安全重试'});throw Error('会话已变化');}finally{approvalsInFlight.delete(id);}
  });
  ipcMain.handle('crm:ego-install-guide', async event => {
    trusted(event);
    if (!token || !tenant) throw new Error('Authentication required');
    await shell.openExternal('https://www.egolite.ai/document/en/docs/windows/quick-start');
  });
  ipcMain.handle('crm:agent', async (event, action, value) => {
    trusted(event);
    if (!token || !tenant || !userId) throw new Error('Authentication required');
    if (action==='presets') return agentRequest('presets');
    if (action==='history') return agentRequest('history');
    if (action==='migration-status') return agentRequest('migration-status');
    if (action==='conversations'||action==='new-conversation') return agentRequest(action);
    if (action==='select-conversation' && typeof value==='string' && value.length<=100) return agentRequest(action,{conversationId:value});
    if (action==='evolve' && typeof value==='string' && value.length<=100) return agentRequest(action,{traceId:value});
    if (action==='evolution-history' && typeof value==='string' && /^\d{1,20}$/.test(value)) return agentRequest('evolution-history',{traceId:value});
    if (action==='evolution-tasks') return agentRequest('evolution-tasks');
    if (action==='evolution-decide' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion>0 && ['baseline','candidate'].includes(value.decision)) return agentRequest('evolution-decide',{value:{id:value.id,expectedVersion:value.expectedVersion,decision:value.decision}});
    if (action==='traces') return agentRequest('traces');
    if (action==='memory-status') return agentRequest('memory-status');
    if (action==='memory-page' && value && typeof value==='object' && ['active','pending'].includes(value.status) && (value.cursor===null || typeof value.cursor==='string' && value.cursor.length>0 && value.cursor.length<=512)) return agentRequest('memory-page',{value:{status:value.status,cursor:value.cursor}});
    if (action==='memory-skills' && Array.isArray(value) && value.length<=5 && value.every(name=>typeof name==='string' && name.length>0 && name.length<=100)) return agentRequest('memory-skills',{value:[...value]});
    if (action==='memory-sources' && typeof value==='string' && /^[0-9a-f-]{36}$/i.test(value)) return agentRequest('memory-sources',{value});
    if (action==='memory-review' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion>0 && ['accept','reject'].includes(value.decision) && (value.confirmedConflicts===undefined || Array.isArray(value.confirmedConflicts) && value.confirmedConflicts.length<=10 && value.confirmedConflicts.every(item=>item && typeof item.id==='string' && /^[0-9a-f-]{36}$/i.test(item.id) && Number.isSafeInteger(item.version) && item.version>0 && ['active','pending'].includes(item.status)))) return agentRequest('memory-review',{value:{id:value.id,expectedVersion:value.expectedVersion,decision:value.decision,confirmedConflicts:value.confirmedConflicts?.map(item=>({id:item.id,version:item.version,status:item.status}))}});
    if (action==='memory-update' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion>0 && ['edit','delete'].includes(value.operation) && (value.operation==='delete'||typeof value.content==='string'&&value.content.trim()&&value.content.length<=4000)) return agentRequest('memory-update',{value:{id:value.id,expectedVersion:value.expectedVersion,operation:value.operation,content:value.operation==='edit'?value.content:undefined}});
    if (action==='memory-search' && typeof value==='string' && value.trim() && value.length<=200) return agentRequest('memory-search',{value});
    if (action==='memory-semantic-model' && typeof value==='string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value)) return agentRequest('memory-semantic-model',{value});
    if (action==='memory-semantic' && typeof value==='boolean') return agentRequest('memory-semantic',{value});
    if (action==='memory-retry' && value && typeof value==='object' && typeof value.submissionId==='string' && /^\d{1,20}$/.test(value.submissionId) && ['writer','reflection','harvest'].includes(value.kind)) return agentRequest('memory-retry',{value:{submissionId:value.submissionId,kind:value.kind}});
    if (action==='memory-harvest' && typeof value==='string' && /^\d{1,20}$/.test(value)) return agentRequest('memory-harvest',{value});
    if (action==='memory-publish' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.digest==='string' && /^[0-9a-f]{64}$/i.test(value.digest)) return agentRequest('memory-publish',{value:{id:value.id,digest:value.digest}});
    if (action==='memory-reject' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.digest==='string' && /^[0-9a-f]{64}$/i.test(value.digest)) return agentRequest('memory-reject',{value:{id:value.id,digest:value.digest}});
    if (action==='memory-rollback' && value && typeof value==='object' && typeof value.id==='string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion>0) return agentRequest('memory-rollback',{value:{id:value.id,expectedVersion:value.expectedVersion}});
    if (action==='privacy-status') return {private:agentPrivate};
    if (action==='legacy-location') {const scope=createHash('sha256').update(`${tenant}:${userId}`).digest('hex');return inspectLegacy(path.join(app.getPath('userData'),'agent',scope,'session.sqlite'));}
    if (action==='privacy-mode' && typeof value==='boolean') { stopAgent();agentPrivate=value;return {private:agentPrivate}; }
    if (action==='demo-lead') return agentRequest('demo-lead');
    if (action==='configure-model' && typeof value==='string' && value.length>=10 && value.length<=512) return agentRequest('configure-model',{key:value});
    if (action==='chat' && typeof value==='string' && value.trim() && value.length<=8000) return agentRequest('chat',{text:value});
    if (action==='select-preset' && ['lead-opportunity','rag','creator'].includes(value)) return agentRequest('select-preset',{preset:value});
    if (action==='demo-search' && typeof value==='string' && value.length<=500) return agentRequest('demo-search',{query:value});
    if (action==='harness2-state') return agentRequest('harness2-state');
    if (action==='harness2-history') return agentRequest('harness2-history',{limit:100});
    if (action==='harness2-run' && Array.isArray(value) && value.length>=1 && value.length<=10 && value.every(task=>task&&typeof task==='object'&&!Array.isArray(task)&&typeof task.id==='string'&&task.id.length<=100&&typeof task.input==='string'&&task.input.length<=4000&&typeof task.expected==='string'&&task.expected.trim()&&task.expected.length<=300&&(task.domain===undefined||typeof task.domain==='string'))) return agentRequest('harness2-run',{tasks:value});
    if (action==='harness2-promote' && typeof value==='string' && /^cand_[0-9a-f-]{36}$/i.test(value)) return agentRequest('harness2-promote',{candidateId:value});
    if (action==='harness2-rollback' && typeof value==='string' && /^exp_[0-9a-f-]{36}$/i.test(value)) return agentRequest('harness2-rollback',{entryId:value});
    throw new Error('Invalid agent action');
  });
});
app.on('window-all-closed', () => { clearSession(); void agentStopping.finally(()=>app.quit()); });
