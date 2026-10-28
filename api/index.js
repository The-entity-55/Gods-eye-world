import { handleApiRequest } from '../server/vercel/handler.js';

/**
 * Vercel entry point for every provider proxy route (`/api/*`).
 *
 * The app serves its data through same-origin `/api` middleware on the dev and
 * preview servers. A static Vercel deployment has no such server, so this
 * function mounts the identical provider stack (server/providers/local.js).
 *
 * It must stay a single top-level file: Vercel's `api/` filesystem routing only
 * resolves one path segment, so nested routes such as `/api/celestrak/stations`
 * never reach a `[...catchAll].js` function. vercel.json rewrites `/api/:path*`
 * here instead, and the handler rebuilds the original URL from `gevPath`.
 */
export default function handler(req, res) {
  return handleApiRequest(req, res);
}
