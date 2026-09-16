import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OC_HOME = mkdtempSync(join(tmpdir(), 'oc-cli-auth-'));
process.env.OC_HOME = OC_HOME;

const bin = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const loginHtml = readFileSync(new URL('./pages/login.html', import.meta.url), 'utf8');
const dashHtml = `<html><head><title>Dashboard</title></head><body>
  <h1>Welcome back</h1>
  ${'<p>Secret project notes for the signed-in user.</p>'.repeat(20)}
</body></html>`;

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

function childEnv(envExtra = {}) {
  const env = { ...process.env, OC_HOME, ...envExtra };
  for (const k of PROXY_ENV_KEYS) {
    if (!(k in envExtra)) delete env[k];
  }
  return env;
}

// Sync run for cases that never touch the network (login, logout, expired jar).
function oc(args, envExtra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: childEnv(envExtra) });
}

// Async run for cases that fetch through an in-process mock proxy: spawnSync
// would block the event loop the proxy server runs on and deadlock the test.
function ocAsync(args, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { env: childEnv(envExtra) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('login saves a sidecar jar and logout removes it', () => {
  let r = oc(['login', '--cookie', 'sid=abc', '--domain', 'example.com', '--session', 'work']);
  assert.equal(r.status, 0, r.stderr);
  const jarPath = join(OC_HOME, 'sessions', 'work.cookies.json');
  const saved = JSON.parse(readFileSync(jarPath, 'utf8'));
  assert.equal(saved.cookies[0].value, 'abc');

  r = oc(['logout', 'work']);
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => readFileSync(jarPath), /ENOENT/);
});

test('open with an expired jar reports session expired and clears it', () => {
  const sessionsDir = join(OC_HOME, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const jarPath = join(sessionsDir, 'expired.cookies.json');
  writeFileSync(jarPath, JSON.stringify({
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    cookies: [{ name: 'sid', value: 'old', domain: 'example.com', path: '/' }],
  }));
  const r = oc(['open', 'example.com', '--session', 'expired']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /session expired or cookies are no longer valid/);
  assert.equal(r.stdout.trim(), '');
  assert.throws(() => readFileSync(jarPath), /ENOENT/);
});

test('login requires --domain', () => {
  const r = oc(['login', '--cookie', 'sid=abc']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--domain is required/);
});

test('a session name that is a path is refused before any file is written', () => {
  for (const bad of ['../../.ssh/id_rsa', '/tmp/leak', 'a/b']) {
    const r = oc(['login', '--cookie', 'sid=abc', '--domain', 'example.com', '--session', bad]);
    assert.notEqual(r.status, 0, `expected failure for ${bad}`);
    assert.match(r.stderr, /invalid session name/);
  }
});

test('open sends the jar cookies and renders authenticated content', async () => {
  const proxy = http.createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(cookie.includes('sid=secret') ? dashHtml : loginHtml);
  });
  const port = await listen(proxy);
  const proxyUrl = `http://127.0.0.1:${port}`;
  try {
    // --allow-http because this mock speaks plain http; without it the cookie
    // is withheld, which is the case the next test covers.
    let r = oc(['login', '--cookie', 'sid=secret', '--domain', '1.1.1.1', '--session', 'authed', '--allow-http']);
    assert.equal(r.status, 0, r.stderr);

    r = await ocAsync(['open', 'http://1.1.1.1/dashboard', '--session', 'authed'], { HTTP_PROXY: proxyUrl });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Welcome back/);
    assert.doesNotMatch(r.stderr, /requires login|session expired/);
  } finally {
    proxy.close();
  }
});

test('a seeded cookie is not sent over plain http unless the user asked for it', async () => {
  const proxy = http.createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(cookie.includes('sid=secret') ? dashHtml : loginHtml);
  });
  const port = await listen(proxy);
  try {
    let r = oc(['login', '--cookie', 'sid=secret', '--domain', '1.1.1.1', '--session', 'httponly']);
    assert.equal(r.status, 0, r.stderr);
    const saved = JSON.parse(readFileSync(join(OC_HOME, 'sessions', 'httponly.cookies.json'), 'utf8'));
    assert.equal(saved.cookies[0].secure, true);

    r = await ocAsync(['open', 'http://1.1.1.1/dashboard', '--session', 'httponly'], {
      HTTP_PROXY: `http://127.0.0.1:${port}`,
    });
    // The page came back a login form because the credential stayed home, and
    // the warning names the flag that would have sent it.
    assert.match(r.stderr, /https-only cookies.*--allow-http/s);
    assert.doesNotMatch(r.stdout, /Welcome back/);
  } finally {
    proxy.close();
  }
});

