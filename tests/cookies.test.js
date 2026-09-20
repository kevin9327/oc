import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { modeSkip } from './helpers.js';

const OC_HOME = mkdtempSync(join(tmpdir(), 'oc-cookie-test-'));
process.env.OC_HOME = OC_HOME;
const MODE_SKIP = modeSkip(OC_HOME);

const {
  jarFromCookieHeader,
  parseExpires,
  cookieHeaderFor,
  parseSetCookie,
  storeFromResponse,
  saveCookieJar,
  loadCookieJar,
  clearCookieJar,
  purgeExpiredJars,
  isSessionExpired,
  cookieJarPath,
  normalizeDomain,
  withheldForScheme,
  MAX_COOKIES,
  MAX_COOKIE_BYTES,
  JAR_EXPIRED,
  _resetPurgeGuard,
} = await import('../src/cookies.js');

test('parseExpires accepts common durations', () => {
  assert.equal(parseExpires('1h'), 3_600_000);
  assert.equal(parseExpires('30m'), 1_800_000);
  assert.equal(parseExpires('2d'), 172_800_000);
});

test('jarFromCookieHeader parses a Cookie header for a domain', () => {
  const jar = jarFromCookieHeader('session=abc; auth=xyz', 'Example.COM');
  assert.equal(jar.cookies.length, 2);
  assert.equal(jar.cookies[0].name, 'session');
  assert.equal(jar.cookies[0].value, 'abc');
  assert.equal(jar.cookies[0].domain, 'example.com');
  assert.ok(Date.parse(jar.expiresAt) > Date.now());
});

test('a seeded cookie is https-only by default and travels over http only on request', () => {
  const secure = jarFromCookieHeader('session=abc', 'example.com');
  assert.equal(secure.cookies[0].secure, true);
  // The credential came out of an https browser session, so plain http never
  // sees it unless the user says the site is http-only.
  assert.equal(cookieHeaderFor(secure, 'http://example.com/'), undefined);
  assert.equal(cookieHeaderFor(secure, 'https://example.com/'), 'session=abc');
  assert.ok(withheldForScheme(secure, 'http://example.com/'));
  assert.ok(!withheldForScheme(secure, 'https://example.com/'));

  const opted = jarFromCookieHeader('session=abc', 'example.com', { allowHttp: true });
  assert.equal(opted.cookies[0].secure, undefined);
  assert.equal(cookieHeaderFor(opted, 'http://example.com/'), 'session=abc');
  assert.ok(!withheldForScheme(opted, 'http://example.com/'));
});

test('a cookie learned over https is pinned secure even without the attribute', () => {
  const jar = { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cookies: [] };
  const next = storeFromResponse(jar, 'https://example.com/', ['sid=x; Path=/']);
  assert.equal(next.cookies[0].secure, true);
  // Which is what keeps it off the wire when a later hop drops to http.
  assert.equal(cookieHeaderFor(next, 'http://example.com/'), undefined);

  // A cookie a site set over http was never secret to begin with; it is left alone.
  const plain = storeFromResponse(jar, 'http://example.com/', ['sid=x; Path=/']);
  assert.equal(plain.cookies[0].secure, undefined);
});

test('normalizeDomain refuses a bare TLD but keeps IPs and localhost', () => {
  assert.equal(normalizeDomain('.Example.COM.'), 'example.com');
  assert.equal(normalizeDomain('1.1.1.1'), '1.1.1.1');
  assert.equal(normalizeDomain('localhost'), 'localhost');
  // A suffix match on a bare TLD would hand the cookie to every host under it.
  for (const bad of ['com', 'co', 'localdomain']) {
    assert.throws(() => normalizeDomain(bad), /bare name/, `expected '${bad}' to be refused`);
  }
  for (const bad of ['', '.', '/', 'example.com:8443', 'http://example.com', 'example.com/x', 'ex ample.com', '-x.com']) {
    assert.throws(() => normalizeDomain(bad), /must be a hostname/, `expected '${bad}' to be refused`);
  }
});

test('a jar seeded with a bare TLD never reaches every host under it', () => {
  assert.throws(() => jarFromCookieHeader('sid=secret', 'com'), /bare name/);
});

