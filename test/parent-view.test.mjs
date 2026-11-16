import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('dedicated parent observer distinguishes visible, hidden and closed without recording other tabs', async () => {
  const records = [], listeners = [], subscriptions = [];
  const parent = { input: { uri: { toString: () => 'openai-codex://route/local/parent-1' } }, isActive: true };
  const other = { input: { uri: { toString: () => 'file:///private.txt' } }, isActive: false };
  const group = { tabs: [parent, other] };
  const vscode = { commands: { executeCommand: async () => {} }, Uri: { parse: value => value }, window: {
    tabGroups: { all: [group], onDidChangeTabs: fn => { listeners.push(fn); return { dispose() {} }; }, onDidChangeTabGroups: () => ({ dispose() {} }) },
    onDidChangeWindowState: () => ({ dispose() {} }), state: { focused: true },
  } };
  const context = { exports: {}, process: { env: { MERISTEM_CC02_PARENT_ID: 'parent-1', MERISTEM_CC03_VIEW_LOG: 'observation.jsonl' } }, require: name => name === 'vscode' ? vscode : { appendFileSync: (_file, line) => records.push(JSON.parse(line)) } };
  vm.runInNewContext(readFileSync(new URL('./fixtures/parent-view-extension/index.cjs', import.meta.url), 'utf8'), context);
  await context.exports.activate({ subscriptions });
  parent.isActive = false; other.isActive = true; listeners.forEach(fn => fn());
  group.tabs = [other]; listeners.forEach(fn => fn());
  assert.deepEqual(records.map(row => row.state), ['visible', 'hidden', 'closed']);
  assert(records.every(row => row.threadId === 'parent-1' && typeof row.at === 'string'));
  assert(!JSON.stringify(records).includes('private'));
});
