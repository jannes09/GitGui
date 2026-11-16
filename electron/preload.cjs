'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitApi', {
  call: (method, args) => ipcRenderer.invoke('git:call', method, args),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
});
