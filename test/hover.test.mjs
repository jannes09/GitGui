// Run with: npm test
// Everything that can be clicked must look clickable: a pointer cursor and a hover effect.
// Reads src/styles.css and the components as text, so a new clickable element that forgets either fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync('src/styles.css', 'utf8');
const BACKSLASH = String.fromCharCode(92);

/** classes of the rules that set a pointer cursor, and of the rules that have a :hover state */
const pointerClasses = new Set();
const hoverClasses = new Set();
for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  for (const part of selector.split(',')) {
    const classes = [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    if (/cursor:\s*pointer/.test(body)) classes.forEach((c) => pointerClasses.add(c));
    if (part.includes(':hover')) {
      // the classes up to the :hover are the hovered element's (a `.row:hover .child` rule hovers `.child` too)
      [...part.slice(0, part.lastIndexOf(':hover') + 6).matchAll(/\.([\w-]+)/g)].forEach((m) => hoverClasses.add(m[1]));
    }
  }
}

/** Every JSX opening tag in the components, with its attribute text. */
function* jsxTags() {
  const dir = 'src/components';
  const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), 'src/App.tsx'].filter((f) => f.endsWith('.tsx'));
  for (const file of files) {
    const s = fs.readFileSync(file, 'utf8');
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '<' || !/[a-zA-Z]/.test(s[i + 1] || '')) continue;
      const m = /^<([A-Za-z][\w.]*)/.exec(s.slice(i, i + 40));
      let j = i + m[0].length;
      let depth = 0;
      let q = null;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (q) {
          if (ch === q && s[j - 1] !== BACKSLASH) q = null;
          continue;
        }
        if (ch === '"' || ch === "'" || (depth > 0 && ch === '`')) q = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (depth === 0 && ch === '>') break;
      }
      const attrs = s.slice(i, j);
      const cls = /className=(?:"([^"]*)"|\{([^}]*)\})/.exec(attrs);
      const raw = cls ? (cls[1] ?? cls[2]) : '';
      yield {
        tag: m[1],
        where: `${file}:${s.slice(0, i).split('\n').length}`,
        classes: [...raw.matchAll(/[\w-]+/g)].map((x) => x[0]).filter((c) => /^[a-z]/.test(c) && css.includes(`.${c}`)),
        clickable: /\b(onClick|onDoubleClick|onMouseDown|onPointerDown)=/.test(attrs) || /role="(button|link|tab|menuitem)"/.test(attrs),
      };
    }
  }
}
const tags = [...jsxTags()];
const has = (set, classes) => classes.some((c) => set.has(c));

test('buttons get a pointer from one global rule, and a disabled button does not', () => {
  assert.match(css, /(^|\n)button\s*\{\s*cursor:\s*pointer;\s*\}/);
  assert.match(css, /button:disabled\s*\{[^}]*cursor:\s*default/);
});

test('every button has a hover effect', () => {
  const missing = tags.filter((t) => t.tag === 'button' && !has(hoverClasses, t.classes)).map((t) => `${t.where} (${t.classes.join('.') || 'no class'})`);
  assert.deepEqual(missing, []);
});

test('every clickable element that is not a button has a pointer cursor and a hover effect', () => {
  // dialog backdrops and panels only catch clicks, splitters have their own resize cursor, and components such as
  // <Action> render a button themselves
  const skip = (t) => /^[A-Z]/.test(t.tag) || /^(button|input|textarea|select|option)$/.test(t.tag) || t.classes.some((c) => /^(modal|modal-backdrop|splitter)$/.test(c));
  const clickable = tags.filter((t) => t.clickable && !skip(t));
  assert.ok(clickable.length >= 10, `expected to find the clickable rows, found ${clickable.length}`);
  const noPointer = clickable.filter((t) => !has(pointerClasses, t.classes)).map((t) => `${t.where} <${t.tag} class="${t.classes.join(' ')}">`);
  const noHover = clickable.filter((t) => !has(hoverClasses, t.classes)).map((t) => `${t.where} <${t.tag} class="${t.classes.join(' ')}">`);
  assert.deepEqual(noPointer, [], 'no pointer cursor');
  assert.deepEqual(noHover, [], 'no hover effect');
});

test('the rows people click all point and highlight', () => {
  for (const c of ['g-row', 'sb-item', 'f-row', 'rt-tab', 'pill-pr', 'sb-pr']) {
    assert.ok(pointerClasses.has(c), `${c} needs cursor: pointer`);
    assert.ok(hoverClasses.has(c), `${c} needs a hover rule`);
  }
});

test('labels that toggle something point and highlight, and so do their checkboxes', () => {
  for (const c of ['check', 'set-row']) {
    assert.ok(pointerClasses.has(c), `${c} needs cursor: pointer`);
    assert.ok(hoverClasses.has(c), `${c} needs a hover rule`);
  }
  assert.match(css, /input\[type='checkbox'\][^{]*\{\s*cursor:\s*pointer/);
});

test('graph rows cannot be selected, so a double-click never highlights a word', () => {
  const rule = /\.g-row\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /user-select:\s*none/);
});