test('jarFromCookieHeader rejects control characters in a name or value', () => {
  assert.throws(() => jarFromCookieHeader('sid=a\r\nX-Injected: 1', 'example.com'), /invalid value for cookie 'sid'/);
  assert.throws(() => jarFromCookieHeader('sid=a\u0000b', 'example.com'), /invalid value for cookie/);
  assert.throws(() => jarFromCookieHeader('sid=caf\u00e9', 'example.com'), /invalid value for cookie/);
  assert.throws(() => jarFromCookieHeader('bad name=x', 'example.com'), /invalid cookie name/);
  assert.throws(() => jarFromCookieHeader('sid=x'.padEnd(MAX_COOKIE_BYTES + 8, 'y'), 'example.com'), /over the .* limit/);
  // A CR in the error message would let the rejected value rewrite the line.
  assert.throws(() => jarFromCookieHeader('sid=a\rb', 'example.com'), (err) => !/[\r\n]/.test(err.message));
  // Values a browser really hands over - base64 padding, commas, quotes - still pass.
  const ok = jarFromCookieHeader('sid="a,b+c/d=="; _ga=GA1.2.3', 'example.com');
  assert.equal(ok.cookies.length, 2);
});

test('a hostile response cannot grow the jar past its cap', () => {
  const jar = jarFromCookieHeader('sid=secret', 'example.com');
  const headers = Array.from({ length: MAX_COOKIES * 3 }, (_, i) => `junk${i}=x; Path=/`);
  const next = storeFromResponse(jar, 'https://example.com/', headers);
  assert.equal(next.cookies.length, MAX_COOKIES);
  // The seeded login is what survives; the overflow is what is refused.
  assert.ok(next.cookies.some((c) => c.name === 'sid' && c.value === 'secret'));
  // A full jar still takes an update to a cookie it already holds.
  const rotated = storeFromResponse(next, 'https://example.com/', ['junk0=rotated; Path=/']);
  assert.equal(rotated.cookies.length, MAX_COOKIES);
  assert.equal(rotated.cookies.find((c) => c.name === 'junk0').value, 'rotated');
});

test('a response cannot smuggle a control character into the next request', () => {
  const jar = { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cookies: [] };
  const next = storeFromResponse(jar, 'https://example.com/', ['sid=a\r\nX-Injected: 1; Path=/']);
  assert.equal(next.cookies.length, 0);
  assert.equal(parseSetCookie('sid=a\r\nb', 'https://example.com/'), null);
});

test('cookieHeaderFor matches domain and path', () => {
  const jar = {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    cookies: [
      { name: 'a', value: '1', domain: 'example.com', path: '/' },
      { name: 'b', value: '2', domain: 'other.com', path: '/' },
      { name: 'c', value: '3', domain: 'example.com', path: '/app', secure: true },
    ],
  };
  assert.equal(cookieHeaderFor(jar, 'https://example.com/app/home'), 'a=1; c=3');
  assert.equal(cookieHeaderFor(jar, 'http://example.com/app/home'), 'a=1');
  assert.equal(cookieHeaderFor(jar, 'https://other.com/'), 'b=2');
  assert.equal(cookieHeaderFor(jar, 'https://example.com/other'), 'a=1');
});

test('parseSetCookie reads attributes and pins the cookie host-only', () => {
  const c = parseSetCookie('sid=val; Path=/app; Domain=.example.com; Secure; HttpOnly; Max-Age=3600',
    'https://www.example.com/login');
  assert.equal(c.name, 'sid');
  assert.equal(c.value, 'val');
  // Domain is ignored: the cookie is scoped to the host that set it, not the
  // wider domain the response asked for.
  assert.equal(c.domain, 'www.example.com');
  assert.equal(c.path, '/app');
  assert.ok(c.secure);
  assert.ok(c.httpOnly);
  assert.ok(c.expires);
});

test('a response cannot widen a cookie to a public suffix and reach other sites', () => {
  const jar = { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cookies: [] };
  // A page fetched under the jar tries to plant a '.com'-scoped cookie.
  const next = storeFromResponse(jar, 'https://evil.example/', ['sid=x; Domain=.com; Path=/']);
  assert.equal(next.cookies[0].domain, 'evil.example');
  // It is never sent to an unrelated site that merely shares the suffix.
  assert.equal(cookieHeaderFor(next, 'https://bank.com/'), undefined);
  assert.equal(cookieHeaderFor(next, 'https://evil.example/'), 'sid=x');
});

test('storeFromResponse replaces cookies with the same name and domain', () => {
  const jar = {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    cookies: [{ name: 'sid', value: 'old', domain: 'example.com', path: '/' }],
  };
  const next = storeFromResponse(jar, 'https://example.com/', ['sid=new; Path=/; Domain=example.com']);
  assert.equal(next.cookies.length, 1);
  assert.equal(next.cookies[0].value, 'new');
});

