/**
 * Node.js docs search backend. nodejs.org has no search results page at all:
 * the site's search box is a JavaScript modal asking a third-party service,
 * so there is nothing for oc to fetch or call directly. But the API docs
 * publish their entire reference as one static JSON file, all.json, much the
 * way a Sphinx site publishes its search index, so `search` ranks that file
 * locally: every module, class, method, property, and event heading becomes
 * a result linking to its own anchor. The file is ~8MB (~1MB over the wire)
 * and static, so it shares the Sphinx backend's day cache and, like the
 * index, is never printed: what reaches the agent is the ranked list only.
 */

import { cachedFile } from './cache.js';
import { escapeHTML } from './sphinx.js';

const MAX_RESULTS = 20;

// The list-valued keys that hold entries with headings of their own on the
// page. The others (params, options) describe one signature's arguments and
// have no heading or anchor; a class's constructor rides in `signatures`.
const CHILD_KEYS = [
  'modules', 'globals', 'miscs', 'classes', 'classMethods',
  'signatures', 'methods', 'properties', 'events',
];

// What each heading's `type` is called on the results page. Anything else is
// a property whose type field holds its value type ({number}, {boolean}).
const KIND = {
  module: 'module', misc: 'section', global: 'global', class: 'class',
  ctor: 'constructor', classMethod: 'static method', method: 'method',
  event: 'event', property: 'property',
};

// The docs derive a heading's anchor from its text the github-slugger way:
// lowercase, drop everything but letters, digits, spaces, hyphens, and
// underscores, then spaces become hyphens. 'fs.readFile(path[, options],
// callback)' is #fsreadfilepath-options-callback.
const slug = (text) =>
  text.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replaceAll(' ', '-');

/**
 * Anything that parses but is not the docs corpus (an error page served as
 * JSON, a moved file) fails here, which keeps it out of the cache too.
 * @param {string} text
 * @returns {any}
 */
export function parseAll(text) {
  let all;
  try {
    all = JSON.parse(text);
  } catch {
    all = null;
  }
  if (!Array.isArray(all?.modules)) throw new Error('not the Node.js docs corpus');
  return all;
}

/**
 * Flatten the docs tree into the headings a query can hit. Only a top-level
 * entry names its page (source: 'doc/api/fs.md'); everything nested under it
 * inherits that page and contributes its own heading and anchor. A nested
 * entry whose textRaw is a property's type line, or does not name the entry,
 * is not a heading and is skipped; its parent still stands.
 * A heading repeated on one page is kept once: the corpus lists some methods
 * twice for one heading, and where a page really repeats one (each stream
 * class has an Event: 'close') the rows would be indistinguishable anyway.
 * @param {any} all - parsed all.json
 * @returns {{text: string, name: string, type: string, page: string, anchor: string}[]}
 */
