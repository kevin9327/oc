/**
 * Sphinx search backend. A Sphinx-built documentation site (docs.python.org,
 * most Read the Docs projects) has no search server: its search page ships
 * the site's entire full-text index as one static file, searchindex.js, and
 * ranks matches in the visitor's browser. oc can run the same ranking here,
 * so `search` on such a site answers from the site's own index instead of a
 * third-party engine. The index is big (docs.python.org's is ~4MB, ~900KB
 * over the wire) but static, so it is cached on disk for a day and never
 * printed: what reaches the agent is only the ranked result list.
 */

import { cachedFile } from './cache.js';

const MAX_RESULTS = 20;

/**
 * The index file is `Search.setIndex({...})`: JSON wrapped in one function
 * call for the browser's benefit. Anything that does not parse that way is
 * not a Sphinx index, which on a wrong or moved URL is the honest error.
 * @param {string} js
 * @returns {any}
 */
export function parseIndex(js) {
  const start = js.indexOf('(');
  const end = js.lastIndexOf(')');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(js.slice(start + 1, end));
    } catch {}
  }
  throw new Error('not a Sphinx search index');
}

// terms and titleterms store a bare number when a word appears in one
// document and an array when it appears in several.
const docsFor = (table, word) => {
  const hit = table?.[word];
  return hit == null ? null : Array.isArray(hit) ? hit : [hit];
};

/**
 * Sphinx stems words before indexing ('threading' is stored as 'thread'), so
 * an exact lookup misses common query spellings. Rather than shipping the
 * Porter stemmer, try the word with common suffixes stripped, and only then
 * a prefix scan: an index key that extends the word, or that the word
 * extends, counts at reduced weight.
 * @param {Record<string, number|number[]>} table
 * @param {string} word
 * @returns {{docs: number[], exact: boolean}|null}
 */
function lookup(table, word) {
  const exact = docsFor(table, word);
  if (exact) return { docs: exact, exact: true };
  for (const suffix of ['ing', 'ed', 'es', 's', 'e']) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      const hit = docsFor(table, word.slice(0, -suffix.length));
      if (hit) return { docs: hit, exact: false };
    }
  }
  if (word.length >= 4) {
    const docs = new Set();
    for (const key of Object.keys(table ?? {})) {
      if (key.length >= 4 && (key.startsWith(word) || word.startsWith(key))) {
        for (const d of docsFor(table, key)) docs.add(d);
      }
    }
    if (docs.size) return { docs: [...docs], exact: false };
  }
  return null;
}

/**
 * An exact object hit ('json.dumps', or just 'dumps') beats any full-text
 * rank: the index maps the symbol straight to its anchor on the page, so it
 * goes at the top as a direct link. Only single-word queries can be symbols.
 * @param {any} index
 * @param {string} query
 */
function objectHits(index, query) {
  const q = query.trim().toLowerCase();
  if (!q || q.includes(' ')) return [];
  const hits = [];
  for (const [prefix, entries] of Object.entries(index.objects ?? {})) {
    for (const [doc, typeIdx, priority, anchor, name] of entries) {
      const full = prefix ? `${prefix}.${name}` : name;
      if (full.toLowerCase() !== q && name.toLowerCase() !== q) continue;
      // Empty string: the object's own name is the HTML id. The sentinel '-'
      // means Sphinx built '{objtype}-{fullname}' instead, which is how
      // docs.python.org names every module heading (#module-json).
      const id = anchor === '' ? full
        : anchor === '-' ? `${index.objnames?.[typeIdx]?.[1] ?? ''}-${full}`
          : anchor;
      hits.push({
        name: full,
        type: index.objnames?.[typeIdx]?.[2] ?? '',
        doc,
        anchor: id,
        priority,
      });
    }
  }
  return hits.sort((a, b) => a.priority - b.priority).slice(0, 5);
}

/**
 * Rank the index against a query the way the site's own search page would:
 * a document must match every word, a title hit weighs far more than a body
 * hit, and only when nothing matches every word does any-word matching kick
 * in, and then the result page says so.
 * @param {any} index
 * @param {string} query
 */
