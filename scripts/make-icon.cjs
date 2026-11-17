'use strict';
// Draws the app icon and writes build/icon.png (512px) and build/icon.ico (16 to 256px).
// Run with:  npx electron scripts/make-icon.cjs
// Electron renders the SVG, so no extra image library is needed.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;
// A commit graph: one branch leaves the main line and merges back, drawn with the app's own colours.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#262b35"/>
      <stop offset="1" stop-color="#14161b"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <rect x="17.5" y="17.5" width="477" height="477" rx="110.5" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="26">
    <path d="M176 130 V382" stroke="#2dd4bf"/>
    <path d="M176 382 C256 382 336 362 336 302 V210 C336 150 256 130 176 130" stroke="#a78bfa"/>
  </g>
  <g stroke-width="22" fill="#16181d">
    <circle cx="176" cy="130" r="36" stroke="#2dd4bf"/>
    <circle cx="176" cy="256" r="36" stroke="#2dd4bf"/>
    <circle cx="176" cy="382" r="36" stroke="#2dd4bf"/>
    <circle cx="336" cy="256" r="36" stroke="#a78bfa"/>
  </g>
</svg>`;

function ico(images) {
  // images: [{ size, png }]. PNG-compressed entries are valid in .ico files (Windows Vista and later).
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, at); // 0 means 256
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  let image = await win.webContents.capturePage();
  if (image.getSize().width !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: 'best' });

  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.png'), image.toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(
    path.join(out, 'icon.ico'),
    ico(sizes.map((size) => ({ size, png: nativeImage.createFromBuffer(image.toPNG()).resize({ width: size, height: size, quality: 'best' }).toPNG() }))),
  );

  // the rounded corners must be transparent, not black
  const px = image.toBitmap();
  console.log(`ICON_OK ${image.getSize().width}x${image.getSize().height} cornerAlpha=${px[3]} centreAlpha=${px[(256 * SIZE + 256) * 4 + 3]}`);
  app.quit();
});
