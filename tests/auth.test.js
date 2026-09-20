import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const { distill, toMarkdown } = await import('../src/distill.js');
const { authFailure } = await import('../src/auth.js');
const { fetchPage } = await import('../src/fetch.js');

const loginHtml = readFileSync(new URL('./pages/login.html', import.meta.url), 'utf8');

const navWithLoginLink = `<html><head><title>News</title></head><body>
  <nav><a href="/login">Log in</a></nav>
  <article>${'<p>Real story content here.</p>'.repeat(20)}</article>
</body></html>`;

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function withoutProxyEnv(run) {
  const prev = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
  return run().finally(() => {
    for (const k of PROXY_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test('authFailure detects a login page with password input and supporting signals', () => {
  const page = distill(loginHtml, 'https://example.com/login');
  assert.match(authFailure(page, 'https://example.com/login'), /requires login/);
});

test('authFailure still detects a login form whose type attributes are uppercase', () => {
  // HTML type is case-insensitive. type=PASSWORD used to store as PASSWORD,
  // so the password-field check missed it and a login wall rendered as content.
  const html = `<html><head><title>Sign in</title></head><body>
    <input type="PASSWORD" name="p">
    <button>Log in</button>
  </body></html>`;
  const page = distill(html, 'https://example.com/login');
  assert.match(authFailure(page, 'https://example.com/login'), /requires login/);
});

test('authFailure reports expired session when auth was sent', () => {
  const page = distill(loginHtml, 'https://example.com/login');
  assert.match(
    authFailure(page, 'https://example.com/login', { hadAuth: true }),
    /session expired or cookies are no longer valid/,
  );
});

test('authFailure ignores nav login links without a password field', () => {
  const page = distill(navWithLoginLink, 'https://example.com/news');
  assert.equal(authFailure(page, 'https://example.com/news'), null);
});

test('authFailure ignores a password field without login context', () => {
  const html = `<html><head><title>Account settings</title></head><body>
    <p>Change your password below.</p>
    <input type="password" name="new">
    <button>Save</button>
  </body></html>`;
  const page = distill(html, 'https://example.com/settings');
  assert.equal(authFailure(page, 'https://example.com/settings'), null);
});

test('fetch through a proxy detects a login page end to end (offline)', async () => {
  await withoutProxyEnv(async () => {
    const proxy = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(loginHtml);
    });
    const port = await listen(proxy);
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
    try {
      const { html, url } = await fetchPage('http://1.1.1.1/login');
      const page = distill(html, url);
      assert.match(authFailure(page, url), /requires login/);
      assert.match(authFailure(page, url, { hadAuth: true }), /session expired or cookies are no longer valid/);
    } finally {
      proxy.close();
    }
  });
});

test('auth failure gates raw output before markdown is emitted', async () => {
  await withoutProxyEnv(async () => {
    const proxy = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(loginHtml);
    });
    const port = await listen(proxy);
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
    try {
      const { html, url } = await fetchPage('http://1.1.1.1/login');
      const page = distill(html, url);
      assert.ok(authFailure(page, url));
      assert.match(toMarkdown(html, url), /Sign in/);
    } finally {
      proxy.close();
    }
  });
});
