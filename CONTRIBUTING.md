# Contributing to only-cli

Thanks for wanting to help. This is a small project with strong opinions, so this guide is short but strict. Every PR is judged against one ranked list of principles: token economy first, slim install, stateless by default, deterministic output, fail loud. When two of them conflict, the one earlier in the list wins.

## Setup

```
git clone https://github.com/only-cli/oc
cd oc
npm install
npm test
```

Node 20+. Tests run fully offline against saved fixtures in `tests/pages/`, so a plane is a fine place to work on this.

## What makes a PR easy to accept

- **It respects the token budget.** Everything this tool prints gets read by a paying model. If your change adds output, show the before and after of `--stats` on a fixture page. A default render that crosses 500 tokens needs a very good reason; past 2,000 it is a bug.
- **It adds no dependencies.** The runtime dependency count (three) is a feature. If you truly need a new one, justify it in one line in the PR description and expect the default answer to be no. Standard library first, always.
- **It keeps output deterministic.** Same page, same command, same output. There is a test for this; do not weaken it.
- **It comes with an offline test.** New behavior gets a fixture in `tests/pages/` and a test in `tests/`. No network calls in tests, ever.
- **It fails loud and cheap.** A feature that cannot handle a page should say so in one line and exit nonzero, never dump raw HTML as a fallback.

## Code style

Plain JavaScript, ESM, JSDoc types, no build step. Match the code around you. Comments explain constraints and trade-offs, not what the next line does; if a comment restates the code, delete it. Small functions, few files: if you are adding a new file to `src/`, pause and check whether the logic belongs in one of the files that already exist.

## Writing style

All prose in this repo (docs, comments, commit messages, error text, CLI help) follows the same rules: write like a human, be precise like a developer, and leave a trail like a contributor. Be honest about limitations. Do not use em dashes anywhere; use commas, colons, or separate sentences.

Commit messages explain why, not just what. "Cap link text at 200 chars, long titles were eating half the budget" tells the next person everything.

## Adding a site definition

A definition needs no wiring: `oc <site> <verb> [args]` resolves against `clis/*.json` at runtime (see `src/sites.js`), keyed by the domain, its bare name, and any short alias listed there, so a new file is reachable and shows up in `oc sites` as soon as it lands. Add a case to `tests/sites.test.js` if the site needs a shape the existing ones do not cover.

Per-site CLIs live in `clis/`, one JSON file per domain: the domain plus a `commands` map of name, help line, and URL template, exactly like the existing files. Keep it under 50 lines, no OpenAPI. If the site has a public JSON API, point the commands at that instead of the HTML pages. If your definition needs logic, it is trying to become an adapter, and the answer is to improve the generic engine instead.

A `search` verb deserves a moment's thought, because most documentation sites render search in the browser and hand oc an empty page. Check what the site actually ships, in this order:

- **A server-rendered results page.** Point `open` at it, the way `pkg.go.dev` and Microsoft Learn's RSS endpoint do. Nothing else is needed.
- **A public JSON endpoint behind the results page.** Use the `api` shape: `api` is the endpoint template, `page` the human URL to remember for the session, `results` the dot path to the list, `fields` the paths to each result's `title`, `url`, and `text`, and `total` the path to the count. `clis/developer.mozilla.org.json` is the model. The site's own ranking comes back as a numbered results page for a few hundred tokens.
- **A static search index.** Sphinx sites (docs.python.org, most Read the Docs projects) publish `searchindex.js`; RDoc sites publish `js/search_index.js`; MkDocs and Material for MkDocs sites publish `search/search_index.json`; the Node.js API docs publish `all.json`. Set `sphinx`, `rdoc`, `mkdocs`, or `nodedoc` to the docs root and oc fetches the index once a day, ranks it locally, and prints only the result list. Any Sphinx, RDoc, or MkDocs site works with no code.
- **None of the above.** Fall back to DuckDuckGo with a baked-in filter: `"open": "https://html.duckduckgo.com/html/?q=site%3Aexample.org+{query}"`, as `rust`, `java`, `ts`, `php`, and `cpp` do. Say so in the README row ("search via DuckDuckGo") so nobody mistakes it for the site's own search.

When a verb opens a JSON API, look at what the generic view makes of the answer first. It does well on a list of similar records and badly on a single deep one. If it picks the wrong things, add `keep`: the dot paths to the fields worth showing, in the order to show them (`"keep": ["info.name", "info.version", "info.requires_dist"]`). For a list of records, `list` names the path to the array and `keep` applies to each item; a `{path} {other}` template in `keep` joins fields onto one line, and a `true` flag prints its own name while `false` prints nothing, so `"{crate_id} {req} {kind} {optional}"` reads `bytes ^1.2.1 normal optional`. A template that starts with `/` or `https://` becomes the item's link (`"/raw/{id}"`). The same templates work for an `api` search's `text` and `url`, and `"results": ""` says the response itself is the list. A response holding none of the named fields renders untouched, so an error body still reads as one; `oc raw` ignores `keep` altogether.

Adding a fifth search backend is a change to `src/`, not to a JSON file, and needs the same case as any other new code: a site that many agents reach for, an index or endpoint that a template cannot describe, and offline tests against a saved copy of the index.

## Reporting bugs

Open an issue with the exact command, the output you got, and the output you expected. If the page is public, include the URL. If distillation mangled a page, a saved copy of the HTML as a fixture is the most useful thing you can attach.

## Releasing (maintainer)

Publishing a GitHub release runs `.github/workflows/publish.yml`, which tests and publishes to npm through OIDC trusted publishing: no npm token stored anywhere, no one-time password, and npm attaches provenance automatically. The trusted publisher link (npm package settings, GitHub Actions, repo `only-cli/oc`, workflow `publish.yml`) has to be configured once on npmjs.com after the first manual publish, since npm only lets you attach a trusted publisher to a package that already exists.

## Maintainer

[only-cli](https://github.com/only-cli)
