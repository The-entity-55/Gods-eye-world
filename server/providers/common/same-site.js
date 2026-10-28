import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';

/**
 * Vercel terminates TLS at its edge and stamps every request with
 * X-Forwarded-* headers. The local "any proxy signal means 403" rule would
 * otherwise refuse every cost-bearing route on a deployment. Trust the
 * platform's forwarding metadata only when the runtime identifies itself as
 * Vercel (or an operator explicitly opts another trusted proxy in); the
 * Sec-Fetch-Site and exact-Origin checks below still run either way.
 */
export function platformProxyTrusted() {
  return process.env.VERCEL === '1' || process.env.GEV_TRUST_PROXY === '1';
}

/** The scheme an Origin should be compared against for this request. */
export function sameSiteProtocol(req) {
  if (platformProxyTrusted()) return forwardedProtocol(req);
  return req.socket?.encrypted ? 'https:' : 'http:';
}

/**
 * Cross-site request gate for cost-bearing and log endpoints. Feeds the
 * request to the pure, unit-tested `admitSameSiteRequest` and answers 403
 * itself when the request is refused. Returns true when it has already
 * responded (the caller returns); false when the handler should continue.
 * Refuses cross-site browser requests (foreign or opaque Origin, a
 * Sec-Fetch-Site other than same-origin/none, or reverse-proxy headers) while
 * keeping loopback non-browser tools and the HOST=0.0.0.0 LAN opt-in working.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True when a 403 was sent.
 */
export function admitSameSite(req, res) {
  const trusted = platformProxyTrusted();
  const verdict = admitSameSiteRequest({
    hostHeader: req.headers?.host,
    protocol: sameSiteProtocol(req),
    origin: req.headers?.origin,
    secFetchSite: req.headers?.['sec-fetch-site'],
    proxyHeaders: trusted ? {} : req.headers || {},
  });
  if (verdict.ok) return false;
  res.statusCode = verdict.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: verdict.error }));
  return true;
}

/**
 * Wrap a middleware handler so cross-site requests are refused with 403
 * before the handler runs. Loopback tools and same-origin browser requests
 * pass straight through.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown} handler
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown}
 */
export function sameSiteGated(handler) {
  return (req, res, next) => {
    if (admitSameSite(req, res)) return undefined;
    return handler(req, res, next);
  };
}

/**
 * Proxy header values arrive client-controlled; read one only when it is a
 * single scheme token, never a comma-separated chain.
 * @param {import('node:http').IncomingMessage} req
 * @returns {'http:'|'https:'}
 */
function forwardedProtocol(req) {
  if (req.socket?.encrypted) return 'https:';
  const proto = String(req.headers?.['x-forwarded-proto'] || '')
    .trim()
    .toLowerCase();
  return proto === 'https' ? 'https:' : 'http:';
}

/**
 * Cross-site gate for keyless routes the map needs in order to render
 * (`/api/terrain/heights`). It refuses the same cross-site browser shapes as
 * `admitSameSite` (a `Sec-Fetch-Site` other than same-origin/none, a foreign
 * or opaque `Origin`) but does not refuse reverse-proxy forwarding headers:
 * those protect credentials and spend, which a keyless route has neither of,
 * and refusing them would break rendering for an instance served behind the
 * reverse proxy the README documents. A single `X-Forwarded-Proto` supplies
 * the scheme an `Origin` is compared against. That header cannot be attached
 * to a cross-site browser request without a CORS preflight this server never
 * answers, and `Sec-Fetch-Site` is still enforced regardless.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True when a 403 was sent.
 */
export function admitSameSiteKeyless(req, res) {
  const verdict = admitSameSiteRequest({
    hostHeader: req.headers?.host,
    protocol: forwardedProtocol(req),
    origin: req.headers?.origin,
    secFetchSite: req.headers?.['sec-fetch-site'],
    proxyHeaders: {},
  });
  if (verdict.ok) return false;
  res.statusCode = verdict.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: verdict.error }));
  return true;
}
