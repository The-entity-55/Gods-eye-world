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

/** The path vercel.json rewrites every `/api/*` request to. */
const ENTRY_PATH = /^\/api(?:\/index)?\/?$/i;

const API_PATH = /^\/api(?:$|[/.?])/i;

function splitQuery(url) {
  const index = url.indexOf('?');
  return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index + 1)];
}

function withQuery(pathname, query) {
  return query ? `${pathname}?${query}` : pathname;
}

/** Drop the rewrite's own parameter without re-encoding the rest of the query. */
function withoutCapturedParam(query) {
  return query
    .split('&')
    .filter((pair) => pair && !/^gevPath(?:=|$)/.test(pair))
    .join('&');
}

/**
 * The captured remainder the rewrite appended, read from the raw query so the
 * escapes inside it survive. Vercel may insert the path verbatim
 * (`gevPath=gbfs/https%3A%2F%2F…`), in which case the mount separators are real
 * slashes. A value with no slash at all but encoded ones was inserted as one
 * encoded segment and must be decoded back into a path.
 */
export function rewrittenPath(req, query) {
  const match = /(?:^|&)gevPath=([^&]*)/.exec(query);
  const raw =
    match?.[1] ??
    (typeof req.query?.gevPath === 'string' ? req.query.gevPath : '');
  if (!raw) return '';
  if (!raw.includes('/') && /%2f/i.test(raw)) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Restore the `/api/...` URL the provider handlers expect.
 *
 * Vercel's `api/` filesystem routing only resolves one path segment, so nested
 * routes reach the function through the vercel.json rewrite: normally as the
 * preserved original URL with `gevPath` appended to the query, otherwise as
 * `/api/index?gevPath=<remainder>`. The captured parameter must never reach a
 * provider handler — weather rejects unknown query keys. Dev/preview servers
 * and tests carry plain URLs and are left untouched.
 */
export function ensureApiUrl(req) {
  const current = typeof req.url === 'string' ? req.url : '';
  const [pathname, query] = splitQuery(current);

  if (!ENTRY_PATH.test(pathname)) {
    const cleaned = withoutCapturedParam(query);
    if (API_PATH.test(pathname)) {
      // The platform kept the original path but appended the rewrite's captured
      // segment to the query; handlers with strict parameter allowlists (weather)
      // refuse that extra key.
      if (cleaned !== query) req.url = withQuery(pathname, cleaned);
      return;
    }
    // Vercel hands a catch-all function the captured segments in `query.path`.
    const segments = req.query?.path;
    if (!Array.isArray(segments) || !segments.length) return;
    req.url = withQuery(
      `/api/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`,
      cleaned,
    );
    return;
  }

  const captured = rewrittenPath(req, query).replace(/^\/+/, '');
  if (!captured) return;
  req.url = withQuery(`/api/${captured}`, withoutCapturedParam(query));
}

/** Shared entry point for the Vercel function; exported for tests. */
export async function handleApiRequest(req, res) {
  for (const [name, value] of Object.entries(API_HEADERS)) {
    res.setHeader(name, value);
  }
  ensureApiUrl(req);
  await dispatch(getProviderRouter(), req, res);
}
