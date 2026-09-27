import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distill } from '../src/distill.js';
import { resolveSite } from '../src/sites.js';

// Trimmed copies of real answers: endoflife.date for nodejs, OSV for the
// Log4Shell advisory, caniuse's feature file for fetch, and GitHub's
// advisory database for lodash on npm.
const fixture = (name) => readFileSync(new URL(`./pages/${name}`, import.meta.url), 'utf8');
const texts = (page) => page.blocks.map((b) => b.text ?? '');
const shown = (site, args, name) => {
  const { url, view } = resolveSite(site, args);
  return distill(fixture(name), url, { view });
};

test('eol product lists one line per cycle with its dates, and flags read as words', () => {
  const lines = texts(shown('eol', ['product', 'nodejs'], 'eol_nodejs.json'));
  assert.equal(lines[0], 'cycle: 26 | latest: 26.10.0 | releaseDate: 2026-05-05 | support: 2027-10-27 | eol: 2029-04-30 | lts: 2026-10-28');
  // A cycle that never became LTS says nothing about it rather than `lts: false`.
  assert.equal(lines[1], 'cycle: 25 | latest: 25.9.0 | releaseDate: 2025-10-15 | support: 2026-04-01 | eol: 2026-06-01');
  assert.equal(lines.length, 3);
  assert.equal(resolveSite('endoflife', ['cycle', 'nodejs', '22']).url, 'https://endoflife.date/api/nodejs/22.json');
  assert.equal(resolveSite('eol', ['all']).view, undefined, 'the product list is plain strings, which the generic view already handles');
});

test('osv vuln leads with the summary and the ids, and the long details stay one block', () => {
  const page = shown('osv', ['vuln', 'GHSA-jfh8-c2jp-5v3q'], 'osv_vuln.json');
  const lines = texts(page);
  assert.equal(lines[0], 'Remote code injection in Log4j');
  assert.match(lines[1], /^id: GHSA-jfh8-c2jp-5v3q \| aliases: CVE-2021-44228 \| severity: CRITICAL \| score: CVSS:3\.1/);
  assert.ok(lines.some((t) => t.includes('fixed: 2.15.0') && t.includes('published: 2021-12-10 00:40:56')), lines.join('\n'));
  assert.ok(lines.some((t) => t.startsWith('details: # Summary')), 'the details field is missing');
  assert.ok(!lines.some((t) => /nvd\.nist\.gov|schema_version/.test(t)), 'a reference or schema field leaked in');
  assert.equal(resolveSite('osv.dev', ['vuln', 'CVE-2021-44228']).url, 'https://api.osv.dev/v1/vulns/CVE-2021-44228');
});

test('caniuse feature shows the support share and the spec link, not the browser table', () => {
  const page = shown('caniuse', ['feature', 'fetch'], 'caniuse_fetch.json');
  const lines = texts(page);
  assert.equal(lines[0], 'Fetch');
  assert.match(lines[1], /usage_perc_y: 96\.96 \| usage_perc_a: 0\.04 \| status: ls/);
  const link = page.blocks.find((b) => b.type === 'link');
  assert.equal(link?.href, 'https://fetch.spec.whatwg.org/');
  assert.ok(!lines.some((t) => /chrome|firefox|#2/.test(t)), 'per-browser stats belong to oc raw');
  assert.equal(resolveSite('caniuse', ['search', 'container queries']).url,
    'https://html.duckduckgo.com/html/?q=site%3Acaniuse.com+container%20queries');
});

test('gh advisories gives each advisory a title, a link, the range, and the fix', () => {
  const page = shown('gh', ['advisories', 'npm', 'lodash'], 'gh_advisories.json');
  const lines = texts(page);
  assert.equal(lines[0], 'lodash vulnerable to Code Injection via `_.template` imports key names');
  const links = page.blocks.filter((b) => b.type === 'link').map((b) => b.href);
  assert.deepEqual(links.slice(0, 2), ['https://github.com/advisories/GHSA-r5fr-rjxr-66jc', 'https://github.com/advisories/GHSA-f23m-r3pf-42rh']);
  assert.equal(lines[2], 'severity: high | cve_id: CVE-2026-4800 | vulnerable_version_range: >= 4.0.0, <= 4.17.23 | first_patched_version: 4.18.0 | published_at: 2026-04-01 23:51:12');
  // A withdrawn advisory says when, and only then.
  const withdrawn = lines.filter((t) => t.includes('withdrawn_at:'));
  assert.equal(withdrawn.length, 1, lines.join('\n'));
  assert.ok(!lines.some((t) => /credits|description:/.test(t)), 'the body and credits belong to the linked page');
  assert.equal(resolveSite('github', ['advisories', 'pip', 'django']).url,
    'https://api.github.com/advisories?ecosystem=pip&affects=django&per_page=20');
});
