'use strict';
// Looking for a newer build of the app in a local folder (the one electron-builder writes the installer to),
// and checking that installer before it is run. Nothing here touches the network.
//
// The folder is expected to hold what `npm run dist:installer` produces: `latest.yml` (written by electron-builder)
// and the `GitGui-Setup-<version>.exe` it names. A newer build is one whose version number is higher than the
// running app's, so bump "version" in package.json before building a release.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const INSTALLER_RE = /^GitGui-Setup-(\d+\.\d+\.\d+)\.exe$/;
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;
const READ_TIMEOUT_MS = 5000;

function currentVersion() {
  return require('../package.json').version;
}

/** Written into the app by `npm run dist` / `dist:installer` (scripts/build-info.cjs); missing when running from source. */
function buildInfo() {
  try {
    return require('./build-info.json') || {};
  } catch {
    return {};
  }
}

/** Where to look when the user has not chosen a folder: the release folder this build was made in. */
function defaultFolder() {
  if (process.env.GITGUI_UPDATE_DIR) return process.env.GITGUI_UPDATE_DIR;
  const baked = buildInfo().releaseDir;
  if (typeof baked === 'string' && baked) return baked;
  const checkout = path.join(__dirname, '..', 'release'); // running from a source checkout
  return fs.existsSync(checkout) ? checkout : null;
}

function chooseFolder(folder) {
  return typeof folder === 'string' && folder.trim() ? folder.trim() : defaultFolder();
}

/** Positive when a is newer than b, negative when older, 0 when the same. Both are "major.minor.patch". */
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The top-level `key: value` lines of latest.yml (all this needs from it); quotes around a value are dropped. */
function parseLatest(text) {
  const top = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9]+):[ \t]*(.*?)\s*$/.exec(line);
    if (m) top[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return top;
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The update folder did not answer in time.')), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Reads and checks latest.yml and the installer it names. Throws a message fit for the user. */
async function readInfo(folder) {
  if (!path.isAbsolute(folder)) throw new Error('The update folder must be a full path such as C:\\Builds\\release.');
  const ymlPath = path.join(folder, 'latest.yml');
  let text;
  try {
    text = await fs.promises.readFile(ymlPath, 'utf8');
  } catch (e) {
    // a missing folder or drive, a folder without the file, or something else (permissions, a share that is down)
    const folderThere = await fs.promises.stat(folder).then((s) => s.isDirectory(), () => false);
    if (!folderThere) throw new Error(`The folder ${folder} does not exist or cannot be reached.`);
    if (e.code === 'ENOENT') throw new Error(`There is no latest.yml in ${folder}. Build the installer first (npm run dist:installer).`);
    throw new Error(`Cannot read ${ymlPath}: ${e.message}`);
  }
  const y = parseLatest(text);
  if (!VERSION_RE.test(y.version || '')) throw new Error('latest.yml does not contain a valid version.');
  const named = INSTALLER_RE.exec(y.path || '');
  if (!named || named[1] !== y.version) throw new Error('latest.yml does not point to a GitGui-Setup-<version>.exe installer.');
  if (!SHA512_RE.test(y.sha512 || '')) throw new Error('latest.yml does not contain a valid checksum.');
  const installer = path.join(folder, y.path);
  let stat;
  try {
    stat = await fs.promises.stat(installer);
  } catch {
    throw new Error(`latest.yml lists ${y.path}, but it is not in ${folder}.`);
  }
  if (!stat.isFile()) throw new Error(`${y.path} in ${folder} is not a file.`);
  const released = new Date(y.releaseDate || '');
  return {
    version: y.version,
    installer,
    sha512: y.sha512,
    size: stat.size,
    releaseDate: Number.isNaN(released.getTime()) ? null : released.toISOString(),
  };
}

/** Is there a newer version in the folder? Problems come back in `error` rather than being thrown. */
async function check({ folder } = {}) {
  const current = currentVersion();
  const where = chooseFolder(folder);
  const result = { current, folder: where, latest: null, available: false, size: null, releaseDate: null, error: null };
  if (!where) return { ...result, error: 'No update folder is set.' };
  try {
    const info = await withTimeout(readInfo(where), READ_TIMEOUT_MS);
    return { ...result, latest: info.version, available: compareVersions(info.version, current) > 0, size: info.size, releaseDate: info.releaseDate };
  } catch (e) {
    return { ...result, error: e.message };
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

/**
 * Everything to confirm before the installer is run: it is still newer than this app, it is the version the user was
 * told about, and its checksum matches latest.yml (so a half-written or damaged file is never started).
 */
async function verify({ folder, version } = {}) {
  const where = chooseFolder(folder);
  if (!where) throw new Error('No update folder is set.');
  const info = await withTimeout(readInfo(where), READ_TIMEOUT_MS);
  if (compareVersions(info.version, currentVersion()) <= 0) throw new Error('There is no newer version in the update folder.');
  if (version && version !== info.version) throw new Error(`The folder now holds version ${info.version}, not ${version}. Check again.`);
  const sum = await hashFile(info.installer);
  if (sum !== info.sha512) {
    throw new Error(`${path.basename(info.installer)} does not match the checksum in latest.yml. It may still be being built, or it is damaged.`);
  }
  return { version: info.version, installer: info.installer };
}

module.exports = { check, verify, compareVersions, parseLatest };
