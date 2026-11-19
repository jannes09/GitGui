'use strict';
// Draws the app icon and writes build/icon.png (512px) and build/icon.ico (16 to 256px).
// Run with:  npm run icon      (that is: electron scripts/make-icon.cjs)
// Electron renders the SVG, so no extra image library is needed. Every size is drawn from the
// vector at its own size (not shrunk from a big bitmap), and the small ones use heavier lines,
// so the icon stays readable on a taskbar.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// A commit graph: a main line with three commits and a branch that leaves it and merges back.
// White on a bright teal-to-blue tile, so it stands out on dark and light taskbars alike.
function svg(size) {
  const small = size <= 40; // thicker lines and bigger dots when there are few pixels
  const line = small ? 62 : 46;
  const dot = small ? 66 : 52;
  const hole = small ? 0 : 20; // the dark centre of each commit, left out when it would be too small to see
  const nodes = [
    [150, 104],
    [150, 256],
    [150, 408],
    [362, 256],
  ];
  const circles = nodes
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${dot}" fill="#ffffff"/>` + (hole ? `<circle cx="${x}" cy="${y}" r="${hole}" fill="#0f766e"/>` : ''))
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2dd4bf"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#0b1b3a" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="6" y="6" width="500" height="500" rx="${small ? 112 : 118}" fill="url(#bg)"/>
  <g fill="none" stroke="#ffffff" stroke-width="${line}" stroke-linecap="round" stroke-linejoin="round" ${small ? '' : 'filter="url(#shadow)"'}>
    <path d="M150 104 V408"/>
    <path d="M150 408 C262 408 362 384 362 300 V212 C362 128 262 104 150 104" stroke="#0b1b3a" stroke-opacity="0.78"/>
  </g>
  <g ${small ? '' : 'filter="url(#shadow)"'}>${circles}</g>
</svg>`;
}

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
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true },
  });

  // draws one size and returns it as a PNG of exactly size x size pixels
  const render = async (size) => {
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg(size)}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 250));
    let image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    if (image.getSize().width !== size) image = image.resize({ width: size, height: size, quality: 'best' });
    return image;
  };

  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  const big = await render(512);
  fs.writeFileSync(path.join(out, 'icon.png'), big.toPNG());
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const images = [];
  for (const size of sizes) images.push({ size, png: (await render(size)).toPNG() });
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(images));

  // the rounded corners must be transparent, and the middle of the tile must be solid
  const px = big.toBitmap();
  const corner = px[3];
  const centre = px[(40 * 512 + 256) * 4 + 3];
  console.log(`ICON_OK ${big.getSize().width}x${big.getSize().height} sizes=${sizes.join(',')} cornerAlpha=${corner} tileAlpha=${centre}`);
  app.quit();
});
