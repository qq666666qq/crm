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
const {createApprovalExecutor} = require('./approval-executor.cjs');
const {agentDatabaseKey} = require('./agent-key.cjs');
const {dispatchAgentAction} = require('./agent-actions.cjs');
const {createAgentHost} = require('./agent-host.cjs');
const {createSyncStream} = require('./sync-stream.cjs');
const {createCrmTransport} = require('./crm-transport.cjs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const api = new URL(process.env.CRM_API_URL || 'http://127.0.0.1:8000');
if (!['https:', 'http:'].includes(api.protocol) || api.username || api.password || (api.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(api.hostname))) throw new Error('CRM_API_URL must use HTTPS, except for loopback development');
let windowRef, token = null, tenant = null, userId = null, generation = 0, agentPrivate = false;
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
function clearRequests() { generation++; transport.reset(); syncStream.stop(); }
function stopAgent() { return agentHost.stop(); }
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
function resetWorkspace() { mockBackground.stop(); stopAgent(); agentPrivate=false; clearRequests(); runDetails.clear(); langfuseConfig=null; traceStorageError=null; userId=null; }
function clearSession(forget = false) { resetWorkspace(); token = null; tenant = null; if (forget) { try { cache().clear(); } catch {} } }
function launchAgent() {
  if(!token||!tenant||!userId)throw Error('Authentication required');
  const scope=createHash('sha256').update(`${api.origin}:${tenant}:${userId}`).digest('hex');
  const data=path.join(app.getPath('userData'),'agent',scope);
  const databaseKey=agentPrivate?null:agentDatabaseKey(safeStorage,data,scope);
  const child=utilityProcess.fork(path.join(__dirname,'../agent/worker.mjs'),[],{env:{CRM_AGENT_DATA_DIR:data,CRM_AGENT_PRIVATE:agentPrivate?'1':'0',SystemRoot:process.env.SystemRoot||''},stdio:'pipe'});
  return {child,initialize:()=>{if(databaseKey)child.postMessage({type:'initialize',key:databaseKey});}};
}
async function handleAgentMessage(child,message,originalGeneration) {
  if(!agentHost.isCurrent(child,originalGeneration))return;
  if(['crm-read','crm-propose'].includes(message?.type)&&typeof message.id==='string'&&message.id.length<=80){
    try {
      if(message.type==='crm-propose'){
        const type={'propose-company':'create_company','propose-contact':'create_contact','propose-opportunity':'create_opportunity','propose-task':'create_task','propose-activity':'create_activity','propose-company-update':'update_company','propose-contact-update':'update_contact','propose-task-complete':'complete_task','propose-lead':'create_lead','propose-conversion':'convert_lead','propose-lead-update':'update_lead','propose-opportunity-update':'update_opportunity'}[message.operation]||null;
        const item=approvals().create(type,message.args,message.callId,message.runId||undefined);send('crm:approval',{});
        child.postMessage({type:'crm-read-result',id:message.id,data:{id:item.id,status:item.status,message:item.status==='pending'?'已提交用户审核，尚未执行':'该工具调用已有记录，请查看实际状态'}});return;
      }
      const result=await call(readPath(message.operation,message.args));
      if(!agentHost.isCurrent(child,originalGeneration))return;
      if(!result.ok||JSON.stringify(result.data).length>100000)throw Error('CRM request failed');
      child.postMessage({type:'crm-read-result',id:message.id,data:result.data});
    } catch {if(agentHost.isCurrent(child,originalGeneration))child.postMessage({type:'crm-read-result',id:message.id,error:'CRM_READ_FAILED'});}
    return;
  }
  if(message?.type==='run-detail')void storeRunDetail(message.detail);
  else if(message?.type==='run-detail-ready'&&typeof message.id==='string')void handleSavedTrace(message.id).catch(()=>{});
  else if(message?.type==='trace-storage-error'){traceStorageError='TRACE_STORAGE_FAILED';send('crm:langfuse-status',{error:traceStorageError});}
  else if(message?.type==='memory-progress')send('crm:memory-progress',message.event);
  else if(message?.type==='evolution-progress'&&message.event)send('crm:evolution-progress',message.event);
  else if(message?.type==='evolution-progress'&&typeof message.stage==='string')send('crm:evolution-progress',{stage:message.stage});
  else if(message?.type==='runtime-report'&&['task_faulted','task_parked'].includes(message.event?.type))send('crm:agent-status',{state:'task',reason:message.event.type});
}
function agentRequest(type,payload={}) { return agentHost.request(type,payload); }
function trusted(event) { if (!windowRef || event.sender !== windowRef.webContents) throw new Error('Unauthorized IPC sender'); }
const transport = createCrmTransport({
  api,
  session: () => ({token,tenant,generation}),
  fetch: (...args) => fetch(...args),
  onRevoked: () => { clearSession(true); send('crm:revoked', {}); },
  onPermission: () => send('crm:permission', {}),
});
const call = transport.call;
const syncStream = createSyncStream({
  connect: transport.openSync,
  onConnection: state => send('crm:connection', state),
  onSync: data => send('crm:sync', data),
  onRevoked: () => { clearSession(true); send('crm:revoked', {}); },
});

const agentHost=createAgentHost({session:()=>({authenticated:Boolean(token&&tenant&&userId),generation,privateMode:agentPrivate}),launch:launchAgent,onMessage:handleAgentMessage,onStatus:status=>send('crm:agent-status',status),setTimer:setTimeout,clearTimer:clearTimeout});

const executeApproval = createApprovalExecutor({getStore:approvals,session:()=>({token,tenant,generation}),request:call});

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
    resetWorkspace(); tenant = id;
    const me = await call('/api/v1/auth/me');
    if (me.ok) { userId = me.data.user_id; cache().save(token, tenant); syncStream.start({token,tenant}); resumeMockBackground(); } else tenant = null;
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
      userId = me.data.user_id; syncStream.start({token,tenant}); resumeMockBackground();
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
    trusted(event);
    return executeApproval(action,id,digest);
  });
  ipcMain.handle('crm:ego-install-guide', async event => {
    trusted(event);
    if (!token || !tenant) throw new Error('Authentication required');
    await shell.openExternal('https://www.egolite.ai/document/en/docs/windows/quick-start');
  });
  ipcMain.handle('crm:agent', async (event, action, value) => {
    trusted(event);
    if (!token || !tenant || !userId) throw new Error('Authentication required');
    if (action==='privacy-status') return {private:agentPrivate};
    if (action==='legacy-location') {const scope=createHash('sha256').update(`${tenant}:${userId}`).digest('hex');return inspectLegacy(path.join(app.getPath('userData'),'agent',scope,'session.sqlite'));}
    if (action==='privacy-mode' && typeof value==='boolean') { stopAgent();agentPrivate=value;return {private:agentPrivate}; }
    return dispatchAgentAction(action,value,agentRequest);
  });
});
app.on('window-all-closed', () => { clearSession(); void agentHost.stopped().finally(()=>app.quit()); });
