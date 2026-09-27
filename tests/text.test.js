import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distill, toMarkdown, toHTML } from '../src/distill.js';
import { resolveSite } from '../src/sites.js';

// The tldr page for tar, as raw.githubusercontent.com serves it. A Windows
// checkout turns its line ends into CRLF, which the renderer normalises, so
// the fixture is normalised the same way before it is compared to itself.
const tldr = readFileSync(new URL('./pages/tldr_tar.md', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const TLDR_URL = 'https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/common/tar.md';
const source = 'const a = b < c;\nfunction f() {}\n\nexport type X = Record<string, T>;\n';
const SOURCE_URL = 'https://raw.githubusercontent.com/only-cli/oc/HEAD/src/x.ts';
const texts = (page) => page.blocks.map((b) => b.text ?? '');

test('a text file renders one block per paragraph, with its line breaks kept', () => {
  const page = distill(tldr, TLDR_URL);
  assert.equal(page.title, 'tar', 'the first Markdown heading is the title');
  const lines = texts(page);
  assert.equal(page.blocks[0].type, 'heading');
  assert.ok(lines[1].startsWith('> Archiving utility.\n> Often combined'), lines[1]);
  assert.ok(lines.includes('`tar cf {{path/to/target.tar}} {{path/to/file1 path/to/file2 ...}}`'), 'an example command is not a block of its own');
  assert.ok(lines.length >= 10, `a tldr page has a dozen paragraphs, got ${lines.length}`);
});

test('a source file keeps its angle brackets, which the HTML parser used to eat', () => {
  const page = distill(source, SOURCE_URL);
  assert.equal(page.title, 'raw.githubusercontent.com/only-cli/oc/HEAD/src/x.ts');
  assert.deepEqual(texts(page), ['const a = b < c;\nfunction f() {}', 'export type X = Record<string, T>;']);
});

test('only a heading that opens the file becomes its title', () => {
  const later = distill('Some prose first.\n\n# More information\n\nmore', 'https://x.test/README.md');
  assert.equal(later.title, 'x.test/README.md', 'a later heading named the file');
  assert.equal(distill('Inkscape. Draw Freely.\n======\n\nprose', 'https://x.test/README.md').title, 'Inkscape. Draw Freely.');
});

test('a Markdown file that opens with an HTML logo block is still text', () => {
  const readme = '<div align="center">\n  <h1>Welcome</h1>\n</div>\n\nHi there! Tired of big platforms?\n\n## What does it offer?';
  const lines = texts(distill(readme, 'https://codeberg.org/forgejo/forgejo/raw/branch/HEAD/README.md'));
  assert.ok(lines.includes('Hi there! Tired of big platforms?'), `the prose after the logo was dropped:\n${lines.join('\n')}`);
  assert.ok(lines.includes('What does it offer?'));
  // A text path that answers with a whole HTML document is a page.
  assert.deepEqual(texts(distill('<!doctype html><html><body><p>hi</p></body></html>', 'https://x.test/notes.md')), ['hi']);
});

test('a body that is HTML, even one opening with text, still parses as HTML', () => {
  assert.deepEqual(texts(distill('<html><body><p>hi there</p></body></html>', 'https://x.test/')), ['hi there']);
  const fragment = distill('Hello <div><p>world</p> and <a href="/x">more</a></div>', 'https://x.test/');
  assert.ok(!texts(fragment).some((t) => t.includes('<p>')), 'a fragment opening with text was taken for a text file');
  assert.ok(fragment.blocks.some((b) => b.type === 'link'), 'the link was lost');
  // JSON is a page of its own already and never reaches the text rule.
  assert.match(toMarkdown('{"status":"ok"}', 'https://x.test/health'), /^# x\.test\/health/);
  assert.equal(distill('   \n', 'https://x.test/empty').blocks.length, 0);
});

test('raw hands a text file back as itself', () => {
  assert.equal(toMarkdown(source, SOURCE_URL), source.trimEnd());
  assert.equal(toMarkdown(tldr, TLDR_URL), tldr.trimEnd());
  assert.ok(!toMarkdown(tldr, TLDR_URL).includes('\\#'), 'the converter escaped the file');
  assert.ok(toHTML(source, SOURCE_URL).includes('<pre>const a = b &lt; c;\nfunction f() {}\n\nexport type X = Record&lt;string, T&gt;;</pre>'));
});

test('the reference shortcuts resolve, and a file path keeps its slashes', () => {
  assert.equal(resolveSite('tldr', ['page', 'tar']).url, TLDR_URL);
  assert.equal(resolveSite('tldr.sh', ['linux', 'apt']).url, 'https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/linux/apt.md');
  assert.equal(resolveSite('man', ['page', '2', 'open']).url, 'https://man7.org/linux/man-pages/man2/open.2.html');
  assert.equal(resolveSite('man7', ['search', 'file descriptor']).url, 'https://html.duckduckgo.com/html/?q=site%3Aman7.org%2Flinux%2Fman-pages+file%20descriptor');
  assert.equal(resolveSite('rfc', ['rfc', '9110']).url, 'https://www.rfc-editor.org/rfc/rfc9110.html');
  assert.equal(resolveSite('rfc-editor', ['search', 'http semantics']).url, 'https://html.duckduckgo.com/html/?q=site%3Arfc-editor.org%2Frfc+http%20semantics');
  assert.equal(resolveSite('gh', ['file', 'only-cli', 'oc', 'src/sites.js']).url, 'https://raw.githubusercontent.com/only-cli/oc/HEAD/src/sites.js');
  assert.equal(resolveSite('gh', ['issue', 'only-cli', 'oc', '92']).url, 'https://github.com/only-cli/oc/issues/92');
  assert.equal(resolveSite('gh', ['pr', 'only-cli', 'oc', '105']).url, 'https://github.com/only-cli/oc/pull/105');
  assert.equal(resolveSite('gh', ['releases', 'facebook', 'react']).url, 'https://github.com/facebook/react/releases');
});
