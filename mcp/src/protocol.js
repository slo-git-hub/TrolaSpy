// A small Model Context Protocol server over Streamable HTTP: tools only, and stateless. It
// answers both protocol eras: the 2026-07-28 revision (protocol version and client details in
// every request's _meta, `server/discover`) and the 2025 revisions that begin with an
// `initialize` handshake, which ChatGPT and other clients may still use. Every request is one
// POST with one JSON-RPC message, answered with one JSON object.

export const MODERN = ['2026-07-28'];
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY.slice(0, 3)];
const K = 'io.modelcontextprotocol/';
const TOOLS_TTL_MS = 3600e3;

// A tool's own failure (a bad date, nothing found): shown to the model as the tool's answer.
export class ToolError extends Error {}

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (id, code, message, status, data) => reply({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }, status);

// Header values may come Base64-encoded as =?base64?...?= (2026-07-28).
const unwrap = (v) => {
  const m = v && v.match(/^=\?base64\?(.*)\?=$/);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return null; }
};

// server: { info: { name, version }, instructions, tools: [{ name, title, description, inputSchema, annotations, run(args) }] }
// run returns { text, data } (data becomes structuredContent) or throws ToolError.
export async function handleMcp(request, server) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let msg;
  try { msg = await request.json(); } catch { return fail(null, -32700, 'Parse error', 400); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid request: one JSON-RPC message per POST', 400);
  }
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }); // a notification
  const { id, method } = msg, params = msg.params || {}, meta = params._meta || {};

  // Which era: a modern request names its protocol version in _meta.
  const version = meta[`${K}protocolVersion`];
  const modern = typeof version === 'string' && !LEGACY.includes(version);
  if (modern) {
    const h = (k) => request.headers.get(k);
    const mismatch = (h('mcp-protocol-version') && h('mcp-protocol-version') !== version && 'MCP-Protocol-Version')
      || (h('mcp-method') && h('mcp-method') !== method && 'Mcp-Method')
      || (h('mcp-name') && params.name !== undefined && unwrap(h('mcp-name')) !== params.name && 'Mcp-Name');
    if (mismatch) return fail(id, -32020, `Header mismatch: ${mismatch} does not match the request body`, 400);
    if (!MODERN.includes(version)) {
      return fail(id, -32022, `Unsupported protocol version ${version}`, 400, { supported: SUPPORTED, requested: version });
    }
  }
  const done = (result) => reply({ jsonrpc: '2.0', id,
    result: modern ? { resultType: 'complete', ...result, _meta: { [`${K}serverInfo`]: server.info } } : result });

  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return done({
        protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: server.info, instructions: server.instructions,
      });
    }
    case 'server/discover':
      return done({ supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: server.instructions,
        ttlMs: TOOLS_TTL_MS, cacheScope: 'private' });
    case 'ping':
      return done({});
    case 'tools/list':
      return done({
        tools: server.tools.map(({ run, ...t }) => t),
        ...(modern ? { ttlMs: TOOLS_TTL_MS, cacheScope: 'private' } : {}),
      });
    case 'tools/call': {
      const tool = server.tools.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`, modern ? 400 : 200);
      try {
        const { text, data } = await tool.run(params.arguments || {});
        return done({ content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}), isError: false });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error(`${tool.name} failed`, e);
        return done({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'TrolaSpy could not work that out just now. Try again in a moment.' }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`, modern ? 404 : 200);
  }
}
