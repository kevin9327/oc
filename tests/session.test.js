import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { modeSkip } from './helpers.js';

const OC_HOME = mkdtempSync(join(tmpdir(), 'oc-session-test-'));
process.env.OC_HOME = OC_HOME;
const MODE_SKIP = modeSkip(OC_HOME);

const { saveSession, sessionPath, sessionDir, assertSafeName } = await import('../src/session.js');

const page = { url: 'https://example.com/', title: 'Example', blocks: [] };

test('saveSession writes the page snapshot owner-only', async (t) => {
  saveSession('work', page);
  await t.test('mode is 0600', { skip: MODE_SKIP }, () => {
    assert.equal(statSync(sessionPath('work')).mode & 0o777, 0o600);
  });
});

test('the store directory is owner-only, and a loose one is tightened on save', async (t) => {
  mkdirSync(sessionDir(), { recursive: true });
  chmodSync(sessionDir(), 0o777);
  saveSession('loose', page);
  await t.test('mode is 0700', { skip: MODE_SKIP }, () => {
    assert.equal(statSync(sessionDir()).mode & 0o777, 0o700);
  });
});

test('a session named after a Windows device is refused', () => {
  // Names Win32 reads as devices rather than files. Current Node writes a real
  // file for each, so what this pins is the rule, not a reproducible failure.
  for (const name of ['nul', 'con', 'AUX', 'prn', 'com1', 'lpt9', 'nul.work']) {
    assert.throws(() => assertSafeName(name), /invalid session name/, name);
  }
  // Only the exact device names, and only before the first period.
  for (const name of ['nullify', 'console', 'com', 'com10', 'work.nul', 'my-aux']) {
    assert.equal(assertSafeName(name), name, name);
  }
});
