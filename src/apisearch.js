/**
 * JSON search API backend. Some sites render search results only in the
 * browser but run their search behind a public JSON endpoint the results
 * page calls (MDN's /api/v1/search). The site definition names that endpoint
 * and which fields of the response hold the result list, each result's
 * title, URL, and snippet; the ranked answer the site already computed
 * becomes the same synthetic results page a Sphinx search produces, riding
 * the normal distill and render path, so `do <n>` follows a result and
 * nothing else is new. Unlike the Sphinx backend nothing is fetched but the
 * one response, so there is no cache to keep.
 */

import { fetchPage } from './fetch.js';
import { escapeHTML } from './sphinx.js';
import { fillTemplate, pick } from './distill.js';

const MAX_RESULTS = 20;

// Response fields are named by dot path ('metadata.total.value'), so a
// definition can reach into whatever shape a site's API answers with, or by
// a template joining several ('{version} {description}'), which is also how
// a result gets a link when the API returns none: crates.io and npm answer
// with names, and the page for a name is a URL the definition knows.
const field = (item, spec) =>
  String(spec).includes('{') ? fillTemplate(spec, item) : pick(item, spec);

/**
 * The result list becomes a small HTML page, the same move sphinx.js makes
 * and for the same reason: numbered results, followable with `do <n>`,
 * saved as session state. Result URLs are often paths ('/en-US/docs/...'),
 * so they resolve against the endpoint they came from.
 * @param {{results?: string, fields?: Record<string, string>, total?: string}} def
 * @param {string} query
 * @param {any} data - the endpoint's parsed JSON response
 * @param {string} apiURL - the URL the response came from
 * @returns {string}
 */
export function resultsToHTML(def, query, data, apiURL) {
  const host = new URL(apiURL).host;
  const fields = def.fields ?? {};
  const picked = pick(data, def.results ?? 'results');
  const list = Array.isArray(picked) ? picked : [];
  const items = list.slice(0, MAX_RESULTS).map((item) => {
    const href = new URL(String(field(item, fields.url ?? 'url') ?? ''), apiURL).href;
    const title = String(field(item, fields.title ?? 'title') || href);
    const text = fields.text ? String(field(item, fields.text) ?? '').trim() : '';
    return `<li><a href="${escapeHTML(href)}">${escapeHTML(title)}</a>`
      + `${text ? ` ${escapeHTML(text)}` : ''}</li>`;
  });
  const total = Number(def.total ? pick(data, def.total) : NaN);
  // An answer with no total says only how many results it carried, and one
  // cut to fit is a floor: RubyGems answers 30 a page, so "rails" read as 20
  // pages matching and nothing saying the list went on.
  const known = Number.isFinite(total) && total >= items.length;
  const count = known ? total : list.length;
  const floor = !known && count > items.length ? 'at least ' : '';
  const summary = items.length
    ? `${floor}${count} page${count === 1 ? '' : 's'} match, ranked by the site's own search`
      + `${count > items.length ? `, top ${items.length} shown` : ''}:`
    : `nothing in the site's own search matches; try fewer or different words`;
  return `<html><head><title>${escapeHTML(host)} search: ${escapeHTML(query)}</title></head><body><main>`
    + `<p>${summary}</p>`
    + (items.length ? `<ol>${items.join('')}</ol>` : '')
    + `</main></body></html>`;
}

/**
 * Search one site through its JSON endpoint. Returns the synthetic results
 * page plus the URL the session should remember: the site's human search
 * page when the definition names one, so session listings read sensibly.
 * @param {{api: string, page?: string} & Parameters<typeof resultsToHTML>[0]} def
 * @param {string} query
 */
export async function apiSearch(def, query) {
  if (!query.trim()) throw new Error('usage: search <query>');
  const q = encodeURIComponent(query);
  const apiURL = def.api.replaceAll('{query}', q);
  const { url: finalURL, html: body } = await fetchPage(apiURL);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`the search API at ${apiURL} did not answer with JSON`);
  }
  return {
    url: (def.page ?? def.api).replaceAll('{query}', q),
    html: resultsToHTML(def, query, data, finalURL),
    via: 'api',
  };
}
