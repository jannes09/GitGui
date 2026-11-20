'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitApi', {
  call: (method, args) => ipcRenderer.invoke('git:call', method, args),
  pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', title),
  installUpdate: (folder, version) => ipcRenderer.invoke('update:install', folder, version),
});