test('a subdomain Set-Cookie does not swallow the login scoped to the parent domain', () => {
  // `oc login --domain example.com` then `oc open https://www.example.com/`.
  // The www host often refreshes sid; that is a different cookie from the one
  // that still has to reach example.com and api.example.com.
  const jar = jarFromCookieHeader('sid=secret', 'example.com');
  const next = storeFromResponse(jar, 'https://www.example.com/', ['sid=www; Path=/']);
  assert.equal(cookieHeaderFor(next, 'https://example.com/'), 'sid=secret');
  assert.equal(cookieHeaderFor(next, 'https://api.example.com/'), 'sid=secret');
  const www = cookieHeaderFor(next, 'https://www.example.com/');
  assert.match(www, /sid=secret/);
  assert.match(www, /sid=www/);
});

test('Set-Cookie identity is name, domain, and path, not name alone', () => {
  const jar = {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    cookies: [
      { name: 'sid', value: 'apex', domain: 'example.com', path: '/' },
      { name: 'sid', value: 'root', domain: 'www.example.com', path: '/' },
    ],
  };
  const next = storeFromResponse(jar, 'https://www.example.com/app', ['sid=app; Path=/app']);
  assert.equal(next.cookies.length, 3);
  assert.equal(next.cookies.find((c) => c.domain === 'example.com' && c.path === '/').value, 'apex');
  assert.equal(next.cookies.find((c) => c.domain === 'www.example.com' && c.path === '/').value, 'root');
  assert.equal(next.cookies.find((c) => c.path === '/app').value, 'app');

  // Max-Age=0 from www deletes only the www Path=/ cookie.
  const gone = storeFromResponse(next, 'https://www.example.com/', ['sid=; Max-Age=0; Path=/']);
  assert.equal(gone.cookies.length, 2);
  assert.ok(gone.cookies.some((c) => c.domain === 'example.com' && c.value === 'apex'));
  assert.ok(gone.cookies.some((c) => c.path === '/app' && c.value === 'app'));
  assert.ok(!gone.cookies.some((c) => c.domain === 'www.example.com' && c.path === '/'));
});

test('session ceiling caps per-cookie expiry from Set-Cookie', () => {
  const ceiling = new Date(Date.now() + 3_600_000).toISOString();
  const jar = { expiresAt: ceiling, cookies: [] };
  const next = storeFromResponse(jar, 'https://example.com/', [
    'sid=x; Max-Age=86400; Domain=example.com; Path=/',
  ]);
  assert.equal(next.cookies[0].expires, ceiling);
});

test('saveCookieJar writes an owner-only jar and loadCookieJar reads it back', async (t) => {
  clearCookieJar('work');
  const jar = jarFromCookieHeader('token=secret', 'example.com', { expiresMs: 3_600_000 });
  saveCookieJar('work', jar);
  // Named as its own subtest so a filesystem without permission bits reports a
  // skip with the reason, rather than passing a weaker check under this name.
  await t.test('mode is 0600', { skip: MODE_SKIP }, () => {
    assert.equal(statSync(cookieJarPath('work')).mode & 0o777, 0o600);
  });
  const loaded = loadCookieJar('work');
  assert.equal(loaded.cookies[0].value, 'secret');
});

test('loadCookieJar returns JAR_EXPIRED and clears an expired jar', () => {
  clearCookieJar('expired');
  saveCookieJar('expired', {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    cookies: [{ name: 'a', value: 'b', domain: 'example.com', path: '/' }],
  });
  _resetPurgeGuard();
  assert.equal(loadCookieJar('expired'), JAR_EXPIRED);
  assert.throws(() => readFileSync(cookieJarPath('expired')), /ENOENT/);
});

test('purgeExpiredJars removes stale sidecar files', () => {
  clearCookieJar('old');
  clearCookieJar('fresh');
  writeFileSync(cookieJarPath('old'), JSON.stringify({
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    cookies: [{ name: 'a', value: 'b', domain: 'example.com', path: '/' }],
  }));
  saveCookieJar('fresh', jarFromCookieHeader('x=1', 'example.com'));
  _resetPurgeGuard();
  purgeExpiredJars();
  assert.throws(() => readFileSync(cookieJarPath('old')), /ENOENT/);
  assert.ok(loadCookieJar('fresh'));
});

test('isSessionExpired respects the session ceiling', () => {
  const jar = { expiresAt: new Date(Date.now() + 1000).toISOString(), cookies: [] };
  assert.ok(!isSessionExpired(jar));
  jar.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.ok(isSessionExpired(jar));
});
