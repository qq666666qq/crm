const { app, BrowserWindow, ipcMain, Notification, Menu } = require('electron');
const path = require('node:path');

const api = new URL(process.env.CRM_API_URL || 'http://127.0.0.1:8000');
if (!['https:', 'http:'].includes(api.protocol) || api.username || api.password || (api.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(api.hostname))) throw new Error('CRM_API_URL must use HTTPS, except for loopback development');
let windowRef, token = null, tenant = null, generation = 0, streamAbort = null;
const pending = new Set();
// Preserve the key for an identical retry after an uncertain network outcome.
const retryKeys = new Map();

function send(channel, data) { if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, data); }
function clearRequests() { generation++; for (const c of pending) c.abort(); pending.clear(); if (streamAbort) streamAbort.abort(); streamAbort = null; }
function clearSession() { clearRequests(); retryKeys.clear(); token = null; tenant = null; }
function trusted(event) { if (!windowRef || event.sender !== windowRef.webContents) throw new Error('Unauthorized IPC sender'); }
function endpoint(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/v1/') || pathname.startsWith('/api/v1//') || pathname.includes('\\')) throw new Error('Invalid API path');
  const url = new URL(pathname, api);
  if (url.origin !== api.origin || !url.pathname.startsWith('/api/v1/')) throw new Error('Invalid API destination');
  return url;
}
async function call(pathname, method = 'GET', body, activeToken = token, activeTenant = tenant) {
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
      retryKey = JSON.stringify([activeTenant, method, pathname, body]);
      if (!retryKeys.has(retryKey)) {
        if (retryKeys.size >= 100) throw new Error('Too many unresolved requests; reconnect before retrying');
        retryKeys.set(retryKey, require('node:crypto').randomUUID());
      }
      headers['Idempotency-Key'] = retryKeys.get(retryKey);
    }
    const result = await fetch(endpoint(pathname), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    const data = await result.json().catch(() => ({}));
    if (current !== generation) throw new Error('Session changed');
    if (retryKey && result.status < 500) retryKeys.delete(retryKey);
    if (!result.ok) {
      if (result.status === 401 && !pathname.endsWith('/auth/login')) { clearSession(); send('crm:revoked', {}); }
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
      if (response.status === 401 || response.status === 403) { clearSession(); send('crm:revoked', {}); return; }
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
          if (event === 'revoked') { clearSession(); send('crm:revoked', {}); return; }
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
app.whenReady().then(() => {
  windowRef = new BrowserWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 640, backgroundColor: '#f5f7fa', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.on('will-navigate', e => e.preventDefault());
  if (!app.isPackaged && !app.commandLine.hasSwitch('production')) windowRef.loadURL('http://127.0.0.1:5173/');
  else windowRef.loadFile(path.join(__dirname, '../dist/index.html'));
  windowRef.once('ready-to-show', () => { if (windowRef.isMinimized()) windowRef.restore(); windowRef.show(); windowRef.focus(); });
  ipcMain.handle('crm:login', async (event, email, password) => {
    trusted(event); clearSession();
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
    if (result.ok && action === 'change') { clearSession(); send('crm:revoked', {}); }
    return result;
  });
  ipcMain.handle('crm:tenants', async event => { trusted(event); if (!token) throw new Error('Authentication required'); return call('/api/v1/auth/tenants', 'GET', undefined, token, null); });
  ipcMain.handle('crm:select-tenant', async (event, id) => {
    trusted(event); if (!token || typeof id !== 'string') throw new Error('Authentication required');
    clearRequests(); retryKeys.clear(); tenant = id;
    const me = await call('/api/v1/auth/me');
    if (me.ok) subscribe(); else tenant = null;
    return me;
  });
  ipcMain.handle('crm:request', async (event, pathname, method, body) => {
    trusted(event); if (!token || !tenant) throw new Error('Authentication required');
    if (pathname.startsWith('/api/v1/auth/') || pathname.startsWith('/api/v1/sync/')) throw new Error('Reserved API path');
    return call(pathname, method, body);
  });
  ipcMain.handle('crm:refresh', async event => {
    trusted(event); if (!token || !tenant) throw new Error('Authentication required');
    const result = await call('/api/v1/auth/me');
    if (!result.ok && (result.status === 401 || result.status === 403)) { clearSession(); send('crm:revoked', {}); }
    return result;
  });
  ipcMain.handle('crm:logout', async event => { trusted(event); try { if (token) await call('/api/v1/auth/logout', 'POST'); } finally { clearSession(); } return true; });
  ipcMain.handle('crm:notify', (event, title, body) => { trusted(event); if (Notification.isSupported() && typeof title === 'string' && typeof body === 'string') new Notification({title:title.slice(0,120), body:body.slice(0,300)}).show(); });
});
app.on('window-all-closed', () => { clearSession(); app.quit(); });