test('an https page that redirects to http does not carry the cookie down with it', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.headers.cookie || '');
    if (req.url.endsWith('/start')) {
      res.writeHead(302, { location: 'http://1.1.1.1/landed' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(dashHtml);
  });
  const port = await listen(proxy);
  try {
    // Seeded over http so the first hop is reachable through the mock proxy,
    // then pinned secure by hand: the jar is what an https login leaves behind.
    let r = oc(['login', '--cookie', 'sid=secret', '--domain', '1.1.1.1', '--session', 'hop', '--allow-http']);
    assert.equal(r.status, 0, r.stderr);
    const jarPath = join(OC_HOME, 'sessions', 'hop.cookies.json');
    const jar = JSON.parse(readFileSync(jarPath, 'utf8'));
    jar.cookies[0].secure = true;
    writeFileSync(jarPath, JSON.stringify(jar));

    r = await ocAsync(['open', 'http://1.1.1.1/start', '--session', 'hop'], {
      HTTP_PROXY: `http://127.0.0.1:${port}`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(seen.length >= 2, `expected a redirect hop, saw ${seen.length} requests`);
    for (const cookie of seen) assert.doesNotMatch(cookie, /sid=secret/);
  } finally {
    proxy.close();
  }
});

test('--cookie - reads the header from stdin instead of argv', () => {
  const r = spawnSync(process.execPath, [bin, 'login', '--cookie', '-', '--domain', 'example.com', '--session', 'piped'], {
    encoding: 'utf8',
    env: childEnv(),
    input: 'Cookie: sid=from-stdin; auth=xyz\n',
  });
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(OC_HOME, 'sessions', 'piped.cookies.json'), 'utf8'));
  assert.deepEqual(saved.cookies.map((c) => `${c.name}=${c.value}`), ['sid=from-stdin', 'auth=xyz']);
});

test('--cookie - with nothing piped in says what to pipe', () => {
  const r = spawnSync(process.execPath, [bin, 'login', '--cookie', '-', '--domain', 'example.com'], {
    encoding: 'utf8',
    env: childEnv(),
    input: '   \n',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nothing on stdin/);
});

test('login refuses a bare TLD and a cookie carrying a control character', () => {
  let r = oc(['login', '--cookie', 'sid=abc', '--domain', 'com', '--session', 'tld']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /bare name/);
  assert.ok(!existsSync(join(OC_HOME, 'sessions', 'tld.cookies.json')));

  r = oc(['login', '--cookie', 'sid=a\r\nX-Injected: 1', '--domain', 'example.com', '--session', 'crlf']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid value for cookie 'sid'/);
  assert.ok(!existsSync(join(OC_HOME, 'sessions', 'crlf.cookies.json')));
});

test('logout drops the saved page along with the cookies', () => {
  let r = oc(['login', '--cookie', 'sid=abc', '--domain', 'example.com', '--session', 'clean']);
  assert.equal(r.status, 0, r.stderr);
  const jarPath = join(OC_HOME, 'sessions', 'clean.cookies.json');
  const pagePath = join(OC_HOME, 'sessions', 'clean.json');
  writeFileSync(pagePath, JSON.stringify({
    url: 'https://example.com/dashboard',
    title: 'Dashboard',
    savedAt: new Date().toISOString(),
    blocks: [{ type: 'text', text: 'Secret project notes for the signed-in user.' }],
    cursor: null,
    history: [],
  }));

  r = oc(['logout', 'clean']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(jarPath));
  assert.ok(!existsSync(pagePath));
});

test('open without cookies detects a login page and fails loud', async () => {
  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(loginHtml);
  });
  const port = await listen(proxy);
  try {
    const r = await ocAsync(['open', 'http://1.1.1.1/login', '--session', 'anon'], {
      HTTP_PROXY: `http://127.0.0.1:${port}`,
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /requires login/);
    assert.equal(r.stdout.trim(), '');
  } finally {
    proxy.close();
  }
});

test('json auth failure does not overwrite saved page state', async () => {
  const sessionsDir = join(OC_HOME, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionPath = join(sessionsDir, 'keep.json');
  writeFileSync(sessionPath, JSON.stringify({
    url: 'http://1.1.1.1/dashboard',
    title: 'Dashboard',
    savedAt: new Date().toISOString(),
    blocks: [{ type: 'heading', text: 'Welcome back', n: 1, level: 1 }],
    cursor: null,
    history: ['http://1.1.1.1/dashboard'],
  }));

  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(loginHtml);
  });
  const port = await listen(proxy);
  try {
    const r = await ocAsync(['open', 'http://1.1.1.1/login', '--json', '--session', 'keep'], {
      HTTP_PROXY: `http://127.0.0.1:${port}`,
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /requires login/);
    const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
    assert.equal(saved.title, 'Dashboard');
    assert.ok(existsSync(sessionPath));
  } finally {
    proxy.close();
  }
});
