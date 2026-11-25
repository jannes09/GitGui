'use strict';
// Reads the progress lines `git clone --progress` writes to stderr ("Receiving objects:  45% (50/110), 1.2 MiB | 2 MiB/s")
// and turns them into one overall percentage that only moves forward.

// Where each step sits in the whole clone. Receiving the objects is by far the longest.
const STEPS = {
  'counting objects': [0, 5],
  'compressing objects': [5, 10],
  'receiving objects': [10, 70],
  'resolving deltas': [70, 85],
  'updating files': [85, 100],
};

const LINE = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%\s+\((\d+)\/(\d+)\)(.*)$/;

/** One stderr line -> { step, percent (0-100, overall), detail } or null when it is not a progress line. */
function parseLine(line) {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  const range = STEPS[m[1].toLowerCase()];
  if (!range) return null;
  const within = Math.min(Number(m[2]), 100);
  const detail = m[5]
    .replace(/,\s*done\.?\s*$/, '')
    .replace(/^\s*,\s*/, '')
    .trim();
  return {
    step: m[1],
    percent: Math.round(range[0] + ((range[1] - range[0]) * within) / 100),
    detail,
  };
}

/**
 * Git redraws its progress on one line with carriage returns, and a chunk can end in the middle of a line.
 * `write` takes the stderr chunks as they arrive; `onProgress` is called when the step or the overall percentage changes.
 */
function createProgressParser(onProgress) {
  const { StringDecoder } = require('node:string_decoder');
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let best = -1;
  let lastKey = '';

  const handle = (line) => {
    const p = parseLine(line);
    if (!p) return;
    if (p.percent < best) return; // a line from an earlier step arriving late: the bar never moves back
    best = p.percent;
    const key = `${p.step}|${p.percent}`;
    if (key === lastKey) return;
    lastKey = key;
    onProgress(p);
  };

  return {
    write(chunk) {
      const parts = (pending + decoder.write(chunk)).split(/[\r\n]+/);
      pending = parts.pop();
      parts.forEach(handle);
    },
    end() {
      handle(pending + decoder.end());
      pending = '';
    },
  };
}

module.exports = { parseLine, createProgressParser };
