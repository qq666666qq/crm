const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('crm', {
  authAction: (action, body) => ipcRenderer.invoke('crm:auth-action', action, body),
  tenants: () => ipcRenderer.invoke('crm:tenants'),
  login: (email, password) => ipcRenderer.invoke('crm:login', email, password),
  selectTenant: id => ipcRenderer.invoke('crm:select-tenant', id),
  request: (path, method = 'GET', body) => ipcRenderer.invoke('crm:request', path, method, body),
  logout: () => ipcRenderer.invoke('crm:logout'),
  refresh: () => ipcRenderer.invoke('crm:refresh'),
  notify: (title, body) => ipcRenderer.invoke('crm:notify', title, body),
  on: (channel, handler) => {
    if (!['sync','revoked','connection','permission'].includes(channel)) throw new Error('Invalid event');
    const listener = (_event, data) => handler(data);
    ipcRenderer.on(`crm:${channel}`, listener);
    return () => ipcRenderer.removeListener(`crm:${channel}`, listener);
  }
});
