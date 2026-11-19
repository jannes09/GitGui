'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const handlers = require('./handlers.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || '';

function isTrusted(url) {
  return (DEV_URL && url.startsWith(DEV_URL)) || url.startsWith('file:');
}

// The splash: a small frameless window with a commit graph that draws itself, shown at once while the real
// window loads in the background. It stays at least MIN_SPLASH_MS so the animation can finish, then fades out.
const MIN_SPLASH_MS = 1800;
const t0 = Date.now();
const log = (what) => {
  if (process.env.GITGUI_SPLASH_LOG) console.log(`SPLASH ${what} +${Date.now() - t0}ms`);
};

function createSplash() {
  const splash = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    center: true,
    title: 'GitGui',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splash.webContents.on('will-navigate', (e) => e.preventDefault());
  splash.once('ready-to-show', () => {
    log('shown');
    splash.show();
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  return splash;
}

function createWindow() {
  // no splash for the headless smoke check, which has no screen to show it on
  const splash = process.env.GITGUI_SMOKE ? null : createSplash();
  let splashShownAt = Date.now();
  splash?.once('show', () => (splashShownAt = Date.now()));
  const closeSplash = () => {
    if (!splash || splash.isDestroyed()) return;
    splash.webContents.executeJavaScript("document.body.classList.add('bye')").catch(() => {});
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close();
      log('closed');
    }, 220);
  };

  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 960,
    minHeight: 560,
    show: false, // shown once maximised, so the window never flashes at its normal size first
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

  // The window is always shown maximised (the width and height above are only what "restore down" returns to).
  // Not maximised here: on Windows maximize() also shows a hidden window, which put the empty app on screen
  // before the splash, so the splash appeared on top of an app that had already opened.
  let revealing = false;
  let revealed;
  const whenRevealed = new Promise((resolve) => (revealed = resolve));
  const reveal = () => {
    if (revealing) return;
    revealing = true;
    // keep the splash up long enough for its animation, however quickly the window got ready
    const wait = splash ? Math.max(0, MIN_SPLASH_MS - (Date.now() - splashShownAt)) : 0;
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.maximize(); // shows the window as well
        if (!win.isVisible()) win.show();
      }
      log('main shown');
      revealed();
      closeSplash();
      if (process.env.GITGUI_SPLASH_LOG) setTimeout(() => app.quit(), 700); // for the automated check of this sequence
    }, wait);
  };
  win.on('show', () => log('main window visible'));
  splash?.on('show', () => log('splash visible'));
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 5000); // never leave the window hidden if the page is slow to paint
  win.on('closed', () => {
    if (splash && !splash.isDestroyed()) splash.close();
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
      await whenRevealed; // maximised when it is shown
      console.log(`SMOKE_RESULT bridge=${bridge} maximized=${win.isMaximized()}`);
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
