/**
 * Minimal connect-compatible router for the Vercel function entry.
 *
 * The provider middleware is written against Vite's connect stack: it mounts on
 * a path prefix, receives `req.url` with that prefix stripped, and may call
 * `next()` to fall through to a more specific mount (e.g. `/api/flights` →
 * `/api/flights/track`). Reproduce exactly those semantics so the same handlers
 * run unchanged on the dev server and in a serverless function.
 */

function pathnameOf(url) {
  try {
    return new URL(String(url || '/'), 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/** Connect's mount rule: exact, or followed by `/` or `.`. */
function matchesMount(pathname, mount) {
  if (mount === '/') return true;
  if (!pathname.startsWith(mount)) return false;
  const boundary = pathname.charAt(mount.length);
  return (
    pathname.length === mount.length || boundary === '/' || boundary === '.'
  );
}

/** Connect strips the mount prefix and keeps the remainder rooted at `/`. */
function relativeUrl(url, mount) {
  if (mount === '/') return url || '/';
  const rest = String(url || '').slice(mount.length);
  if (!rest) return '/';
  return rest.startsWith('/') ? rest : `/${rest}`;
}

export function createMiddlewareRouter() {
  const entries = [];
  return {
    use(route, handler) {
      let mount = route;
      let fn = handler;
      if (typeof mount === 'function') {
        fn = mount;
        mount = '/';
      }
      if (typeof fn !== 'function') {
        throw new TypeError('middleware must be a function');
      }
      const normalized = String(mount || '/').replace(/\/+$/, '') || '/';
      entries.push({ mount: normalized, handler: fn });
      return this;
    },
    entries,
  };
}

/**
 * Run the router against one request. Resolves when the response finishes (or
 * the connection closes); never rejects, because the caller is a serverless
 * handler with no one above it to answer.
 */
export function dispatch(router, req, res) {
  const entries = router?.entries || [];
  const originalUrl = typeof req.url === 'string' ? req.url : '/';
  const pathname = pathnameOf(originalUrl);
  let index = 0;
  let settled = false;

  return new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      req.url = originalUrl;
      res.removeListener?.('finish', finish);
      res.removeListener?.('close', finish);
      resolve();
    };

    res.once('finish', finish);
    res.once('close', finish);

    const fail = (error) => {
      if (settled) return;
      console.error(
        '[api] unhandled middleware error:',
        error?.message || error,
      );
      if (res.headersSent || res.writableEnded) {
        finish();
        return;
      }
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Internal API error' }));
      finish();
    };

    const notFound = () => {
      if (settled) return;
      if (!res.headersSent) {
        res.writeHead(404, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
      }
      res.end(JSON.stringify({ error: 'Unknown API route' }));
      finish();
    };

    const next = (error) => {
      if (settled) return;
      if (error) {
        fail(error);
        return;
      }
      while (index < entries.length) {
        const entry = entries[index++];
        req.url = originalUrl;
        if (!matchesMount(pathname, entry.mount)) continue;
        req.url = relativeUrl(originalUrl, entry.mount);
        let result;
        try {
          result = entry.handler(req, res, next);
        } catch (error2) {
          fail(error2);
          return;
        }
        // Async handlers signal failure by rejecting; their own try/catch
        // normally answers first, so only take over an unanswered response.
        if (result && typeof result.then === 'function') result.catch(fail);
        return;
      }
      notFound();
    };

    next();
  });
}
