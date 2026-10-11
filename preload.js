const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('vault:getStatus'),
  init: (masterPassword) => ipcRenderer.invoke('vault:init', masterPassword),
  unlock: (masterPassword) => ipcRenderer.invoke('vault:unlock', masterPassword),
  lock: () => ipcRenderer.invoke('vault:lock'),

  listEntries: () => ipcRenderer.invoke('entry:list'),
  addEntry: (entry) => ipcRenderer.invoke('entry:add', entry),
  updateEntry: (id, patch) => ipcRenderer.invoke('entry:update', id, patch),
  deleteEntry: (id) => ipcRenderer.invoke('entry:delete', id),
  getTotp: (id) => ipcRenderer.invoke('entry:totp', id),

  generatePassword: (length, opts) => ipcRenderer.invoke('gen:password', length, opts),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:copy', text),

  reportActivity: () => ipcRenderer.invoke('session:activity'),
  getAutoLock: () => ipcRenderer.invoke('session:getAutoLock'),
  setAutoLock: (minutes) => ipcRenderer.invoke('session:setAutoLock', minutes),
  onAutoLocked: (cb) => ipcRenderer.on('auto-locked', () => cb()),

  exportData: (format) => ipcRenderer.invoke('io:export', format),
  importData: (format) => ipcRenderer.invoke('io:import', format),
  exportEncrypted: (masterPassword) => ipcRenderer.invoke('io:exportEncrypted', masterPassword),
  importEncrypted: (masterPassword) => ipcRenderer.invoke('io:importEncrypted', masterPassword)
});