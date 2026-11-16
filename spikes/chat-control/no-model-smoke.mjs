// Investigation fixture: isolated metadata calls only; never starts a model turn.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [executable, outputFile] = process.argv.slice(2);
assert(executable && outputFile, 'Usage: node no-model-smoke.mjs <codex.exe> <result.json>');
const root = path.resolve('.local/chat-control/2026-11-14/no-model-smoke');
const cwd = path.join(root, 'work');
const home = path.join(root, 'home');
mkdirSync(cwd, { recursive: true });
mkdirSync(home, { recursive: true });
const env = { ...process.env, CODEX_HOME: home };
for (const key of Object.keys(env)) {
  if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER|SECRET/i.test(key)) delete env[key];
}
const child = spawn(executable, ['app-server', '--disable', 'code_mode_host', '--disable', 'windows_sandbox_service'], {
  env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
const requests = [];
let sequence = 0;
let buffer = '';
let observedTurns = 0;
let stage = 'initialize';
const closed = new Promise(resolve => child.once('close', resolve));
const failPending = error => {
  for (const call of pending.values()) call.reject(error);
  pending.clear();
};
child.on('error', failPending);
child.on('close', () => failPending(new Error('App server closed')));
child.stdin.on('error', failPending);
child.stderr.resume(); // Do not retain potentially private upstream logs.
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const message = JSON.parse(line);
      if (message.method === 'turn/started') observedTurns++;
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        message.error ? call.reject(new Error('RPC rejected')) : call.resolve(message.result);
      }
    } catch (error) { failPending(error); }
  }
});
const timer = setTimeout(() => { failPending(new Error('Timeout')); child.kill(); }, 15_000);
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  requests.push(method);
  pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const result = { testId: 'isolated-metadata-only', capturedAt: new Date().toISOString(), evidence: 'real-app-server-without-model-generation' };
try {
  const initialized = await request('initialize', {
    clientInfo: { name: 'chat_control_investigation', version: '0.0.0' },
    capabilities: { experimentalApi: false },
  });
  result.server = initialized.userAgent;
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  stage = 'account/read';
  const account = await request('account/read', { refreshToken: false });
  assert.equal(account.account, null, 'Fixture must remain unauthenticated');
  result.auth = 'not-authenticated';
  stage = 'thread/start';
  const first = await request('thread/start', { cwd, ephemeral: true, sandbox: 'read-only' });
  const second = await request('thread/start', { cwd, ephemeral: true, sandbox: 'read-only' });
  assert.notEqual(first.thread.id, second.thread.id);
  for (const response of [first, second]) {
    assert.equal(response.thread.parentThreadId, null);
    assert.equal(path.resolve(response.cwd).toLowerCase(), cwd.toLowerCase());
    assert.equal(response.thread.turns.length, 0);
    assert.equal(response.thread.status.type, 'idle');
  }
  assert.equal(observedTurns, 0);
  Object.assign(result, {
    passed: true, distinctIds: true, rootThreads: true, cwdMatches: true,
    emptyHistories: true, ephemeral: true, observedStatuses: ['idle', 'idle'],
    requestedModel: null, reportedSettings: { model: first.model, reasoningEffort: first.reasoningEffort },
    limits: ['No inference or independent conversation-content test', 'No VS Code panel test', 'No account model availability test'],
  });
} catch {
  Object.assign(result, { passed: false, failedStage: stage });
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
  await closed;
  clearTimeout(timer);
  Object.assign(result, { requests, modelTurnsObserved: observedTurns, exitObserved: true });
  mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
