import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distill } from '../src/distill.js';
import { resolveSite } from '../src/sites.js';

// Trimmed copies of real answers: GitLab's open issues and first merge
// request for inkscape/inkscape, Codeberg's repository search for "forgejo"
// and one Forgejo pull request.
const fixture = (name) => readFileSync(new URL(`./pages/${name}`, import.meta.url), 'utf8');
const texts = (page) => page.blocks.map((b) => b.text ?? '');
const view = (site, args) => {
  const r = resolveSite(site, args);
  return { url: r.url, page: (name) => distill(fixture(name), r.url, { view: r.view }) };
};

test('GitLab and Codeberg verbs mirror gh and resolve to their APIs', () => {
  const gl = (verb, ...args) => resolveSite('gitlab', [verb, ...args]).url;
  // GitLab wants the project path as one encoded segment.
  assert.equal(gl('repo', 'inkscape', 'inkscape'), 'https://gitlab.com/api/v4/projects/inkscape%2Finkscape');
  assert.equal(gl('pr', 'inkscape', 'inkscape', '1'), 'https://gitlab.com/api/v4/projects/inkscape%2Finkscape/merge_requests/1');
  assert.equal(gl('file', 'inkscape', 'inkscape', 'share/README.md'), 'https://gitlab.com/inkscape/inkscape/-/raw/HEAD/share/README.md');
  assert.equal(resolveSite('gl', ['search', 'vector editor']).url, 'https://gitlab.com/api/v4/projects?search=vector%20editor&per_page=20&order_by=star_count');
  const cb = (verb, ...args) => resolveSite('codeberg', [verb, ...args]).url;
  assert.equal(cb('issue', 'forgejo', 'forgejo', '1'), 'https://codeberg.org/api/v1/repos/forgejo/forgejo/issues/1');
  assert.equal(cb('file', 'forgejo', 'forgejo', 'README.md'), 'https://codeberg.org/forgejo/forgejo/raw/branch/HEAD/README.md');
  for (const verb of ['repo', 'user', 'search', 'issues', 'issue', 'pr', 'releases', 'file']) {
    assert.ok(resolveSite('gitlab.com', [verb, 'a', 'b', 'c']), `gitlab has no ${verb}`);
    assert.ok(resolveSite('codeberg.org', [verb, 'a', 'b', 'c']), `codeberg has no ${verb}`);
  }
});

test('a GitLab issue list is one line and one link per issue', () => {
  const lines = texts(view('gitlab', ['issues', 'inkscape', 'inkscape']).page('gitlab_issues.json'));
  assert.match(lines[0], /^#6447 Request: Add "auto-close" option to shape builder \(1 comments\) New feature/);
  assert.equal(lines[1], 'web_url: https://gitlab.com/inkscape/inkscape/-/work_items/6447');
  assert.equal(lines.length, 4);
});

test('a merge request names its author and branches, not two bare labels', () => {
  const lines = texts(view('gitlab', ['pr', 'inkscape', 'inkscape', '1']).page('gitlab_mr.json'));
  assert.equal(lines[0], 'Disable debugging code on libnrtype Layout-TNG-Compute at compile-time.');
  assert.match(lines[1], /^state: merged \| by fsanches \| disable_libnrtype_debugging_code into master \|/);
  assert.ok(!lines.some((t) => t.includes('01eb013e')), 'the commit sha leaked into the view');
});

test('Codeberg search reads the list under data, and a pull request its branches', () => {
  const search = texts(view('codeberg', ['search', 'forgejo']).page('codeberg_search.json'));
  assert.equal(search[0], 'forgejo/forgejo 5547 stars: Beyond coding. We forge.');
  assert.equal(search[1], 'html_url: https://codeberg.org/forgejo/forgejo');
  const pr = texts(view('codeberg', ['pr', 'forgejo', 'forgejo', '14569']).page('codeberg_pr.json'));
  assert.equal(pr[0], 'fix: add clone error enricher to make errors less technical');
  assert.match(pr[1], /^state: open \| by srikanth-iyengar \| fix\/clone-error-redirects into forgejo \|/);
});
