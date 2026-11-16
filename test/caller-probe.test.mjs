import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { summarizeMetadata } from '../spikes/chat-control/caller-probe.mjs';

test('caller probe exposes only bounded metadata keys and correlation IDs', () => {
  const result = summarizeMetadata({ 'codex/thread_id': 'thread-fixture', 'codex/turn_id': 'turn-fixture',
    secret: { nested: 'secret-value' }, arbitrary: 'private-text', authToken: 'credential' });
  assert.deepEqual(result.correlation, { 'codex/thread_id': 'thread-fixture', 'codex/turn_id': 'turn-fixture' });
  assert.equal(result.identityVerified, false);
  assert(!JSON.stringify(result).includes('private-text')); assert(!JSON.stringify(result).includes('secret'));
});
test('official SDK round trip uses request metadata and rejects caller arguments', async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['spikes/chat-control/caller-probe.mjs'], stderr: 'pipe' });
  const client = new Client({ name: 'cc00-fixture', version: '0' });
  t.after(() => client.close()); await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 1);
  const result = await client.callTool({ name: 'observe_caller', arguments: {}, _meta: { 'codex/thread_id': 'fixture-thread' } });
  assert.deepEqual(result.structuredContent.correlation, { 'codex/thread_id': 'fixture-thread' });
  const invalid = await client.callTool({ name: 'observe_caller', arguments: { callerThreadId: 'spoofed' } });
  assert.equal(invalid.isError, true);
});
