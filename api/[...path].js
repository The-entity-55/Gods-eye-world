import { handleApiRequest } from '../server/vercel/handler.js';

/**
 * Vercel entry point for every provider proxy route (`/api/*`).
 *
 * The app serves its data through same-origin `/api` middleware on the dev and
 * preview servers. A static Vercel deployment has no such server, so every key-
 * backed layer reported unavailable. This function mounts the identical
 * provider stack (server/providers/local.js) inside a Node function.
 */
export default function handler(req, res) {
  return handleApiRequest(req, res);
}
