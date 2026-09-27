import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distill, toMarkdown } from '../src/distill.js';
import { resolveSite } from '../src/sites.js';

// Trimmed copies of real answers from users.rust-lang.org: the latest topic
// list, a topic search for "async trait", and one topic from /raw.
const fixture = (name) => readFileSync(new URL(`./pages/${name}`, import.meta.url), 'utf8');
const texts = (page) => page.blocks.map((b) => b.text ?? '');
const view = (args, name) => {
  const r = resolveSite('urlo', args);
  return distill(fixture(name), r.url, { view: r.view });
};

test('each forum resolves its lists to JSON and a topic to its Markdown source', () => {
  assert.equal(resolveSite('urlo', ['latest']).url, 'https://users.rust-lang.org/latest.json');
  assert.equal(resolveSite('swift', ['search', 'async let']).url, 'https://forums.swift.org/search.json?q=async%20let');
  assert.equal(resolveSite('nixos', ['topic', '80221']).url, 'https://discourse.nixos.org/raw/80221');
  // The docs keep the rust-lang label; the forum answers to its usual name.
  assert.equal(resolveSite('rust-lang', ['std', 'vec']).domain, 'doc.rust-lang.org');
});

test('a topic list is a title, a count, and a link to follow per topic', () => {
  const page = view(['latest'], 'discourse_latest.json');
  const lines = texts(page);
  assert.deepEqual(lines.slice(0, 3), [
    'Welcome to the Rust programming language users forum',
    '2 posts, last 2022-06-24 15:56:48',
    'https://users.rust-lang.org/raw/77411',
  ]);
  const link = page.blocks.find((b) => b.text === 'https://users.rust-lang.org/raw/77411');
  assert.equal(link.href, 'https://users.rust-lang.org/raw/77411', 'the topic was not followable');
  assert.equal(lines.filter((l) => l.includes('/raw/')).length, 4);
});

test('a search lists topics and says which one has an accepted answer', () => {
  const lines = texts(view(['search', 'async trait'], 'discourse_search.json'));
  assert.equal(lines[0], 'Async_trait lifetime conflicting requirements');
  assert.equal(lines[1], '3 posts, started 2021-11-18 05:33:18 | has_accepted_answer');
  assert.equal(lines[2], 'https://users.rust-lang.org/raw/67557');
  assert.ok(!lines[4].includes('has_accepted_answer'), 'an unanswered topic claimed an answer');
});

test('only a template that is itself a URL becomes a link', () => {
  const data = JSON.stringify([{ title: 'x', id: '//evil.test/a', note: 'https://evil.test/' }]);
  const url = 'https://forum.test/latest.json';
  const page = distill(data, url, { view: { keep: ['title', '/raw/{id}', '{note}'], list: '' } });
  const hrefs = page.blocks.filter((b) => b.href).map((b) => b.href);
  assert.equal(hrefs.length, 1, 'a URL in a field value became a link');
  assert.equal(new URL(hrefs[0]).host, 'forum.test', 'a field value moved the link to another host');
});

test('a topic reads as text, one block per paragraph, with each post under its author', () => {
  const url = 'https://users.rust-lang.org/raw/67557';
  const lines = texts(distill(fixture('discourse_topic.txt'), url, { type: 'text/plain; charset=utf-8' }));
  assert.equal(lines[0], 'ccqpein | 2021-11-18 05:33:18 UTC | #1');
  assert.ok(lines.includes('Yandros | 2021-11-18 11:10:45 UTC | #3'));
  assert.ok(lines.some((l) => l.includes("trait App<'a> {")), 'the generics were read as tags');
});

test('a body the server calls text stays text even when a post quotes markup', () => {
  // A /raw path names no text format, so a post that mentions a <div> or a
  // <br> turned the whole topic into HTML and dropped the quoted tags.
  const topic = 'alice | 2026-09-01 10:00:00 UTC | #1\n\nWhy does <div> collapse my <br> tags?\n\n-------------------------\n\nbob | 2026-09-01 11:00:00 UTC | #2\n\nUse CSS instead.';
  const url = 'https://forum.test/raw/1';
  const text = texts(distill(topic, url, { type: 'text/plain; charset=utf-8' }));
  assert.ok(text.includes('Why does <div> collapse my <br> tags?'), text.join('\n'));
  assert.match(toMarkdown(topic, url, { type: 'text/plain' }), /Why does <div> collapse my <br> tags\?/);
  // Without the header the same body is still sniffed as HTML, as before.
  assert.ok(!texts(distill(topic, url)).includes('Why does <div> collapse my <br> tags?'));
  // A server that mislabels a whole page as text still gets it parsed.
  assert.equal(distill('<!doctype html><title>t</title><p>page</p>', url, { type: 'text/plain' }).title, 't');
});