export function buildEntries(all) {
  const entries = [];
  const seen = new Set();
  const add = (node, page, top) => {
    const text = String(node?.textRaw ?? '').replaceAll('`', '').trim();
    // A section's name keeps the heading's backticks ('`fetch`', every N-API
    // function), so the two are compared with those stripped from both.
    const name = String(node?.name ?? '').replaceAll('`', '');
    const type = String(node?.type ?? '');
    // A property's value line, 'Type: {string}', 'Returns: {Object}', or a
    // bare '{number}', stands where its heading would; it is never one, even
    // when the property's own name is a word in it (blob.type,
    // server.listening).
    const typeLine = /^(?:\w+: )?\{/.test(text);
    const heading = text && name && !typeLine
      && (top || text.toLowerCase().includes(name.toLowerCase()));
    if (heading && !seen.has(`${page}#${text}`)) {
      seen.add(`${page}#${text}`);
      // The top-level module or section heading is the page's own title, so
      // its entry links to the page top; every other heading, a section
      // within the page included, has an anchor worth keeping.
      const anchor = top && ['module', 'misc', 'global'].includes(type) ? '' : slug(text);
      entries.push({ text, name, type, page, anchor });
    }
    for (const key of CHILD_KEYS) {
      for (const child of node?.[key] ?? []) add(child, page, false);
    }
  };
  for (const key of CHILD_KEYS) {
    for (const node of all?.[key] ?? []) {
      const page = String(node?.source ?? '')
        .replace(/^doc\/api\//, '').replace(/\.md$/, '');
      if (page) add(node, `${page}.html`, true);
    }
  }
  return entries;
}

/**
 * Rank the headings against a query. A word that is an entry's own name (the
 * bare symbol: 'readFile') weighs most, a whole word of its heading next, a
 * substring of it least, and an entry must match every word before any-word
 * matching kicks in, the same policy the Sphinx backend follows.
 * @param {ReturnType<typeof buildEntries>} entries
 * @param {string} query
 */
export function searchEntries(entries, query) {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const scored = [];
  for (const e of entries) {
    const nameL = e.name.toLowerCase();
    const textL = e.text.toLowerCase();
    const tokens = new Set(textL.split(/[^a-z0-9_]+/));
    let score = 0;
    let hit = 0;
    for (const word of words) {
      const s = nameL === word ? 10 : tokens.has(word) ? 5 : textL.includes(word) ? 2 : 0;
      if (s) {
        score += s;
        hit += 1;
      }
    }
    if (hit) scored.push({ e, score, hit });
  }
  let hits = scored.filter((s) => s.hit === words.length);
  const partial = !hits.length && words.length > 1 && scored.length > 0;
  if (partial) hits = scored;
  // Among equal scores the shorter heading is the plainer API, so it leads.
  hits.sort((a, b) => b.score - a.score
    || a.e.text.length - b.e.text.length
    || a.e.text.localeCompare(b.e.text));
  return { words, partial, total: hits.length, hits: hits.slice(0, MAX_RESULTS).map((s) => s.e) };
}

/**
 * The result list becomes the same small synthetic page the other search
 * backends emit, so it distills, renders, numbers, and remembers like any
 * fetched page and `do <n>` follows a result.
 * @param {string} base
 * @param {string} query
 * @param {ReturnType<typeof searchEntries>} found
 * @returns {string}
 */
export function resultsToHTML(base, query, found) {
  const host = new URL(base).host;
  const items = found.hits.map((e) => {
    const href = new URL(e.anchor ? `${e.page}#${e.anchor}` : e.page, base).href;
    return `<li><a href="${escapeHTML(href)}">${escapeHTML(e.text)}</a>`
      + ` ${escapeHTML(KIND[e.type] ?? 'property')}, in ${escapeHTML(e.page.replace(/\.html$/, ''))}</li>`;
  });
  const partial = found.partial ? '; no heading matches every word, so these match some' : '';
  const summary = items.length
    ? `${found.total} heading${found.total === 1 ? '' : 's'} match in the docs' own reference,`
      + ` ranked locally${found.total > MAX_RESULTS ? `, top ${MAX_RESULTS} shown` : ''}${partial}:`
    : `nothing in the docs' own reference matches; try fewer or different words`;
  return `<html><head><title>${escapeHTML(host)} search: ${escapeHTML(query)}</title></head><body><main>`
    + `<p>${summary}</p>`
    + (items.length ? `<ol>${items.join('')}</ol>` : '')
    + `</main></body></html>`;
}

/**
 * Search the Node.js API docs. The site has no human search URL to remember,
 * so the session keeps the docs index, the page a reader would start from.
 * @param {string} base - docs root ending in '/', e.g. https://nodejs.org/api/
 * @param {string} query
 */
export async function nodeSearch(base, query) {
  if (!query.trim()) throw new Error('usage: search <query>');
  const { data, via } = await cachedFile('nodedoc', new URL('all.json', base).href, parseAll);
  return {
    url: new URL('index.html', base).href,
    html: resultsToHTML(base, query, searchEntries(buildEntries(data), query)),
    via,
  };
}
