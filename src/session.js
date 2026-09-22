/**
 * Sessions are plain JSON files on disk, one per name: the current URL, the
 * distilled blocks of the page it holds, how far the last render got through
 * them, and a short history. No daemon, no background process; cookies live in
 * a separate sidecar file (see cookies.js).
 *
 * The file exists so `oc do <n>` can follow a link the compact view never
 * printed the URL of. Hiding URLs is what makes `oc open` cheap; this is what
 * makes hiding them free. Keeping the blocks costs disk, not tokens, and it is
 * what lets `oc read` and `oc next` answer without fetching the page again.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, readdirSync } from 'node:fs';

export const DEFAULT_SESSION = 'default';

// The cookie sidecar sits next to the page file as `<name>.cookies.json`
// (see cookies.js). Both modules split filenames on this suffix, so it lives
// in one place: a rename that reached only one of them would make `session
// ls` list jars as pages, and `session rm` unlink a jar as a page.
export const COOKIE_JAR_SUFFIX = '.cookies.json';

// OC_HOME relocates the whole state directory, for sandboxes, CI, and tests.
export const sessionDir = () => join(process.env.OC_HOME ?? join(homedir(), '.only-cli'), 'sessions');

/**
 * The store directory is what decides who can reach a session: an owner-only
 * mode on a cookie jar is worth nothing inside a directory another local
 * account can list, write to, or unlink from, which is what a permissive umask
 * (0 or 002, the default in some container and CI images) leaves behind. mkdir
 * applies its mode only to a directory it creates, so one already on disk is
 * tightened too, the way the files in it are on every save.
 * @returns {string} the store directory, now present and owner-only
 */
export function ensureSessionDir() {
  const dir = sessionDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A shared OC_HOME that oc does not own keeps the mode it has rather than
    // failing the save; the files written into it are still owner-only.
  }
  return dir;
}

// A session name is interpolated straight into a filename, and the cookie
// sidecar it names now holds real credentials, so a name that is a path
// (absolute, or with a separator or '..') could write or delete a file outside
// the store. Names are user-facing labels, so this charset loses nothing real.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

// Win32 reads a path component as a device when the part before its first
// period is a reserved name, which would put session 'nul''s cookie jar on the
// NUL device rather than in a file. Node 24 on Windows 11 writes a real file
// there (libuv's path handling sidesteps the rule, tested both ways), so this
// guards the name rather than fixing a failure oc has today: an older Windows,
// another runtime, or a path that reaches a shell still reads them as devices.
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// A name ending in '.cookies' would save its page at `<x>.cookies.json`, the
// path of session `<x>`'s cookie jar, so `oc logout x` would delete it and
// `oc session ls` would hide it.
const isSafeName = (name) => typeof name === 'string' && name !== '.' && name !== '..'
  && !name.endsWith('.cookies') && !DEVICE_NAME.test(name.split('.')[0]) && SAFE_NAME.test(name);

/**
 * @param {string} name
 * @returns {string} the same name, once it is known to be a safe filename
 */
export function assertSafeName(name) {
  if (!isSafeName(name)) {
    throw new Error(`invalid session name '${name}', use letters, numbers, '.', '-', or '_' (not ending in '.cookies', not a device name like 'nul')`);
  }
  return name;
}

/**
 * @param {string} name
 * @returns {string}
 */
export const sessionPath = (name) => join(sessionDir(), `${assertSafeName(name)}.json`);

// Search engines and link aggregators wrap outbound links in a tracking
// redirector whose landing page is a script, not content, so following one
// verbatim renders nothing. The target is sitting in the query string.
const REDIRECT_PATH = /^\/(l|l\.php|url|out|redirect|away|link)\/?$/i;
const REDIRECT_PARAMS = ['uddg', 'url', 'u', 'q', 'target', 'to', 'dest'];

/**
 * @param {URL} url
 * @returns {string|null} the wrapped destination, or null if this is a normal link
 */
