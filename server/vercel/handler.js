import { dispatch } from './router.js';
import { getProviderRouter } from './stack.js';

/**
 * Every `/api` response is data, never a document; a response opened directly
 * in a tab gets no origin and can load nothing. Mirrors build/vite.js
 * (API_HEADERS) for the dev server, which does not run here.
 */
const API_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Vercel may hand the function the original request URL or only the captured
 * path segments. Normalize to a rooted `/api/...` target either way; the
 * provider handlers parse `req.url` relative to their own mount.
 */
function ensureApiUrl(req) {
  const current = typeof req.url === 'string' ? req.url : '';
  if (/^\/api(?:$|[/.?])/i.test(current.split('?')[0])) return;
  const segments = req.query?.path;
  if (!Array.isArray(segments) || !segments.length) return;
  const search = current.includes('?')
    ? current.slice(current.indexOf('?'))
    : '';
  req.url =
    `/api/${segments.map((segment) => encodeURIComponent(segment)).join('/')}` +
    search;
}

/** Shared entry point for the Vercel function; exported for tests. */
export async function handleApiRequest(req, res) {
  for (const [name, value] of Object.entries(API_HEADERS)) {
    res.setHeader(name, value);
  }
  ensureApiUrl(req);
  await dispatch(getProviderRouter(), req, res);
}
