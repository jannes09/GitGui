'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const handlers = require('./handlers.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || '';

function isTrusted(url) {
  return (DEV_URL && url.startsWith(DEV_URL)) || url.startsWith('file:');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#16181d',
    title: 'GitGui',
    icon: path.join(__dirname, '..', 'build', 'icon.png'), // window / taskbar icon (the exe gets its own from build/icon.ico)
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#12141a', symbolColor: '#cfd3dc', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrusted(url)) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  if (process.env.GITGUI_SMOKE) {
    // `npm run smoke`: prove the window loads and the preload bridge exists, then quit.
    win.webContents.on('did-finish-load', async () => {
      const bridge = await win.webContents.executeJavaScript('typeof window.gitApi?.call');
      console.log(`SMOKE_RESULT bridge=${bridge}`);
      setTimeout(() => app.quit(), 500);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`SMOKE_RESULT load-failed ${code} ${desc}`);
      app.quit();
    });
  }

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

ipcMain.handle('git:call', (event, method, args) => {
  if (!isTrusted(event.senderFrame ? event.senderFrame.url : '')) return { ok: false, error: 'Untrusted caller' };
  return handlers.call(method, args);
});

ipcMain.handle('dialog:pickFolder', async (event) => {
  if (!isTrusted(event.senderFrame ? event.senderFrame.url : '')) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Open repository' });
  return res.canceled ? null : res.filePaths[0];
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
