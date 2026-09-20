/**
 * Per-session cookie jar, stored in a sidecar file next to the page-state
 * JSON. Credentials never live in the session snapshot itself.
 */

import net from 'node:net';
import { join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, chmodSync } from 'node:fs';

import { sessionDir, ensureSessionDir, assertSafeName, COOKIE_JAR_SUFFIX } from './session.js';

const DEFAULT_EXPIRES_MS = 60 * 60 * 1000; // 1h
export { DEFAULT_EXPIRES_MS };
const FILE_MODE = 0o600;

// A jar is one login's worth of cookies, not a browser profile. The cap is
// what stops a hostile page from growing the sidecar without bound through
// Set-Cookie, and 4KB per cookie is the ceiling browsers already enforce.
export const MAX_COOKIES = 50;
export const MAX_COOKIE_BYTES = 4096;

// RFC 6265 cookie-name is an RFC 7230 token. Real cookie names are always one.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 6265's cookie-value is stricter than this - no space, comma, quote, or
// backslash - but real browser cookies carry all four, so a strict rule would
// reject headers a user correctly copied out of devtools. "Printable ASCII, no
// semicolon" keeps those and still rejects CR, LF, NUL, and every other
// control character, which is all a header-injection attempt has to work with.
const COOKIE_VALUE = /^[\x20-\x3A\x3C-\x7E]*$/;

// Hostnames only: no scheme, port, path, userinfo, or IPv6 literal.
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Returned by loadCookieJar when a sidecar existed but its session ceiling had passed. */
export const JAR_EXPIRED = Object.freeze({ expired: true });

let purged = false;

/**
 * A user-supplied string as it can safely appear in an error message: control
 * characters escaped so a CR cannot rewrite the line, and clipped so a huge
 * value does not become the error.
 * @param {unknown} value
 * @returns {string}
 */
function clip(value) {
  const s = String(value).replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

/**
 * @param {string} name
 * @returns {string}
 */
export function cookieJarPath(name) {
  return join(sessionDir(), `${assertSafeName(name)}${COOKIE_JAR_SUFFIX}`);
}

/**
 * Parse --expires values like 1h, 30m, 2d into milliseconds.
 * @param {string} value
 * @returns {number}
 */
export function parseExpires(value) {
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)(h|m|d|s)?$/i);
  if (!m) throw new Error(`invalid --expires '${value}', use a duration like 1h, 30m, or 2d`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'h').toLowerCase();
  const mult = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000;
  return n * mult;
}

/**
 * The hostname a jar is scoped to.
 *
 * domainMatches is a suffix match, so the value here decides how far the
 * cookies reach: '--domain com' would hand them to every .com host the session
 * ever fetches. --domain is trusted input, but the caller is often an agent and
 * the failure mode is silent credential spray, so a bare name is refused. The
 * rule needs no Public Suffix List: at least one dot, unless the value is an IP
 * literal or localhost. It does not catch multi-label public suffixes
 * ('--domain co.uk' still passes); a PSL is the only thing that would, and it
 * is a dependency this project will not take.
 * @param {string} domain
 * @returns {string} the lowercased, dot-stripped hostname
 */
