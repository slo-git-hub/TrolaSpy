// TrolaSpy's connector for ChatGPT (or any MCP client): read-only tools about Trola, served as
// an MCP server (see protocol.js and tools.js). Its address carries a secret the admin makes
// on the map page (Admin, ChatGPT), kept in settings as "mcp":
//   https://trolaspy-mcp.<subdomain>.workers.dev/mcp/<secret>
// Anyone with the address can ask these questions, so the admin can replace or turn it off.
import { handleMcp } from './protocol.js';
import { trolaServer } from './tools.js';
import { getSettings, putSetting } from '../../shared/alerts.js';

const USED_EVERY_MS = 10 * 60 * 1000; // "last used" is saved at most this often

// Compares without stopping at the first difference, so timing says nothing about the secret.
const same = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{16,64})\/?$/);
    if (!m) return new Response('Not found', { status: 404 });
    const { mcp } = await getSettings(env.DB, ['mcp']);
    if (!mcp || !mcp.token || !same(m[1], mcp.token)) return new Response('Not found', { status: 404 });
    const now = Date.now();
    if (request.method === 'POST' && now - (mcp.used_ts || 0) > USED_EVERY_MS) {
      ctx.waitUntil(putSetting(env.DB, 'mcp', { ...mcp, used_ts: now }).catch(() => {}));
    }
    return handleMcp(request, trolaServer(env.DB));
  },
};
