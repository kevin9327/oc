/**
 * MkDocs search backend. MkDocs, and Material for MkDocs on top of it, has no
 * search server either: the build writes search/search_index.json, one row
 * per page and per section with its title and body text, and the browser
 * searches it with lunr. So `search` ranks that file locally, under the same
 * day cache as the other local backends, and prints only the result list.
 *
 * A section title here is a short prose heading ("Installation", "Adding a
 * dependency"), not an API symbol, so titles alone miss most questions a
 * reader asks in their own words. A match in a title outweighs one in the
 * body, and a section matched on its body shows a line of the text around
 * the match, so the agent can pick one without opening it.
 */

import { cachedFile } from './cache.js';
import { escapeHTML } from './sphinx.js';

const MAX_RESULTS = 20;
const EXCERPT = 110;

/**
 * The index is `{config, docs: [{location, title, text}]}`. Anything else is
 * not an MkDocs index, which on a site that moved to another generator (as
 * FastAPI's did) is the honest error, and it keeps a 404 page out of the
 * cache.
 * @param {string} json
 * @returns {{docs: {location: string, title: string, text: string}[]}}
 */
export function parseMkdocsIndex(json) {
  try {
    const data = JSON.parse(json);
    if (Array.isArray(data?.docs) && data.docs.every((d) => typeof d?.location === 'string')) return data;
  } catch {}
  throw new Error('not an MkDocs search index');
}

// Material stores the body as HTML; plain MkDocs stores text. Either way the
// ranker and the excerpt want words.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const plain = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();

/**
 * One entry per row. The page a section sits on is named by the page row's
 * title, so a result reads "Installation, in Getting Started".
 * @param {ReturnType<typeof parseMkdocsIndex>} data
 * @returns {{text: string, name: string, kind: string, path: string, page: string, body: string}[]}
 */
export function buildMkdocsEntries(data) {
  const pages = new Map();
  for (const d of data.docs) if (!d.location.includes('#')) pages.set(d.location, plain(d.title));
  return data.docs.map((d) => {
    const title = plain(d.title);
    const [page, anchor] = d.location.split('#');
    return {
      text: title,
      name: title,
      kind: anchor ? 'section' : 'page',
      path: d.location,
      page: anchor ? pages.get(page) ?? page : '',
      body: plain(d.text),
    };
  }).filter((e) => e.text);
}

