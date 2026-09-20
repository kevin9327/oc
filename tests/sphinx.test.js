import test from 'node:test';
import assert from 'node:assert/strict';

const { parseIndex, searchIndex, resultsToHTML } = await import('../src/sphinx.js');

// A miniature docs.python.org: enough shape to exercise every lookup path
// (single-number terms, title boosts, stemmed words, object anchors) without
// a fixture file to drift out of date.
const INDEX = {
  docnames: ['library/json', 'library/threading', 'tutorial/appendix'],
  titles: [
    '<code class="pre">json</code> - JSON encoder and decoder',
    'threading - Thread-based parallelism',
    'Appendix',
  ],
  terms: { json: 0, thread: [1, 2], socket: [2] },
  titleterms: { json: [0], thread: [1] },
  // Live docs.python.org stores a module as ['json'] under prefix '' with
  // sentinel anchor '-': the HTML id is {objtype}-{fullname}, #module-json.
  objects: { '': [[0, 11, 0, '-', 'json']], json: [[0, 3, 1, '', 'dumps']] },
  objnames: {
    3: ['py', 'function', 'Python function'],
    11: ['py', 'module', 'Python module'],
  },
};
const BASE = 'https://docs.python.org/3/';

test('parseIndex unwraps Search.setIndex() and refuses anything else', () => {
  assert.equal(parseIndex('Search.setIndex({"a": 1})').a, 1);
  assert.throws(() => parseIndex('<html>a block page</html>'), /not a Sphinx search index/);
  assert.throws(() => parseIndex('Search.setIndex(undefined)'), /not a Sphinx search index/);
});

test('a title hit outranks body hits, and one-doc terms stored as a bare number work', () => {
  const found = searchIndex(INDEX, 'thread');
  assert.deepEqual(found.docs.map((d) => d.doc), [1, 2]);
  assert.equal(searchIndex(INDEX, 'json').docs[0].doc, 0);
});

test('a word Sphinx stemmed away still matches through its stem', () => {
  // The index stores 'thread'; a query typed as English says 'threading'.
  const found = searchIndex(INDEX, 'threading');
  assert.equal(found.docs[0].doc, 1);
});

test('titles are flattened to text before they reach the results page', () => {
  const found = searchIndex(INDEX, 'json');
  assert.equal(found.docs[0].title, 'json - JSON encoder and decoder');
});

test('a tag the title never closes is stripped, not left standing', () => {
  // 'json encoder <script src=' has no closing '>', so a strip that requires
  // one would hand '<script' onward. No '<' may survive the flattening.
  const nested = { ...INDEX, titles: ['json encoder <script src=', ...INDEX.titles.slice(1)] };
  const found = searchIndex(nested, 'json');
  assert.equal(found.docs[0].title, 'json encoder');
  assert.doesNotMatch(resultsToHTML(BASE, 'json', found, nested), /<script/);
});

test('every word must match, and when none can, any-word results say so', () => {
  // 'json' hits doc 0, 'socket' hits doc 2, nothing hits both.
  const found = searchIndex(INDEX, 'json socket');
  assert.equal(found.partial, true);
  const html = resultsToHTML(BASE, 'json socket', found, INDEX);
  assert.match(html, /no page matches every word/);
});

test('an exact symbol query becomes a direct link to its anchor', () => {
  const found = searchIndex(INDEX, 'json.dumps');
  assert.equal(found.objects.length, 1);
  const html = resultsToHTML(BASE, 'json.dumps', found, INDEX);
  assert.match(html, /href="https:\/\/docs\.python\.org\/3\/library\/json\.html#json\.dumps"/);
  assert.match(html, /Python function/);
});

test('a Sphinx "-" object anchor is the HTML id the docs use, not a literal hash dash', () => {
  // Sphinx searchtools.js: empty string -> fullname, '-' -> '{objtype}-{fullname}'.
  // docs.python.org marks every module this way; json's heading is #module-json.
  const found = searchIndex(INDEX, 'json');
  const mod = found.objects.find((o) => o.name === 'json');
  assert.equal(mod.anchor, 'module-json');
  const html = resultsToHTML(BASE, 'json', found, INDEX);
  assert.match(html, /href="https:\/\/docs\.python\.org\/3\/library\/json\.html#module-json"/);
  assert.match(html, /Python module/);
  assert.doesNotMatch(html, /#-"|href="[^"]+#-"/);
});

test('no matches renders an honest empty page, not an error', () => {
  const html = resultsToHTML(BASE, 'zzqqxx', searchIndex(INDEX, 'zzqqxx'), INDEX);
  assert.match(html, /nothing in the site's own search index matches/);
  assert.doesNotMatch(html, /<ol>/);
});
