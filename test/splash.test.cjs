// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { splashHtml } = require('../electron/splash-page.cjs');

const template = fs.readFileSync(path.join(__dirname, '..', 'electron', 'splash.html'), 'utf8');

test('the splash template has one place for the version', () => {
  assert.equal(template.split('{{version}}').length - 1, 1);
});

test('the version is written into the splash', () => {
  const html = splashHtml(template, '0.2.0');
  assert.match(html, /<div class="ver">Version 0\.2\.0<\/div>/);
  assert.equal(html.includes('{{version}}'), false);
});

test('a pre-release version is accepted', () => {
  assert.match(splashHtml(template, '1.0.0-beta.2'), /Version 1\.0\.0-beta\.2/);
});

test('anything that is not a plain version number is left out, never put into the page', () => {
  for (const bad of ['<script>alert(1)</script>', '0.2.0"><img src=x>', '', undefined, null, 5, 'a'.repeat(40), '1 2']) {
    const html = splashHtml(template, bad);
    assert.match(html, /<div class="ver"><\/div>/, String(bad));
    assert.equal(html.includes('<script'), false, String(bad));
    assert.equal(html.includes('{{version}}'), false, String(bad));
  }
});

test('the splash page still has no scripts', () => {
  assert.equal(/<script/i.test(template), false);
  assert.match(template, /default-src 'none'/);
});
