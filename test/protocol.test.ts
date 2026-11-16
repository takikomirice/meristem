import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { test } from 'node:test';
import { Rpc, RpcTransportFailure, type RpcFailureReason } from '../src/protocol.js';

function fixture(onEvent: (message: any) => void = () => {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.resume();
  const rpc = new Rpc(child as unknown as ChildProcessWithoutNullStreams, onEvent);
  return { child, rpc };
}

test('RPC applies its limit per JSON frame across chunk boundaries', async t => {
  const events: unknown[] = [], { child, rpc } = fixture(message => events.push(message));
  t.after(() => rpc.close());
  const expected = { payload: 'x'.repeat(1024 * 1024 - 64) };
  const response = Buffer.from(JSON.stringify({ id: 1, result: expected }) + '\n');
  const event = { method: 'fixture/event', params: { payload: 'y'.repeat(256) } };
  const notification = Buffer.from(JSON.stringify(event) + '\n');
  assert(response.length < 1024 * 1024);
  assert(response.length + notification.length > 1024 * 1024);
  const reply = rpc.call('turn/start');
  child.stdout.write(response.subarray(0, response.length - 32));
  child.stdout.write(Buffer.concat([response.subarray(response.length - 32), notification]));
  assert.deepEqual(await reply, expected);
  assert.deepEqual(events, [event]);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(rpc.failureReason, undefined);
});

test('RPC preserves a response at the exact frame byte limit', async t => {
  const { child, rpc } = fixture(); t.after(() => rpc.close());
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ id: 1, result: '' }) + '\n');
  const expected = 'x'.repeat(1024 * 1024 - envelopeBytes);
  const frame = Buffer.from(JSON.stringify({ id: 1, result: expected }) + '\n');
  assert.equal(frame.length, 1024 * 1024);
  const reply = rpc.call('thread/read'); child.stdout.write(frame);
  assert.equal(await reply, expected); assert.equal(rpc.failureReason, undefined);
});

for (const [label, value, reason] of [
  ['malformed JSON', 'private-do-not-record\n', 'invalid_json'],
  ['oversized complete frame', JSON.stringify({ id: 1, result: 'x'.repeat(1024 * 1024) }) + '\n', 'frame_too_large'],
  ['oversized unterminated frame', 'x'.repeat(1024 * 1024 + 1), 'frame_too_large'],
] as const) test(`RPC rejects ${label} and retains the first failure`, async t => {
  const events: unknown[] = [], { child, rpc } = fixture(message => events.push(message)); t.after(() => rpc.close());
  const pending = rpc.call('turn/start');
  const rejected = assert.rejects(pending, error => error instanceof RpcTransportFailure && error.reason === reason && error.method === 'turn/start' && !error.message.includes('private-do-not-record'));
  const event = { method: 'fixture/event', params: {} };
  child.stdout.write(JSON.stringify(event) + '\n' + value);
  await rejected;
  assert.deepEqual(events, [event]);
  assert.equal(child.stdin.writableEnded, true);
  rpc.close(); child.emit('close', 125, null);
  assert.equal(rpc.failureReason, reason);
  await assert.rejects(rpc.call('thread/read'), /transport closed/);
});

for (const reason of ['process_closed', 'process_error', 'stdin_error', 'owner_closed'] as const satisfies readonly RpcFailureReason[]) {
  test(`RPC categorizes ${reason} without copying error text`, async t => {
    const { child, rpc } = fixture(); t.after(() => rpc.close());
    const rejected = assert.rejects(rpc.call('turn/start'), error => error instanceof RpcTransportFailure && error.reason === reason && !error.message.includes('private-do-not-record'));
    if (reason === 'process_closed') child.emit('close', 17, null);
    else if (reason === 'process_error') child.emit('error', new Error('private-do-not-record'));
    else if (reason === 'stdin_error') child.stdin.emit('error', new Error('private-do-not-record'));
    else rpc.close();
    await rejected; rpc.close();
    assert.equal(rpc.failureReason, reason);
  });
}

test('RPC rejects valid JSON values that are not object envelopes', async t => {
  for (const value of [null, [], 'private-do-not-record', 42, true]) {
    await t.test(JSON.stringify(value), async t => {
      const { child, rpc } = fixture(); t.after(() => rpc.close());
      const rejected = assert.rejects(rpc.call('turn/start', {}, 100), error => error instanceof RpcTransportFailure && error.reason === 'invalid_json');
      child.stdout.write(JSON.stringify(value) + '\n');
      await rejected;
      assert.equal(rpc.failureReason, 'invalid_json');
      assert.equal(child.stdin.writableEnded, true);
    });
  }
});

test('RPC stops processing a chunk when an event synchronously closes its owner', async t => {
  const events: string[] = [];
  const { child, rpc } = fixture(message => { events.push(message.method); rpc.close(); });
  t.after(() => rpc.close());
  const rejected = assert.rejects(rpc.call('turn/start'), error => error instanceof RpcTransportFailure && error.reason === 'owner_closed');
  child.stdout.write(JSON.stringify({ method: 'first' }) + '\n' + JSON.stringify({ method: 'must-not-dispatch' }) + '\n' + JSON.stringify({ id: 1, result: 'must-not-resolve' }) + '\n');
  await rejected;
  assert.deepEqual(events, ['first']);
  assert.equal(rpc.failureReason, 'owner_closed');
});
