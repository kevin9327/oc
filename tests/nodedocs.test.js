import test from 'node:test';
import assert from 'node:assert/strict';

const { parseAll, buildEntries, searchEntries, resultsToHTML } = await import('../src/nodedocs.js');

const BASE = 'https://nodejs.org/api/';

// A miniature all.json: one module page with nested methods, classes,
// properties, and events, plus a class hoisted to the top level the way
// globals.md's classes are. Shapes copied from the real corpus, including
// the parts that must not become results: a signature's parameter list, and
// a property whose textRaw is its value type rather than a heading.
const ALL = {
  modules: [{
    textRaw: 'File system', name: 'fs', type: 'module', source: 'doc/api/fs.md',
    methods: [
      {
        textRaw: '`fs.readFile(path[, options], callback)`', name: 'readFile', type: 'method',
        signatures: [{ params: [{ textRaw: '`path` {string|Buffer|URL}', name: 'path' }] }],
      },
      { textRaw: '`fs.readFileSync(path[, options])`', name: 'readFileSync', type: 'method' },
    ],
    classes: [
      {
        textRaw: 'Class: `fs.ReadStream`', name: 'fs.ReadStream', type: 'class',
        events: [{ textRaw: "Event: `'close'`", name: 'close', type: 'event' }],
        properties: [
          { textRaw: '`readStream.bytesRead`', name: 'bytesRead', type: 'number' },
          { textRaw: 'Type: {boolean}', name: 'pending', type: 'boolean' },
        ],
      },
      {
        textRaw: 'Class: `fs.WriteStream`', name: 'fs.WriteStream', type: 'class',
        events: [{ textRaw: "Event: `'close'`", name: 'close', type: 'event' }],
      },
      // A property whose type line names the property itself, in the bare
      // {type} spelling fs.Utf8Stream uses.
      {
        textRaw: 'Class: `fs.Utf8Stream`', name: 'fs.Utf8Stream', type: 'class',
        properties: [{ textRaw: '{string} The file that is being written to.', name: 'file', type: 'string' }],
      },
    ],
  }],
  classes: [{
    textRaw: 'Class: `AbortController` <b>bold</b>', name: 'AbortController', type: 'class',
    source: 'doc/api/globals.md',
    // abortController.signal: its type line names the property too.
    properties: [{ textRaw: 'Type: {AbortSignal}', name: 'signal', type: 'AbortSignal' }],
  }],
};

test('only the docs corpus parses, so an error page never enters the cache', () => {
  assert.deepEqual(parseAll('{"modules": []}'), { modules: [] });
  assert.throws(() => parseAll('<html>blocked</html>'), /not the Node\.js docs corpus/);
  assert.throws(() => parseAll('{"error": "rate limited"}'), /not the Node\.js docs corpus/);
});

test('nested headings inherit their page and carry the anchor the docs use', () => {
  const entries = buildEntries(ALL);
  const readFile = entries.find((e) => e.name === 'readFile');
  assert.equal(readFile.page, 'fs.html');
  assert.equal(readFile.anchor, 'fsreadfilepath-options-callback');
  assert.equal(readFile.text, 'fs.readFile(path[, options], callback)');
  assert.equal(entries.find((e) => e.name === 'fs.ReadStream').anchor, 'class-fsreadstream');
  assert.equal(entries.find((e) => e.name === 'bytesRead').anchor, 'readstreambytesread');
});

test('a module heading is its page title, so its entry links to the page top', () => {
  const fs = buildEntries(ALL).find((e) => e.type === 'module');
  assert.equal(fs.page, 'fs.html');
  assert.equal(fs.anchor, '');
});

test('a heading repeated on one page is kept once, not listed as twins', () => {
  const closes = buildEntries(ALL).filter((e) => e.name === 'close');
  assert.deepEqual(closes.map((e) => e.anchor), ['event-close']);
});

test('parameter lists and Type: lines are not headings, so they are not results', () => {
  const entries = buildEntries(ALL);
  assert.equal(entries.find((e) => e.name === 'path'), undefined);
  assert.equal(entries.find((e) => e.name === 'pending'), undefined);
});

test('a type line that happens to name its property is still not a heading', () => {
  // 'Type: {AbortSignal}' contains 'signal' and '{string} The file that is
  // being written to.' contains 'file', but neither is the heading the page
  // has (#abortcontrollersignal), so neither may become a result, let alone
  // one linking to an id that does not exist.
  const entries = buildEntries(ALL);
  assert.equal(entries.find((e) => e.name === 'signal'), undefined);
  assert.equal(entries.find((e) => e.name === 'file'), undefined);
  const found = searchEntries(entries, 'signal');
  assert.equal(found.total, 0);
  assert.doesNotMatch(resultsToHTML(BASE, 'signal', found), /type-abortsignal/);
});

test('a word that is a symbol name outranks the heading that merely contains it', () => {
  const found = searchEntries(buildEntries(ALL), 'readFile');
  assert.equal(found.hits[0].name, 'readFile');
  assert.ok(found.hits.some((e) => e.name === 'readFileSync'));
  assert.equal(found.partial, false);
});

test('every word must match, and when none can, the page says the match is loose', () => {
  const strict = searchEntries(buildEntries(ALL), 'readFile close');
  assert.equal(strict.partial, true);
  assert.ok(strict.total > 0);
  assert.match(resultsToHTML(BASE, 'readFile close', strict), /no heading matches every word/);
});

test('results link into the live docs and name their kind and page', () => {
  const html = resultsToHTML(BASE, 'readfile', searchEntries(buildEntries(ALL), 'readfile'));
  assert.match(html, /href="https:\/\/nodejs\.org\/api\/fs\.html#fsreadfilepath-options-callback"/);
  assert.match(html, /method, in fs</);
  assert.match(html, /headings match in the docs' own reference, ranked locally:/);
});

test('a heading is corpus data, never markup on the results page', () => {
  const html = resultsToHTML(BASE, 'abortcontroller', searchEntries(buildEntries(ALL), 'abortcontroller'));
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /Class: AbortController &lt;b&gt;/);
  assert.match(html, /#class-abortcontroller-bboldb"/);
});

test('nothing matching renders an honest empty page, not an error', () => {
  const html = resultsToHTML(BASE, 'zzqqxx', searchEntries(buildEntries(ALL), 'zzqqxx'));
  assert.match(html, /nothing in the docs' own reference matches/);
  assert.doesNotMatch(html, /<ol>/);
});
