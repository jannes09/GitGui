'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitApi', {
  call: (method, args) => ipcRenderer.invoke('git:call', method, args),
  pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', title),
  installUpdate: (folder, version) => ipcRenderer.invoke('update:install', folder, version),
  watchRepos: (roots) => ipcRenderer.invoke('watch:set', roots),
  onRepoChanged: (cb) => {
    const listener = (_e, root) => cb(root);
    ipcRenderer.on('repo:changed', listener);
    return () => ipcRenderer.removeListener('repo:changed', listener);
  },
});