// Words that carry no topic of their own. A question typed in prose ("how
// do I add a dependency") would otherwise match every section on "a".
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'how', 'do', 'i', 'my', 'with', 'what', 'can']);
// "dependency" should find "Managing dependencies", so a word also matches
// by its stem once a plural or verb ending is off.
const stem = (w) => (w.length > 4 ? w.replace(/(ies|es|s|y|ing|ed)$/, '') : w);
// A title, a body, and the query are all cut into words at the same places,
// so "pyproject.toml", "uv.lock", "--group", or a question's closing "?"
// meet the words the index holds, and a letter outside ASCII stays in its
// word. A contraction's tail goes first: "what's" is "what", not "what" and
// a stray "s" every section would have to match.
const wordsOf = (s) => s.replace(/(?<=\p{L})['’](s|t|re|ve|ll|d|m)(?!\p{L})/gu, '')
  .split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
const tokensOf = (s) => new Set(wordsOf(s));
// A stem matches a word it starts, give or take an ending: "add" finds
// "adding" but not "additional".
const rooted = (tokens, root) => [...tokens].some((t) => t.startsWith(root) && t.length - root.length <= 3);

/**
 * Rank sections for a query. A word in a section's title weighs far more
 * than one in its body, a whole word more than a stem, and a section must
 * hold every word before sections holding only some are shown, and one
 * whose title holds every word leads the ones matched on their body. Among equal
 * scores the shorter body leads: a page row's body is every section on it,
 * so the section that is about the words beats the page that mentions them.
 * @param {ReturnType<typeof buildMkdocsEntries>} entries
 * @param {string} query
 */
export function searchMkdocs(entries, query) {
  const all = [...new Set(wordsOf(query.toLowerCase()))];
  const topical = all.filter((w) => !STOP.has(w));
  const words = topical.length ? topical : all;
  const scored = [];
  for (const e of entries) {
    const title = e.text.toLowerCase();
    const body = e.body.toLowerCase();
    const titleTokens = tokensOf(title);
    const bodyTokens = tokensOf(body);
    let score = 0;
    let hit = 0;
    let inTitle = 0;
    for (const word of words) {
      const root = stem(word);
      const s = titleTokens.has(word) ? 10 : rooted(titleTokens, root) ? 6
        : bodyTokens.has(word) ? 2 : rooted(bodyTokens, root) ? 1 : 0;
      if (s) {
        score += s;
        hit += 1;
        if (s >= 6) inTitle += 1;
      }
    }
    if (hit) scored.push({ e, score, hit, titled: inTitle === words.length });
  }
  let hits = scored.filter((s) => s.hit === words.length);
  const partial = !hits.length && words.length > 1 && scored.length > 0;
  if (partial) hits = scored.filter((s) => s.hit === Math.max(...scored.map((x) => x.hit)));
  hits.sort((a, b) => b.hit - a.hit || Number(b.titled) - Number(a.titled) || b.score - a.score
    || a.e.body.length - b.e.body.length);
  const top = hits.slice(0, MAX_RESULTS);
  return {
    words,
    partial,
    total: hits.length,
    hits: top.map((s) => s.e),
    // Only a section whose title does not already say why it matched gets
    // a line of its text.
    body: new Set(top.filter((s) => !s.titled).map((s) => s.e)),
  };
}

/** The text around the first query word, clipped at word boundaries. */
function excerpt(body, words) {
  const lower = body.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(stem(w))).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return '';
  let start = Math.max(0, at - 30);
  if (start) start = body.indexOf(' ', start) + 1;
  let end = Math.min(body.length, start + EXCERPT);
  if (end < body.length) end = body.lastIndexOf(' ', end);
  return `${start ? '...' : ''}${body.slice(start, end)}${end < body.length ? '...' : ''}`;
}

/**
 * The result list as the same small synthetic page the other search
 * backends emit, so `do <n>` follows a result.
 * @param {string} base
 * @param {string} query
 * @param {ReturnType<typeof searchMkdocs>} found
 * @returns {string}
 */
export function resultsToHTML(base, query, found) {
  const host = new URL(base).host;
  // Reference pages repeat their section titles ("Example", "Fix safety"),
  // and identical link text on one page reads as repeated controls and is
  // hidden, so a title that repeats in the list carries its page in the link.
  const count = new Map();
  for (const e of found.hits) count.set(e.text, (count.get(e.text) ?? 0) + 1);
  const items = found.hits.map((e) => {
    const shared = count.get(e.text) > 1 && e.page;
    const label = shared ? `${e.text} (${e.page})` : e.text;
    const where = e.page && !shared ? `, in ${escapeHTML(e.page)}` : '';
    const text = found.body.has(e) ? `: ${escapeHTML(excerpt(e.body, found.words))}` : '';
    return `<li><a href="${escapeHTML(new URL(e.path, base).href)}">${escapeHTML(label)}</a> ${e.kind}${where}${text}</li>`;
  });
  const partial = found.partial ? '; no section matches every word, so these match some' : '';
  const summary = items.length
    ? `${found.total} section${found.total === 1 ? ' matches' : 's match'} in the docs' own index,`
      + ` ranked locally${found.total > MAX_RESULTS ? `, top ${MAX_RESULTS} shown` : ''}${partial}:`
    : `nothing in the docs' own index matches; try fewer or different words`;
  return `<html><head><title>${escapeHTML(host)} search: ${escapeHTML(query)}</title></head><body><main>`
    + `<p>${summary}</p>`
    + (items.length ? `<ol>${items.join('')}</ol>` : '')
    + `</main></body></html>`;
}

/**
 * Search one MkDocs site. The session keeps the docs root as the page URL.
 * @param {string} base - docs root ending in '/', e.g. https://docs.astral.sh/uv/
 * @param {string} query
 */
export async function mkdocsSearch(base, query) {
  if (!query.trim()) throw new Error('usage: search <query>');
  const { data, via } = await cachedFile('mkdocs', new URL('search/search_index.json', base).href, parseMkdocsIndex);
  return { url: base, html: resultsToHTML(base, query, searchMkdocs(buildMkdocsEntries(data), query)), via };
}
