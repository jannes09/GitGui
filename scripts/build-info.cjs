'use strict';
// Run before electron-builder (see the dist scripts in package.json). Records where this build's installer goes,
// so the app can look there for a newer version without being told: electron/build-info.json is packed into the app.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const info = { releaseDir: path.join(root, 'release'), builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'electron', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: updates are looked for in ${info.releaseDir}`);
