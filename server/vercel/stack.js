import { localProviderPlugins } from '../providers/local.js';
import { standaloneVoiceTools } from '../standalone/voiceTools.js';
import { createMiddlewareRouter } from './router.js';

/**
 * Provider plugins whose routes must not exist on a public deployment.
 * Provider Settings writes a credential store to disk and restarts the dev
 * server, neither of which a serverless function can do; it is dev-only by
 * design (see server/standalone/key-setup.js). Keys on Vercel come from the
 * project's environment variables instead.
 */
const EXCLUDED_PLUGINS = new Set(['gev-key-setup']);

/**
 * Build the same middleware stack the standalone server installs, minus the
 * dev-only credential panel. Voice tools are passed exactly as vite.config.js
 * passes them so a minted realtime token carries the same tool surface.
 */
export function createProviderRouter() {
  const router = createMiddlewareRouter();
  const tools = standaloneVoiceTools();
  for (const plugin of localProviderPlugins({
    realtime: { tools },
    gemini: { tools },
  })) {
    if (EXCLUDED_PLUGINS.has(plugin.name)) continue;
    const install = plugin.configurePreviewServer || plugin.configureServer;
    if (typeof install !== 'function') continue;
    // The installers only read `middlewares`; a null httpServer matches the
    // optional chaining they use for close/websocket hooks.
    install.call(plugin, { middlewares: router, httpServer: null });
  }
  return router;
}

let cachedRouter;

/** One stack per function instance; building it is idempotent and cold-start only. */
export function getProviderRouter() {
  cachedRouter ??= createProviderRouter();
  return cachedRouter;
}