function unwrapRedirect(url) {
  if (!REDIRECT_PATH.test(url.pathname)) return null;
  for (const param of REDIRECT_PARAMS) {
    const value = url.searchParams.get(param);
    if (value && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

/**
 * Absolute URL for a handle, or null when the link is not followable
 * (javascript: handlers, mailto:/tel:, same-document fragments, malformed
 * hrefs). fetchPage prefixes https:// onto anything that is not already
 * http(s), so mailto:hi@example.com used to become a GET of example.com
 * with password "hi". A bare fragment is the page already open.
 * @param {string} href
 * @param {string} base
 * @returns {string|null}
 */
export function resolveHref(href, base) {
  if (!href) return null;
  try {
    const url = new URL(href, base || undefined);
    if (!/^https?:$/i.test(url.protocol)) return null;
    const dest = unwrapRedirect(url) ?? url.href;
    if (base) {
      const here = new URL(base);
      const there = new URL(dest);
      if (here.origin === there.origin && here.pathname === there.pathname && here.search === there.search) {
        return null;
      }
    }
    return dest;
  } catch {
    return null;
  }
}

const HISTORY_LIMIT = 20;

// A ceiling on what one page may leave on disk. Nothing real comes close;
// it is here so a runaway page cannot fill a home directory.
const SNAPSHOT_CHARS = 500_000;

/**
 * Session state for a freshly rendered page. Every block is kept, including
 * the ones the budget stopped short of, because the part an agent wants next
 * is by definition the part that did not fit.
 * @param {import('./distill.js').Page} page
 * @param {{history?: string[]}} [previous]
 * @param {{cursor?: number|null}} [opts] - where the render stopped, null when it finished the page
 */
export function sessionFromPage(page, previous, { cursor = 0 } = {}) {
  /** @type {import('./distill.js').Block[]} */
  const blocks = [];
  let chars = 0;
  let dropped = 0;
  for (const block of page.blocks) {
    chars += block.text.length;
    if (chars > SNAPSHOT_CHARS) {
      dropped++;
      continue;
    }
    // Relative hrefs are against <base href> when the page set one.
    const href = block.href ? resolveHref(block.href, page.base || page.url) : null;
    blocks.push({
      type: block.type,
      text: block.text,
      ...(block.n == null ? {} : { n: block.n }),
      ...(block.level == null ? {} : { level: block.level }),
      ...(href ? { href } : {}),
      ...(block.name ? { name: block.name } : {}),
    });
  }
  const history = [...(previous?.history ?? []), page.url].slice(-HISTORY_LIMIT);
  return {
    url: page.url,
    title: page.title,
    savedAt: new Date().toISOString(),
    blocks,
    cursor,
    ...(dropped ? { dropped } : {}),
    history,
  };
}

/**
 * Handle lookup for a saved page. Sessions written by earlier versions hold a
 * handles map instead of blocks, so `oc do` keeps working across an upgrade
 * even though `oc read` and `oc next` need the page reopened.
 * @param {any} state
 * @param {number} n
 */
export function handleFor(state, n) {
  if (state?.blocks) return state.blocks.find((b) => b.n === n) ?? null;
  return state?.handles?.[n] ?? null;
}

/**
 * The numbers a saved page offers, for error messages that tell an agent what
 * it could have asked for.
 * @param {any} state
 * @returns {number[]}
 */
export function handleNumbers(state) {
  if (state?.blocks) return state.blocks.filter((b) => b.n != null).map((b) => b.n);
  return Object.keys(state?.handles ?? {}).map(Number);
}

/**
 * @param {string} name
 * @param {object} state
 */
export function saveSession(name, state) {
  ensureSessionDir();
  // A snapshot of an authenticated page holds that page's text, so it gets the
  // same owner-only mode as the cookie sidecar. writeFileSync only sets the
  // mode on create, so a snapshot left world-readable by an older version is
  // tightened explicitly on the next save.
  const path = sessionPath(name);
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Drop a saved page. `oc logout` calls this alongside clearing the cookie jar:
 * a snapshot taken under a login holds that page's text, so leaving it behind
 * would make logout mean "the cookies are gone" rather than "nothing of this
 * login remains". Only a missing file is fine to ignore: a permission error
 * or a name that is a directory leaves the page on disk, and the caller is
 * about to tell the user it is gone.
 * @param {string} name
 * @returns {boolean} whether a saved page was removed
 */
export function clearSession(name) {
  try {
    unlinkSync(sessionPath(name));
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Missing or unreadable state is not an error: it means nothing is open yet,
 * and the caller says so in a sentence that names the next command.
 * @param {string} name
 * @returns {any|null}
 */
export function loadSession(name) {
  try {
    return JSON.parse(readFileSync(sessionPath(name), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every session on disk, for `oc session ls`: a name is a session when it has
 * a saved page, a cookie jar, or both, since `oc login` creates a jar without
 * a page and that credential is exactly what an agent auditing leftover logins
 * needs to see. An unreadable page is still listed by name: `oc session rm`
 * can drop it. Only names oc itself could have written are listed, so a stray
 * `..json` or a directory named like a page never shows up as something rm
 * then cannot remove.
 * @returns {{name: string, url: string|null, title: string|null, savedAt: string|null, cookies: boolean}[]}
 */
export function listSessions() {
  let entries;
  try {
    entries = readdirSync(sessionDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {Map<string, {name: string, url: string|null, title: string|null, savedAt: string|null, cookies: boolean}>} */
  const byName = new Map();
  const entry = (name) => {
    if (!byName.has(name)) byName.set(name, { name, url: null, title: null, savedAt: null, cookies: false });
    return byName.get(name);
  };
  for (const file of entries) {
    if (!file.isFile()) continue;
    const jarName = file.name.endsWith(COOKIE_JAR_SUFFIX) ? file.name.slice(0, -COOKIE_JAR_SUFFIX.length) : null;
    const pageName = jarName == null && file.name.endsWith('.json') ? file.name.slice(0, -'.json'.length) : null;
    if (jarName != null && isSafeName(jarName)) {
      entry(jarName).cookies = true;
    } else if (pageName != null && isSafeName(pageName)) {
      const info = entry(pageName);
      const state = loadSession(pageName);
      info.url = state?.url ?? null;
      info.title = state?.title ?? null;
      info.savedAt = state?.savedAt ?? null;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
