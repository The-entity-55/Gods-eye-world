import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import handler from '../../api/index.js';
import { ensureApiUrl } from './handler.js';
import { dispatch, createMiddlewareRouter } from './router.js';

function listen(handle) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handle(req, res)).catch(() => res.destroy());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function call(server, path, init) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  };
}

test('strips the mounted prefix and keeps the query string', async () => {
  const seen = [];
  const router = createMiddlewareRouter();
  router.use('/api/flights', (req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const server = await listen((req, res) => dispatch(router, req, res));
  try {
    const result = await call(server, '/api/flights?lat=30.27&lon=-97.74');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    assert.deepEqual(seen, ['/?lat=30.27&lon=-97.74']);
  } finally {
    await close(server);
  }
});

test('falls through to a more specific sibling mount', async () => {
  const seen = [];
  const router = createMiddlewareRouter();
  router.use('/api/flights', (req, res, next) => {
    if (req.url.split('?')[0] !== '/') return next();
    res.end(JSON.stringify({ handler: 'list' }));
  });
  router.use('/api/flights/track', (req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handler: 'track' }));
  });
  const server = await listen((req, res) => dispatch(router, req, res));
  try {
    const result = await call(server, '/api/flights/track?id=abc');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { handler: 'track' });
    assert.deepEqual(seen, ['/?id=abc']);
  } finally {
    await close(server);
  }
});

test('answers unknown routes with JSON 404 instead of an HTML fallback', async () => {
  const router = createMiddlewareRouter();
  router.use('/api/flights', (_req, res) => res.end('{}'));
  const server = await listen((req, res) => dispatch(router, req, res));
  try {
    const result = await call(server, '/api/unknown');
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: 'Unknown API route' });
  } finally {
    await close(server);
  }
});

test('recovers a nested path the platform rewrite moved into gevPath', () => {
  const req = {
    url: '/api/index?gevPath=tomtom/flow/5/1/2.pbf&z=5',
    query: { gevPath: 'tomtom/flow/5/1/2.pbf', z: '5' },
  };
  ensureApiUrl(req);
  assert.equal(req.url, '/api/tomtom/flow/5/1/2.pbf?z=5');
});

test('keeps encoded separators inside a captured route segment', () => {
  const upstream = 'https%3A%2F%2Fexample.com%2Ffeed';
  const req = {
    url: `/api/index?gevPath=gbfs/${upstream}`,
    query: { gevPath: `gbfs/${upstream}` },
  };
  ensureApiUrl(req);
  assert.equal(req.url, `/api/gbfs/${upstream}`);
});

test('decodes a captured path that was inserted wholly encoded', () => {
  const req = {
    url: '/api/index?gevPath=celestrak%2Fstations',
    query: { gevPath: 'celestrak/stations' },
  };
  ensureApiUrl(req);
  assert.equal(req.url, '/api/celestrak/stations');
});

test('leaves an already rooted api url untouched', () => {
  const req = { url: '/api/celestrak/stations?x=1', query: {} };
  ensureApiUrl(req);
  assert.equal(req.url, '/api/celestrak/stations?x=1');
});

test('serves nested routes through the platform rewrite', async () => {
  // Mirror vercel.json: /api/<rest>?<query> → /api/index?gevPath=<rest>&<query>.
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (/^\/api\//.test(url.pathname) && url.pathname !== '/api/index') {
      const params = new URLSearchParams(url.search);
      params.set('gevPath', url.pathname.slice('/api/'.length));
      req.query = Object.fromEntries(params);
      req.url = `/api/index?${params}`;
    }
    return handler(req, res);
  });
  try {
    const nested = await call(server, '/api/terrain/heights');
    assert.equal(nested.status, 400);
    assert.match(nested.body.error, /points/i);
  } finally {
    await close(server);
  }
});

test('the Vercel entry mounts the provider stack', async () => {
  const server = await listen(handler);
  try {
    const unknown = await call(server, '/api/definitely-not-a-route');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get('x-content-type-options'), 'nosniff');

    // Reaches the regional-brief handler, which rejects the missing point
    // before any upstream call.
    const regional = await call(server, '/api/regional-brief');
    assert.equal(regional.status, 400);
    assert.match(regional.body.error, /latitude and longitude/i);
  } finally {
    await close(server);
  }
});
