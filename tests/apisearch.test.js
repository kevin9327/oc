import test from 'node:test';
import assert from 'node:assert/strict';

const { resultsToHTML } = await import('../src/apisearch.js');

// The MDN-shaped definition oc ships, minus the endpoint itself: which
// response fields hold the list, and what each result calls its parts.
const DEF = {
  results: 'documents',
  fields: { title: 'title', url: 'mdn_url', text: 'summary' },
  total: 'metadata.total.value',
};
const API = 'https://developer.mozilla.org/api/v1/search?q=map';

// A miniature /api/v1/search answer: a relative URL, a nested total, and a
// title that would be markup if it were ever trusted.
const DATA = {
  documents: [
    { mdn_url: '/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', title: 'Array.prototype.map()', summary: 'Creates a new array from results of a callback.' },
    { mdn_url: '/en-US/docs/Web/API/Map', title: 'Map <script>alert(1)</script>', summary: 'Holds key-value pairs.' },
  ],
  metadata: { total: { value: 2696 } },
};

test('results map through the named fields and resolve against the endpoint', () => {
  const html = resultsToHTML(DEF, 'map', DATA, API);
  assert.match(html, /href="https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/JavaScript\/Reference\/Global_Objects\/Array\/map"/);
  assert.match(html, /Array\.prototype\.map\(\)/);
  assert.match(html, /Creates a new array/);
});

test('the site total is reported, and result count is what the page shows', () => {
  assert.match(resultsToHTML(DEF, 'map', DATA, API), /2696 pages match, ranked by the site's own search, top 2 shown:/);
});

test('with no total, a list cut to fit says it went on', () => {
  // RubyGems answers a search with a bare array of 30 and no total. Cut to
  // 20, the page said 20 pages match and nothing about the other ten.
  const gems = Array.from({ length: 30 }, (_, i) => ({ name: `gem${i}`, url: `https://rubygems.org/gems/gem${i}` }));
  const def = { results: '', fields: { title: 'name', url: 'url' } };
  const api = 'https://rubygems.org/api/v1/search.json?query=rails';
  assert.match(resultsToHTML(def, 'rails', gems, api), /at least 30 pages match, ranked by the site's own search, top 20 shown:/);
  // A list that fits is still counted as it is.
  assert.match(resultsToHTML(def, 'rails', gems.slice(0, 5), api), /<p>5 pages match, ranked by the site's own search:<\/p>/);
});

test('a title is response data, never markup on the results page', () => {
  const html = resultsToHTML(DEF, 'map', DATA, API);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /Map &lt;script&gt;/);
});

test('a response with nothing in it renders an honest empty page, not an error', () => {
  const html = resultsToHTML(DEF, 'zzqqxx', { documents: [], metadata: { total: { value: 0 } } }, API);
  assert.match(html, /nothing in the site's own search matches/);
  assert.doesNotMatch(html, /<ol>/);
});

test('a response missing the fields a definition names still renders a page', () => {
  // A site that reshapes its API answer should cost a bad result list, not a
  // crash: no list means the empty page, a result with no title falls back
  // to its URL.
  assert.match(resultsToHTML(DEF, 'map', { unrelated: true }, API), /nothing in the site's own search/);
  const html = resultsToHTML(DEF, 'map', { documents: [{ mdn_url: '/en-US/docs/Web/API/Map' }], metadata: {} }, API);
  assert.match(html, />https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/API\/Map</);
});
