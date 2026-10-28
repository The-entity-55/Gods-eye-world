import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import handler from '../../api/index.js';
import { ensureApiUrl } from './handler.js';
import { dispatch, createMiddlewareRouter } from './router.js';
import { createProviderRouter } from './stack.js';

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

test('drops the captured parameter when the platform kept the path', () => {
  // Production shape observed on Vercel: the original URL survives and the
  // rewrite appends its captured segment, which strict handlers refuse.
  for (const url of [
    '/api/weather/manifest?product=clouds&gevPath=weather/manifest',
    '/api/weather/manifest?gevPath=weather/manifest&product=clouds',
  ]) {
    const req = { url, query: {} };
    ensureApiUrl(req);
    assert.equal(req.url, '/api/weather/manifest?product=clouds');
  }
});

test('drops the captured parameter without re-encoding the query', () => {
  const upstream = 'https%3A%2F%2Fexample.com%2Ffeed%3Fa%3D1%26b%3D2';
  const req = {
    url: `/api/gbfs/${upstream}?gevPath=gbfs/${upstream}&gevPath=x`,
    query: {},
  };
  ensureApiUrl(req);
  assert.equal(req.url, `/api/gbfs/${upstream}`);
});

test('serves nested routes through the platform rewrite', async () => {
  // Mirror the deployment: the rewrite keeps the original path and appends the
  // captured remainder to the query.
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (/^\/api\//.test(url.pathname) && url.pathname !== '/api/index') {
      url.searchParams.set('gevPath', url.pathname.slice('/api/'.length));
      req.query = Object.fromEntries(url.searchParams);
      req.url = `${url.pathname}${url.search}`;
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

/**
 * Every path the browser calls through `/api`. The vercel.json rewrite sends
 * all of them to the single entry function, so the stack must mount each one.
 */
const REQUIRED_MOUNTS = [
  '/api/flights',
  '/api/flights/track',
  '/api/celestrak',
  '/api/tomtom',
  '/api/firms',
  '/api/launches',
  '/api/terrain/heights',
  '/api/adsbdb',
  '/api/overpass',
  '/api/route',
  '/api/military-installations',
  '/api/military',
  '/api/military/track',
  '/api/regional-brief',
  '/api/geocode',
  '/api/weather-effects',
  '/api/cctv',
  '/api/radio',
  '/api/gbfs',
  '/api/local-receivers/aircraft',
  '/api/transit',
  '/api/vessels',
  '/api/openai/hud-summary',
  '/api/realtime/debug-log',
  '/api/realtime/token',
  '/api/realtime/oauth-status',
  '/api/realtime/oauth-login',
  '/api/gemini/token',
  '/api/google/nearby-places',
  '/api/google/text-search',
  '/api/google/geocode',
  '/api/google/reverse-geocode',
  '/api/wind',
  '/api/weather',
  '/api/cyclones',
  '/api/mapillary/status',
  '/api/mapillary/tiles',
  '/api/fire-perimeters',
  '/api/gnss-integrity',
];

test('mounts every provider route the app calls', () => {
  const mounts = new Set(
    createProviderRouter().entries.map((entry) => entry.mount),
  );
  assert.deepEqual(
    REQUIRED_MOUNTS.filter((mount) => !mounts.has(mount)),
    [],
  );
  // Credential setup writes .env and restarts a dev server; it must stay local.
  assert.equal(mounts.has('/api/setup/keys'), false);
  assert.equal(mounts.has('/api/setup/status'), false);
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
