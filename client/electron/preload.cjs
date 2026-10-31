const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('crm', {
  authAction: (action, body) => ipcRenderer.invoke('crm:auth-action', action, body),
  tenants: () => ipcRenderer.invoke('crm:tenants'),
  login: (email, password) => ipcRenderer.invoke('crm:login', email, password),
  restoreSession: () => ipcRenderer.invoke('crm:restore-session'),
  selectTenant: id => ipcRenderer.invoke('crm:select-tenant', id),
  request: (path, method = 'GET', body) => ipcRenderer.invoke('crm:request', path, method, body),
  logout: () => ipcRenderer.invoke('crm:logout'),
  refresh: () => ipcRenderer.invoke('crm:refresh'),
  notify: (title, body) => ipcRenderer.invoke('crm:notify', title, body),
  openEgoInstallGuide: () => ipcRenderer.invoke('crm:ego-install-guide'),
  agent: (action, value) => ipcRenderer.invoke('crm:agent', action, value),
  modules: (action, value, revision) => ipcRenderer.invoke('crm:modules', action, value, revision),
  moduleRecords: (action, id, value) => ipcRenderer.invoke('crm:module-records', action, id, value),
  mockSync: (action, destination, key) => ipcRenderer.invoke('crm:mock-sync', action, destination, key),
  mockBackground: (action, target) => ipcRenderer.invoke('crm:mock-background', action, target),
  exportDataset: cases => ipcRenderer.invoke('crm:export-dataset', cases),
  exportTraces: () => ipcRenderer.invoke('crm:export-traces'),
  approvals: (action, id, digest) => ipcRenderer.invoke('crm:approvals', action, id, digest),
  langfuse: (action, value) => ipcRenderer.invoke('crm:langfuse', action, value),
  on: (channel, handler) => {
    if (!['sync','revoked','connection','permission','approval','evolution-progress','memory-progress','langfuse-status','agent-status'].includes(channel)) throw new Error('Invalid event');
    const listener = (_event, data) => handler(data);
    ipcRenderer.on(`crm:${channel}`, listener);
    return () => ipcRenderer.removeListener(`crm:${channel}`, listener);
  }
});