export function searchIndex(index, query) {
  const words = [...new Set(
    query.toLowerCase().split(/\s+/)
      .map((w) => w.replace(/^[^\w.]+|[^\w.]+$/g, ''))
      .filter(Boolean))];
  const scores = new Map();
  const matched = new Map();
  for (const word of words) {
    const perDoc = new Map();
    const body = lookup(index.terms, word);
    if (body) for (const d of body.docs) perDoc.set(d, body.exact ? 5 : 2);
    const title = lookup(index.titleterms, word);
    if (title) for (const d of title.docs) perDoc.set(d, (perDoc.get(d) ?? 0) + (title.exact ? 15 : 5));
    for (const [d, score] of perDoc) {
      scores.set(d, (scores.get(d) ?? 0) + score);
      matched.set(d, (matched.get(d) ?? 0) + 1);
    }
  }
  let docs = [...scores.keys()].filter((d) => matched.get(d) === words.length);
  const partial = !docs.length && words.length > 1 && scores.size > 0;
  if (partial) docs = [...scores.keys()];
  docs.sort((a, b) =>
    scores.get(b) - scores.get(a)
    || String(index.titles[a]).localeCompare(String(index.titles[b])));
  return {
    words,
    partial,
    total: docs.length,
    objects: objectHits(index, query),
    docs: docs.slice(0, MAX_RESULTS).map((d) => ({
      doc: d,
      title: plainTitle(index.titles[d]) || index.docnames[d],
    })),
  };
}

// Titles in the index arrive as the HTML of the page's <h1>, markup and all
// (docs.python.org wraps module names in <code> spans), so they are flattened
// to text before they are placed on the results page. A title is index data
// from the network, so the walk keeps only what stands outside a bracket: no
// '<' or '>' can survive it, even from a tag the title never closes. A
// literal angle bracket in a real title arrives as an entity, so nothing
// legitimate is lost.
const plainTitle = (t) => {
  let text = '';
  let inTag = false;
  for (const ch of String(t)) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) text += ch;
  }
  return text.trim();
};

export const escapeHTML = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * The result list becomes a small HTML page and rides the same distill and
 * render path a fetched page does. That is what makes results numbered,
 * followable with `do <n>`, and saved as session state, with nothing new for
 * an agent to learn.
 * @param {string} base
 * @param {string} query
 * @param {ReturnType<typeof searchIndex>} found
 * @param {any} index
 * @returns {string}
 */
export function resultsToHTML(base, query, found, index) {
  const host = new URL(base).host;
  const pageURL = (doc) => new URL(`${index.docnames[doc]}.html`, base).href;
  const items = found.objects.map((o) =>
    `<li><a href="${escapeHTML(`${pageURL(o.doc)}#${o.anchor}`)}">${escapeHTML(o.name)}</a>`
    + ` ${escapeHTML(o.type)}, in ${escapeHTML(plainTitle(index.titles[o.doc]) || index.docnames[o.doc])}</li>`);
  for (const r of found.docs) {
    items.push(`<li><a href="${escapeHTML(pageURL(r.doc))}">${escapeHTML(r.title)}</a></li>`);
  }
  const partial = found.partial ? '; no page matches every word, so these match some' : '';
  const summary = items.length
    ? `${found.total} page${found.total === 1 ? '' : 's'} match in the site's own search index,`
      + ` ranked locally${found.total > MAX_RESULTS ? `, top ${MAX_RESULTS} shown` : ''}${partial}:`
    : `nothing in the site's own search index matches; try fewer or different words`;
  return `<html><head><title>${escapeHTML(host)} search: ${escapeHTML(query)}</title></head><body><main>`
    + `<p>${summary}</p>`
    + (items.length ? `<ol>${items.join('')}</ol>` : '')
    + `</main></body></html>`;
}

/**
 * Search one Sphinx site. Returns the synthetic results page plus the URL the
 * session should remember: the site's human search URL, so the state reads
 * sensibly in `oc session` listings and error messages.
 * @param {string} base - site root ending in '/', e.g. https://docs.python.org/3/
 * @param {string} query
 */
export async function sphinxSearch(base, query) {
  if (!query.trim()) throw new Error('usage: search <query>');
  const { data: index, via } = await cachedFile('sphinx', new URL('searchindex.js', base).href, parseIndex);
  return {
    url: new URL(`search.html?q=${encodeURIComponent(query)}`, base).href,
    html: resultsToHTML(base, query, searchIndex(index, query), index),
    via,
  };
}
