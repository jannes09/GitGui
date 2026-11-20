'use strict';
// The splash page has no scripts (its content security policy forbids them), so the version number is written
// into the HTML before it is loaded instead of being looked up by the page.

/** Fills `{{version}}` in the splash template. A value that does not look like a version number is left out. */
function splashHtml(template, version) {
  const ok = typeof version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(version);
  return template.replace('{{version}}', ok ? `Version ${version}` : '');
}

module.exports = { splashHtml };
