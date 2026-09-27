import test from 'node:test';
import assert from 'node:assert/strict';

const { parseMkdocsIndex, buildMkdocsEntries, searchMkdocs, resultsToHTML } = await import('../src/mkdocs.js');
const { distill } = await import('../src/distill.js');
const { resolveSite } = await import('../src/sites.js');

const BASE = 'https://docs.astral.sh/uv/';

// A miniature search_index.json in the shape uv's docs ship: page rows, the
// section rows under them, reference pages that repeat a section title, and
// a Material-style body stored as HTML.
const INDEX = JSON.stringify({
  config: { lang: ['en'], separator: '[\\s\\-]+' },
  docs: [
    { location: 'concepts/projects/dependencies/', title: 'Managing dependencies', text: 'Dependency fields. Adding dependencies. Dependency groups. Dependency sources.' },
    { location: 'concepts/projects/dependencies/#adding-dependencies', title: 'Adding dependencies', text: 'uv add httpx adds a dependency to the project.' },
    { location: 'concepts/projects/dependencies/#dependency-groups', title: 'Dependency groups', text: 'Use --group to add a dependency to a group.' },
    { location: 'reference/settings/', title: 'Settings', text: 'All settings.' },
    { location: 'reference/settings/#add-bounds', title: 'add-bounds', text: 'The default version specifier when adding a dependency.' },
    { location: 'reference/settings/#additional', title: 'Additional settings', text: 'Nothing about packages here.' },
    { location: 'rules/a/', title: 'rule-a (A001)', text: 'Rule A.' },
    { location: 'rules/a/#example', title: 'Example', text: '<p>import os <code>&lt;unused&gt;</code></p>' },
    { location: 'rules/b/', title: 'rule-b (B002)', text: 'Rule B.' },
    { location: 'rules/b/#example', title: 'Example', text: '<p>import sys, left unused</p>' },
    { location: 'evil/', title: 'evil<script>alert(1)</script>', text: 'dependency' },
  ],
});

const entries = () => buildMkdocsEntries(parseMkdocsIndex(INDEX));
const titles = (found) => found.hits.map((e) => e.text);

test('only an MkDocs index parses, so a 404 page never enters the cache', () => {
  assert.equal(parseMkdocsIndex(INDEX).docs.length, 11);
  assert.throws(() => parseMkdocsIndex('<!doctype html><title>404</title>'), /not an MkDocs search index/);
  assert.throws(() => parseMkdocsIndex('{"docs": [{"title": "no location"}]}'), /not an MkDocs search index/);
});

test('a section is named with the page it sits on, and HTML bodies become words', () => {
  const all = entries();
  const adding = all.find((e) => e.text === 'Adding dependencies');
  assert.equal(adding.page, 'Managing dependencies');
  assert.equal(adding.kind, 'section');
  assert.equal(all.find((e) => e.path === 'rules/a/#example').body, 'import os <unused>');
  assert.equal(all.find((e) => e.path === 'reference/settings/').kind, 'page');
});

test('a question in prose finds the section whose title answers it', () => {
  // "a", "how", "do", "I" match everything; "add" and "dependency" are the
  // question, and "Adding dependencies" holds both in its title.
  const found = searchMkdocs(entries(), 'how do I add a dependency');
  assert.deepEqual(found.words, ['add', 'dependency']);
  assert.equal(titles(found)[0], 'Adding dependencies');
  assert.ok(!titles(found).includes('Additional settings'), 'a stem matched a longer, different word');
  assert.ok(found.body.has(found.hits.find((e) => e.text === 'add-bounds')), 'a body match carries no excerpt');
  assert.ok(!found.body.has(found.hits[0]), 'a title match repeats its body');
});

test('when no section holds every word, the best partial matches say so', () => {
  const found = searchMkdocs(entries(), 'dependency xyzzy');
  assert.equal(found.partial, true);
  assert.ok(found.total > 0);
  assert.equal(searchMkdocs(entries(), 'xyzzy').total, 0);
});

test('the results page links each section, keeps repeated titles apart, and escapes', () => {
  const html = resultsToHTML(BASE, 'import unused', searchMkdocs(entries(), 'import unused'));
  assert.match(html, /<a href="https:\/\/docs\.astral\.sh\/uv\/rules\/a\/#example">Example \(rule-a \(A001\)\)<\/a> section: import os &lt;unused&gt;/);
  assert.match(html, /Example \(rule-b \(B002\)\)/);
  const evil = resultsToHTML(BASE, 'dependency', searchMkdocs(entries(), 'dependency'));
  assert.ok(!evil.includes('<script>'), 'a title reached the page as markup');
  const empty = resultsToHTML(BASE, 'xyzzy', searchMkdocs(entries(), 'xyzzy'));
  assert.match(empty, /nothing in the docs' own index matches/);
});

test('the MkDocs shortcuts resolve to their docs roots', () => {
  assert.equal(resolveSite('astral', ['uv', 'lockfile']).mkdocs, BASE);
  assert.equal(resolveSite('docs.astral.sh', ['ruff', 'unused import']).mkdocs, 'https://docs.astral.sh/ruff/');
  assert.equal(resolveSite('polars', ['search', 'lazy join']).mkdocs, 'https://docs.pola.rs/');
  assert.equal(resolveSite('mkdocs', ['search', 'site_name']).mkdocs, 'https://www.mkdocs.org/');
  assert.equal(resolveSite('material', ['search', 'annotations']).mkdocs, 'https://squidfunk.github.io/mkdocs-material/');
});

test('a <main> that holds the sidebars leads with the article, not the nav', () => {
  // Material for MkDocs puts the page nav and the table of contents inside
  // <main>, so the page led with every link in the site's navigation.
  const nav = Array.from({ length: 40 }, (_, i) => `<li><a href="/p${i}/">Page ${i}</a></li>`).join('');
  const prose = Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i} explains how uv resolves and locks the dependencies a project declares, in enough words to count.</p>`).join('');
  const html = `<html><body><header><a href="/">uv</a></header><main class="md-main"><div class="md-main__inner">`
    + `<div class="md-sidebar"><nav class="md-nav"><ul>${nav}</ul></nav></div>`
    + `<div class="md-sidebar md-sidebar--secondary"><nav class="md-nav"><ul><li><a href="#a">Section</a></li></ul></nav></div>`
    + `<div class="md-content"><article class="md-content__inner"><h1>Managing dependencies</h1>${prose}</article></div>`
    + `</div></main></body></html>`;
  const page = distill(html, `${BASE}concepts/projects/dependencies/`);
  const first = page.blocks.find((b) => b.text);
  assert.equal(first.text, 'Managing dependencies', `the page led with ${first.text}`);
  assert.ok(page.blocks.some((b) => b.text === 'Page 0'), 'the nav is gone rather than moved after the content');
});
