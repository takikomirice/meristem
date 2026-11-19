import assert from 'node:assert/strict';
import { test } from 'node:test';

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareCliRun } from '../src/cli-setup.js';
import { openCliSession, validateCliMessage } from '../src/cli-session.js';
import { serialFixture } from './fixtures/serial-git.js';

test('the TUI bridge forwards one JSON-RPC object per WebSocket message', () => {
  assert.equal(validateCliMessage(Buffer.from('{"method":"initialized"}'), false), '{"method":"initialized"}\n');
  for (const value of ['{}\n{"method":"turn/start"}','null','[]','{}\r\n{}']) {
    assert.throws(() => validateCliMessage(Buffer.from(value), false));
  }
  assert.throws(() => validateCliMessage(Buffer.from('{}'), true));
});

function cliFixture() {
  const f = serialFixture();
  f.plan.schema_version = 2;
  for (const task of f.plan.tasks) Object.assign(task.agent, { permissionProfileId: 'workspace' });
  f.savePlan();
  const realExe = path.join(f.root, 'MockInteractiveCodex.exe'), authHome = path.join(f.root, 'home');
  copyFileSync(path.resolve('.local/chat-control-build/MockCodex.exe'), realExe);
  mkdirSync(authHome);
  const setup = () => prepareCliRun(f.repository, f.planPath, { realExe, authHome, registryRoot: path.join(f.root, 'appdata/Meristem/cli') });
  return { f, setup, authHome };
}

test('an automated CLI launcher cannot approve, and closing one of two TUIs fences only its own repository run', { timeout: 100000 }, async t => {
  const { setup, authHome } = cliFixture();
  const first = setup(), other = setup();
  const a = await openCliSession(first); t.after(() => a.close());
  async function parent(session: typeof a, threadId: string) {
    for (let i=0; i<50; i++) {
      try { return await session.parent(threadId); } catch { await delay(100); }
    }
    throw new Error('fixture owner did not observe its conversation');
  }
  async function marker(exclude?: string) {
    for (let i=0; i<50; i++) {
      const found = readdirSync(authHome).find(name => /^TUI-\d+$/.test(name) && name !== exclude);
      if (found) return found;
      await delay(50);
    }
    throw new Error('fixture TUI did not connect');
  }
  const threadId = await marker();
  const actor = await parent(a, threadId);
  assert.equal(a.humanControlVerified, false);
  await assert.rejects(a.request('preview_parent_start', { parent: actor }), /開始元を確認できません/);
  await assert.rejects(a.request('start_parent', { parent: actor }), /開始元を確認できません/);
  await assert.rejects(a.request('stop'), /開始元を確認できません/);
  await assert.rejects(openCliSession(first), /接続できません/);
  const b = await openCliSession(other); t.after(() => b.close());
  const otherId = await marker(threadId);
  await parent(b, otherId);
  await assert.rejects(b.parent(threadId));
  writeFileSync(path.join(authHome,threadId+'.interrupt'),'');
  await delay(200);
  assert.equal((await b.request('status')).run.state, 'active');
  process.kill(Number(readFileSync(path.join(authHome,threadId),'utf8')));
  await a.closed;
  assert.equal((await b.request('status')).run.state, 'active');
  const restored = await openCliSession(first, threadId); t.after(() => restored.close());
  const intended = await parent(restored, threadId);
  assert.notEqual(intended.ownerEpoch, actor.ownerEpoch);
  await assert.rejects(restored.request('resume_parent', { parent: intended }), /開始元を確認できません/);
  writeFileSync(path.join(authHome, threadId+'.exit'),'');
  await restored.closed;
  assert(existsSync(first.discoveryPath));
});
