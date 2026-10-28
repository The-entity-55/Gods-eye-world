import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitSameSite } from '../providers/common/same-site.js';

function request(headers) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
  const req = {
    headers,
    socket: { remoteAddress: '10.0.0.7', encrypted: false },
  };
  return { req, res };
}

function withVercel(value, run) {
  const previous = process.env.VERCEL;
  process.env.VERCEL = value;
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  });
}

const vercelHeaders = {
  host: 'gods-eye-world.vercel.app',
  origin: 'https://gods-eye-world.vercel.app',
  'sec-fetch-site': 'same-origin',
  'x-forwarded-for': '203.0.113.9',
  'x-forwarded-host': 'gods-eye-world.vercel.app',
  'x-forwarded-proto': 'https',
};

test('a deployment accepts its own same-origin request despite proxy headers', async () => {
  await withVercel('1', () => {
    const { req, res } = request({ ...vercelHeaders });
    assert.equal(admitSameSite(req, res), false);
    assert.equal(res.ended, undefined);
  });
});

test('cross-origin requests are still refused on a deployment', async () => {
  await withVercel('1', () => {
    const { req, res } = request({
      ...vercelHeaders,
      origin: 'https://evil.example',
    });
    assert.equal(admitSameSite(req, res), true);
    assert.equal(res.statusCode, 403);
  });
});

test('the local server still refuses forwarded requests', async () => {
  await withVercel(undefined, () => {
    const { req, res } = request({ ...vercelHeaders });
    assert.equal(admitSameSite(req, res), true);
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Proxied requests are not accepted/);
  });
});
