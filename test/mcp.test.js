import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp, ToolError } from '../mcp/src/protocol.js';
import { dayStart, dayOf, parseDay, addDays } from '../mcp/src/tools.js';

const server = {
  info: { name: 'test', version: '1.0.0' },
  instructions: 'Test server.',
  tools: [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
      run: async (a) => ({ text: `got ${a.word}`, data: { word: a.word } }) },
    { name: 'bad', description: 'Fails', inputSchema: { type: 'object' }, run: async () => { throw new ToolError('No such day.'); } },
  ],
};
const post = (body, headers = {}) => handleMcp(new Request('https://x/mcp/s', {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}), server);
const modern = (method, params = {}, headers = {}) => post({ jsonrpc: '2.0', id: 7, method, params: { ...params,
  _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' } } } },
{ 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...headers });

test('a 2025 client: initialize, tools/list and tools/call', async () => {
  let r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  let b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.result.protocolVersion, '2025-06-18');
  assert.deepEqual(b.result.serverInfo, server.info);
  assert.ok(b.result.capabilities.tools);
  assert.equal(b.result.resultType, undefined);
  r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r.status, 202);
  b = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' })).json();
  assert.deepEqual(b.result.tools.map((t) => t.name), ['echo', 'bad']);
  assert.equal(b.result.tools[0].run, undefined);
  b = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { word: 'hi' } } })).json();
  assert.deepEqual(b.result, { content: [{ type: 'text', text: 'got hi' }], structuredContent: { word: 'hi' }, isError: false });
});

test('an unknown 2025 version gets the newest 2025 one', async () => {
  const b = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).json();
  assert.equal(b.result.protocolVersion, '2025-11-25');
});

test('a 2026-07-28 client: discover, list and call carry resultType and serverInfo', async () => {
  let b = await (await modern('server/discover')).json();
  assert.equal(b.result.resultType, 'complete');
  assert.ok(b.result.supportedVersions.includes('2026-07-28'));
  assert.deepEqual(b.result._meta['io.modelcontextprotocol/serverInfo'], server.info);
  b = await (await modern('tools/list')).json();
  assert.equal(b.result.cacheScope, 'private');
  assert.ok(b.result.ttlMs > 0);
  b = await (await modern('tools/call', { name: 'echo', arguments: { word: 'yo' } }, { 'mcp-name': 'echo' })).json();
  assert.equal(b.result.content[0].text, 'got yo');
  assert.equal(b.result.resultType, 'complete');
});

test('version and header checks, unknown methods and tools', async () => {
  let r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } });
  assert.equal(r.status, 400);
  let b = await r.json();
  assert.equal(b.error.code, -32022);
  assert.ok(b.error.data.supported.includes('2026-07-28'));
  r = await modern('tools/list', {}, { 'mcp-method': 'tools/call' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, -32020);
  r = await modern('tools/call', { name: 'echo' }, { 'mcp-name': `=?base64?${btoa('echo')}?=` });
  assert.equal(r.status, 200);
  r = await modern('prompts/list');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, -32601);
  b = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } })).json();
  assert.equal(b.error.code, -32602);
  r = await handleMcp(new Request('https://x/mcp/s'), server);
  assert.equal(r.status, 405);
  r = await post('{not json');
  assert.equal((await r.json()).error.code, -32700);
});

test('a tool error is the tool answer, not a protocol error', async () => {
  const b = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bad', arguments: {} } })).json();
  assert.equal(b.result.isError, true);
  assert.equal(b.result.content[0].text, 'No such day.');
});

test('days begin at local midnight, also when the clocks change', () => {
  assert.equal(new Date(dayStart('2026-10-11', 'Europe/Ljubljana')).toISOString(), '2026-10-10T22:00:00.000Z');
  assert.equal(new Date(dayStart('2026-12-24', 'Europe/Ljubljana')).toISOString(), '2026-12-23T23:00:00.000Z');
  assert.equal(new Date(dayStart('2026-03-29', 'Europe/Ljubljana')).toISOString(), '2026-03-28T23:00:00.000Z'); // spring forward at 02:00
  assert.equal(new Date(dayStart('2026-03-30', 'Europe/Ljubljana')).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(new Date(dayStart('2026-10-25', 'Europe/Lisbon')).toISOString(), '2026-10-24T23:00:00.000Z');
  assert.equal(new Date(dayStart('2026-07-01', 'Asia/Kolkata')).toISOString(), '2026-06-30T18:30:00.000Z');
  assert.equal(new Date(dayStart('2026-07-01', 'America/New_York')).toISOString(), '2026-07-01T04:00:00.000Z');
  assert.equal(dayOf(Date.parse('2026-10-10T22:30:00Z'), 'Europe/Ljubljana'), '2026-10-11');
});

test('days from words', () => {
  const today = '2026-10-14'; // a Wednesday
  assert.equal(parseDay('yesterday', today), '2026-10-13');
  assert.equal(parseDay('Today', today), today);
  assert.equal(parseDay('sunday', today), '2026-10-11');
  assert.equal(parseDay('wednesday', today), today);
  assert.equal(parseDay('Thursday', today), '2026-10-08');
  assert.equal(parseDay('2026-09-30', today), '2026-09-30');
  assert.equal(parseDay(undefined, today), null);
  assert.throws(() => parseDay('last week', today), ToolError);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