export function normalizeDomain(domain) {
  const host = String(domain ?? '').trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (!host || !HOSTNAME.test(host)) {
    throw new Error(`--domain must be a hostname like example.com (got '${clip(domain)}')`);
  }
  if (net.isIP(host) || host === 'localhost') return host;
  if (!host.includes('.')) {
    throw new Error(
      `--domain '${host}' is a bare name, so these cookies would be sent to every host under it; `
      + 'use the full hostname they belong to, like example.com',
    );
  }
  return host;
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {boolean}
 */
function isValidCookie(name, value) {
  return COOKIE_NAME.test(name)
    && COOKIE_VALUE.test(value)
    && Buffer.byteLength(name) + Buffer.byteLength(value) <= MAX_COOKIE_BYTES;
}

/**
 * Fail at `oc login` rather than deep inside a transport. A CR or LF in a
 * seeded cookie surfaces later as node's own header-validation error, which
 * says nothing about which cookie is wrong, and whatever curl does with it
 * through impers is a separate question this closes off for both transports.
 * @param {string} name
 * @param {string} value
 */
function assertValidCookie(name, value) {
  if (!COOKIE_NAME.test(name)) {
    throw new Error(`invalid cookie name '${clip(name)}', names are letters, digits, and !#$%&'*+-.^_\`|~`);
  }
  if (!COOKIE_VALUE.test(value)) {
    throw new Error(
      `invalid value for cookie '${clip(name)}', cookie values cannot hold control characters or non-ASCII bytes`,
    );
  }
  if (Buffer.byteLength(name) + Buffer.byteLength(value) > MAX_COOKIE_BYTES) {
    throw new Error(`cookie '${clip(name)}' is over the ${MAX_COOKIE_BYTES}-byte limit`);
  }
}

/**
 * @typedef {Object} Cookie
 * @property {string} name
 * @property {string} value
 * @property {string} domain
 * @property {string} path
 * @property {boolean} [secure]
 * @property {boolean} [httpOnly]
 * @property {string} [expires] - ISO timestamp
 */

/**
 * @typedef {Object} CookieJar
 * @property {string} expiresAt - ISO session ceiling
 * @property {Cookie[]} cookies
 */

/**
 * Seed a jar from a Cookie request header string.
 *
 * Seeded cookies are marked secure unless the caller opts out: they were
 * almost certainly copied out of an https browser session, and cookieHeaderFor
 * withholds a secure cookie from a plain-http request, so the default is that
 * they never travel in cleartext - including on an https page that 302s to
 * http, where the user never typed the downgrade.
 * @param {string} header
 * @param {string} domain
 * @param {{ expiresMs?: number, allowHttp?: boolean }} [opts]
 * @returns {CookieJar}
 */
export function jarFromCookieHeader(header, domain, { expiresMs = DEFAULT_EXPIRES_MS, allowHttp = false } = {}) {
  const host = normalizeDomain(domain);
  /** @type {Cookie[]} */
  const cookies = [];
  for (const part of String(header ?? '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    assertValidCookie(name, value);
    cookies.push({ name, value, domain: host, path: '/', ...(allowHttp ? {} : { secure: true }) });
  }
  if (!cookies.length) throw new Error('no cookies found in --cookie string');
  if (cookies.length > MAX_COOKIES) {
    throw new Error(`--cookie holds ${cookies.length} cookies, more than the ${MAX_COOKIES} a session keeps`);
  }
  return {
    expiresAt: new Date(Date.now() + expiresMs).toISOString(),
    cookies,
  };
}

/**
 * @param {CookieJar} jar
 * @returns {boolean}
 */
export function isSessionExpired(jar) {
  return Date.now() >= Date.parse(jar.expiresAt);
}

/**
 * @param {Cookie} cookie
 * @param {string} sessionCeiling
 * @returns {boolean}
 */
function isCookieExpired(cookie, sessionCeiling) {
  const ceiling = Date.parse(sessionCeiling);
  if (Date.now() >= ceiling) return true;
  if (!cookie.expires) return false;
  const exp = Date.parse(cookie.expires);
  if (Number.isNaN(exp)) return false;
  return exp <= Date.now() || exp > ceiling;
}

/**
 * @param {CookieJar} jar
 * @returns {CookieJar}
 */
function pruneExpiredCookies(jar) {
  return {
    ...jar,
    cookies: jar.cookies.filter((c) => !isCookieExpired(c, jar.expiresAt)),
  };
}

/**
 * Read this session's jar before the process-wide purge can erase the evidence
 * of expiry; then sweep other stale sidecars.
 * @param {string} name
 * @returns {CookieJar | typeof JAR_EXPIRED | null}
 */
export function loadCookieJar(name) {
  let result = null;
  try {
    const jar = /** @type {CookieJar} */ (JSON.parse(readFileSync(cookieJarPath(name), 'utf8')));
    if (!jar?.expiresAt || !Array.isArray(jar.cookies)) {
      result = null;
    } else if (isSessionExpired(jar)) {
      clearCookieJar(name);
      result = JAR_EXPIRED;
    } else {
      const pruned = pruneExpiredCookies(jar);
      if (!pruned.cookies.length) {
        clearCookieJar(name);
        result = JAR_EXPIRED;
      } else {
        result = pruned;
      }
    }
  } catch {
    result = null;
  }
  ensurePurged();
  return result;
}

/**
 * @param {string} name
 * @param {CookieJar} jar
 */
export function saveCookieJar(name, jar) {
  ensureSessionDir();
  // writeFileSync only sets the mode on create, so an existing sidecar has its
  // owner-only mode reasserted on every save.
  const path = cookieJarPath(name);
  writeFileSync(path, JSON.stringify(pruneExpiredCookies(jar)), { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}

/**
 * Only a missing jar is fine to ignore: any other failure leaves a live
 * credential on disk that the caller may be about to report as gone.
 * @param {string} name
 * @returns {boolean} whether a jar was removed
 */
export function clearCookieJar(name) {
  try {
    unlinkSync(cookieJarPath(name));
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Delete expired sidecar jars under OC_HOME/sessions.
 */
export function purgeExpiredJars() {
  let dir;
  try {
    dir = sessionDir();
    readdirSync(dir);
  } catch {
    return;
  }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(COOKIE_JAR_SUFFIX)) continue;
    try {
      const jar = /** @type {CookieJar} */ (JSON.parse(readFileSync(join(dir, file), 'utf8')));
      if (isSessionExpired(jar)) unlinkSync(join(dir, file));
    } catch {
      // A jar that will not parse is as useless as an expired one, and a sweep
      // that cannot delete a file has nothing to report: the next one retries.
      try { unlinkSync(join(dir, file)); } catch {}
    }
  }
}

function ensurePurged() {
  if (purged) return;
  purged = true;
  purgeExpiredJars();
}

/** Reset purge-once guard (tests). */
export function _resetPurgeGuard() {
  purged = false;
}

/**
 * RFC 6265 domain matching (host-only and domain cookies).
 * @param {Cookie} cookie
 * @param {string} host
 */
function domainMatches(cookie, host) {
  const d = cookie.domain.toLowerCase().replace(/^\./, '');
  return host === d || host.endsWith(`.${d}`);
}

/**
 * RFC 6265 stores one cookie per name, domain, and path. Domain matching is
 * how a cookie is sent, not how it is replaced: a host-only cookie on
 * www.example.com is a different cookie from one scoped to example.com, and
 * Path=/app is a different cookie from Path=/.
 * @param {Cookie} a
 * @param {Cookie} b
 */
function sameCookie(a, b) {
  return a.name === b.name
    && a.domain.toLowerCase().replace(/^\./, '') === b.domain.toLowerCase().replace(/^\./, '')
    && (a.path || '/') === (b.path || '/');
}

/**
 * @param {Cookie} cookie
 * @param {string} path
 */
function pathMatches(cookie, path) {
  const p = cookie.path || '/';
  if (path === p) return true;
  if (!path.startsWith(p)) return false;
  return p.endsWith('/') || path[p.length] === '/';
}

/**
 * @param {Cookie} cookie
 * @param {CookieJar} jar
 * @param {string} host
 * @param {string} path
 */
function scopeMatches(cookie, jar, host, path) {
  return !isCookieExpired(cookie, jar.expiresAt) && domainMatches(cookie, host) && pathMatches(cookie, path);
}

/**
 * Cookies to send for a request URL.
 * @param {CookieJar} jar
 * @param {string} urlStr
 * @returns {string | undefined}
 */
export function cookieHeaderFor(jar, urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname || '/';
  const secure = url.protocol === 'https:';
  const active = jar.cookies.filter((c) => {
    if (c.secure && !secure) return false;
    return scopeMatches(c, jar, host, path);
  });
  if (!active.length) return undefined;
  // RFC 6265 5.4 order: the longest path first, and for equal paths the
  // cookie stored first. A server that reads one value for a name is meant to
  // get the most specific cookie, which is what a browser sends it. The sort
  // is stable, so jar order carries the tie the way creation time would.
  active.sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  return active.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Whether this URL would have received cookies but for its scheme. The CLI
 * uses it to name --allow-http, rather than fetching without credentials and
 * leaving the caller to wonder why an authenticated page came back a login
 * form.
 * @param {CookieJar} jar
 * @param {string} urlStr
 * @returns {boolean}
 */
export function withheldForScheme(jar, urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname || '/';
  return jar.cookies.some((c) => c.secure && scopeMatches(c, jar, host, path));
}

/**
 * An ISO timestamp, or undefined when the instant is outside what Date can
 * name. A huge Max-Age used to throw RangeError from toISOString and abort
 * the render of a page that was otherwise fine.
 * @param {number} ms
 * @returns {string | undefined}
 */
function expiryISO(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Parse one Set-Cookie header value.
 * @param {string} header
 * @param {string} requestUrl
 * @returns {Cookie | null}
 */
export function parseSetCookie(header, requestUrl) {
  const parts = header.split(';').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const eq = parts[0].indexOf('=');
  if (eq <= 0) return null;
  const name = parts[0].slice(0, eq).trim();
  // RFC 6265 lets cookie-value be DQUOTE *cookie-octet DQUOTE. ASP.NET and
  // several Java containers also quote Path. The quotes are wrapping, not
  // part of the value: leaving them on Path="/admin" meant the cookie was
  // never sent to /admin.
  const unquote = (s) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
  const value = unquote(parts[0].slice(eq + 1).trim());
  if (!name) return null;
  // A response is untrusted input, and whatever it sets here is echoed back in
  // the Cookie header of the next request, so it faces the same rule a seeded
  // cookie does. Dropped silently: a page setting a junk cookie is the page's
  // problem, not a reason to fail the render.
  if (!isValidCookie(name, value)) return null;

  const url = new URL(requestUrl);
  /** @type {Cookie} */
  const cookie = {
    name,
    value,
    domain: url.hostname.toLowerCase(),
    path: '/',
    // A cookie learned over https is pinned secure whether or not the response
    // said so, so a later hop to http - a redirect, or a link the agent
    // follows - cannot carry it in cleartext.
    ...(url.protocol === 'https:' ? { secure: true } : {}),
  };

  // Max-Age and Expires are collected separately: RFC 6265 5.3 says Max-Age
  // wins even when Expires is written last. Express writes them in that order,
  // and Expires is the server's clock, so a host whose clock is behind would
  // otherwise look expired the moment it was set.
  /** @type {string | undefined} */
  let maxAgeExpires;
  let sawMaxAge = false;
  /** @type {string | undefined} */
  let expiresAt;

  for (const attr of parts.slice(1)) {
    const sep = attr.indexOf('=');
    const key = (sep === -1 ? attr : attr.slice(0, sep)).trim().toLowerCase();
    const val = sep === -1 ? '' : attr.slice(sep + 1).trim();
    // The Domain attribute is deliberately ignored: cookies learned from a
    // response are pinned host-only to the host that set them. Honoring Domain
    // safely needs the Public Suffix List (a site could otherwise scope a
    // cookie to '.com' and have it sent to every site under it), and a PSL is a
    // dependency this project will not take. User-seeded cookies still scope by
    // the --domain they pass, which normalizeDomain holds to the same floor.
    if (key === 'path') {
      cookie.path = unquote(val) || '/';
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'max-age') {
      const age = Number(val);
      if (Number.isFinite(age)) {
        sawMaxAge = true;
        maxAgeExpires = age <= 0 ? new Date(0).toISOString() : expiryISO(Date.now() + age * 1000);
      }
    } else if (key === 'expires') {
      const exp = Date.parse(val);
      if (!Number.isNaN(exp)) expiresAt = expiryISO(exp);
    }
  }
  if (sawMaxAge) {
    if (maxAgeExpires) cookie.expires = maxAgeExpires;
  } else if (expiresAt) {
    cookie.expires = expiresAt;
  }
  return cookie;
}

/**
 * Extract Set-Cookie header values from a fetch/impers response.
 * @param {any} res
 * @returns {string[]}
 */
export function getSetCookieHeaders(res) {
  if (typeof res.headers?.getSetCookie === 'function') {
    const list = res.headers.getSetCookie();
    if (Array.isArray(list) && list.length) return list;
  }
  const raw = res.headers?.get?.('set-cookie');
  if (!raw) return [];
  // Undici joins with ", " but Expires contains commas: split only on ", " followed by a token=
  return raw.split(/,\s(?=[\w!#$%&'*+\-.^`|~]+=)/);
}

/**
 * Apply Set-Cookie headers to the jar for a response URL.
 * @param {CookieJar} jar
 * @param {string} url
 * @param {string[]} setCookieHeaders
 * @returns {CookieJar}
 */
export function storeFromResponse(jar, url, setCookieHeaders) {
  if (!setCookieHeaders.length) return jar;
  let cookies = [...jar.cookies];
  for (const header of setCookieHeaders) {
    const parsed = parseSetCookie(header, url);
    if (!parsed) continue;
    const at = cookies.findIndex((c) => sameCookie(c, parsed));
    // Max-Age=0 or Expires in the past deletes the cookie
    if (parsed.expires && Date.parse(parsed.expires) <= Date.now()) {
      if (at >= 0) cookies.splice(at, 1);
      continue;
    }
    // Replacing a cookie the jar already holds is always allowed; growing past
    // the cap is not, so a page cannot bloat the sidecar with fresh names. The
    // cookies already there - the seeded login among them - are what survive.
    if (at < 0 && cookies.length >= MAX_COOKIES) continue;
    if (parsed.expires) {
      const ceiling = Date.parse(jar.expiresAt);
      const exp = Date.parse(parsed.expires);
      if (exp > ceiling) parsed.expires = jar.expiresAt;
    }
    // A refresh keeps the slot it already had. RFC 6265 carries the original
    // creation time onto the new value, and jar order is what stands in for
    // that when cookieHeaderFor breaks a tie between equal-length paths.
    if (at >= 0) cookies[at] = parsed;
    else cookies.push(parsed);
  }
  return { ...jar, cookies };
}

/**
 * Mutable jar wrapper for fetch to update in place.
 * @param {string} sessionName
 * @param {CookieJar} data
 */
export function createJarHandle(sessionName, data) {
  let jar = data;
  return {
    sessionName,
    cookieHeaderFor(url) {
      return cookieHeaderFor(jar, url);
    },
    storeFromResponse(url, headers) {
      jar = storeFromResponse(jar, url, headers);
    },
    toJSON() {
      return jar;
    },
  };
}

/**
 * @param {string} name
 * @param {string} header
 * @param {string} domain
 * @param {{ expiresMs?: number, allowHttp?: boolean }} [opts]
 */
export function loginCookieJar(name, header, domain, opts) {
  const jar = jarFromCookieHeader(header, domain, opts);
  saveCookieJar(name, jar);
}
