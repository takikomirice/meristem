// Explicit real acceptance controls; no UI injection and no automatic model retry.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { relayRequest, pipeRequest } from '../../src/protocol.js';
import { removeFixtureMcp } from './cc02-restore.js';
import { uninstall } from '../../src/install.js';

const args = process.argv.slice(2), action = args[0];
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const sessionFile = arg('--session')!; assert(sessionFile && path.isAbsolute(sessionFile));
const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
const planStage = session.stage === 'CC-06' || session.stage === 'CC-07';
assert(['CC-02', 'CC-03', 'CC-04', 'CC-06', 'CC-07'].includes(session.stage) && Number.isSafeInteger(session.approvedMaxTurns) && session.approvedMaxTurns >= (planStage ? 12 : 5) && session.approvedMaxTurns <= (planStage ? 20 : 8) && path.resolve(sessionFile).startsWith(path.resolve('.local/chat-control', session.stage) + path.sep));
const parentMaxTurns = planStage ? session.approvedMaxTurns - 6 : session.stage === 'CC-03' ? 2 : session.approvedMaxTurns - 3; // Child starts are separately reserved by the fixture scope.
const save = () => writeFileSync(sessionFile, JSON.stringify(session, null, 2) + '\n');
if (action === 'launch' || action === 'relaunch') {
  assert(args.includes('--live'));
  if (action === 'launch') {
    assert(!session.launched);
    if (session.stage === 'CC-07') {
      assert(session.installationReceipt && readFileSync(session.authConfig, 'utf8').includes(session.mcpBlock), 'install the reviewed CC-07 configuration first');
    } else {
    const original = readFileSync(path.join(session.root, 'auth-config.original'), 'utf8'); assert.equal(readFileSync(session.authConfig, 'utf8'), original);
    writeFileSync(session.authConfig, readFileSync(path.join(session.root, 'auth-config.test'), 'utf8'));
    }
  } else {
    let alive = false; try { await relayRequest(session.parentPipe, 'relay/status'); alive = true; } catch {} assert(!alive, 'close dedicated window before relaunch');
    assert(readFileSync(session.authConfig, 'utf8').includes(session.mcpBlock));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: session.authHome, MERISTEM_CC02_PARENT_ID: session.parentThreadId, MERISTEM_CC02_DISCOVERY: path.join(session.stateDirectory, 'discovery.json') };
  if (session.stage === 'CC-03') env.MERISTEM_CC03_VIEW_LOG = path.join(session.root, 'parent-view.jsonl');
  for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|ELECTRON_RUN_AS_NODE|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key)) delete env[key];
  const code = spawn(session.codeExe, ['--user-data-dir', session.profile, '--extensions-dir', session.extensions, ...(session.stage === 'CC-07' ? [] : ['--extensionDevelopmentPath', path.resolve('extension')]), '--extensionDevelopmentPath', path.resolve('test/fixtures/parent-view-extension'), '--new-window', session.cwd], { env, windowsHide: false, stdio: 'ignore', detached: true }); code.unref();
  session.launched = true; session.launchPid = code.pid; session.phase = 'waiting_human_open_parent'; save();
  console.log(JSON.stringify({ phase: session.phase, parentTitle: session.stage + ' 専用の親 P（試験）', parentThreadId: session.parentThreadId, profile: session.profile }));
} else if (action === 'open-parent') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = spawn(session.codeExe, ['--user-data-dir', session.profile, '--reuse-window', '--file-uri', `openai-codex://route/local/${session.parentThreadId}`], { env, windowsHide: false, stdio: 'ignore', detached: true }); code.unref();
  console.log(JSON.stringify({ openedParent: session.parentThreadId }));
} else if (action === 'status') {
  let relay: any; try { relay = await relayRequest(session.parentPipe, 'relay/status'); } catch {}
  const discoveryFile = path.join(session.stateDirectory, 'discovery.json'); let control: any;
  if (existsSync(discoveryFile)) { const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8')); try { control = await pipeRequest(session.pipeName, { ...discovery, method: 'status' }); } catch {} }
  const dbFile = path.join(session.stateDirectory, 'control.sqlite'); let reports: unknown[] = [];
  if (existsSync(dbFile)) { const db = new DatabaseSync(dbFile, { readOnly: true }); try { reports = db.prepare('SELECT attempt_id,payload FROM reports').all().map(row => ({ attemptId: row.attempt_id, report: JSON.parse(row.payload as string) })); } finally { db.close(); } }
  const status = { parentLoaded: relay?.observedThreads?.includes(session.parentThreadId) ?? false, parentActive: relay?.activeTurns?.[session.parentThreadId] ?? null, control, reports };
  console.log(JSON.stringify(args.includes('--summary') ? { ...status, control: control ? { run: control.run, bindingState: control.binding?.state, attempts: control.attempts.map((row: any) => ({ worker: row.registration.worker, state: row.state, stop: row.stopResult?.state })) } : null } : status));
} else if (action === 'parent') {
  assert(args.includes('--live') && arg('--prompt'));
  const status = await relayRequest(session.parentPipe, 'relay/status');
  assert(status.observedThreads.includes(session.parentThreadId), 'human must open the prepared parent in the normal extension first');
  assert(!status.activeTurns[session.parentThreadId], 'parent must be idle');
  const discovery = JSON.parse(readFileSync(path.join(session.stateDirectory, 'discovery.json'), 'utf8'));
  const control = await pipeRequest(session.pipeName, { ...discovery, method: 'status' });
  assert(control.ok === true && (control.run as any)?.state === 'active', 'live active broker required before reserving a model turn');
  await relayRequest(session.parentPipe, 'relay/register', { threadId: session.parentThreadId, ownerEpoch: status.ownerEpoch });
  const catalog = await relayRequest(session.parentPipe, 'model/list'); assert(catalog.data.some((model: any) => model.model === session.agent.model && model.supportedReasoningEfforts.some((effort: any) => effort.reasoningEffort === session.agent.effort)));
  let reservation: string | undefined;
  for (let i = 1; i <= parentMaxTurns; i++) { const file = path.join(session.root, `parent-turn-${i}.json`); try { writeFileSync(file, JSON.stringify({ delivery: 'reserved_before_send' }), { flag: 'wx' }); reservation = file; break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
  assert(reservation, 'parent-turn budget exhausted; never retry an unknown turn');
  const result = await relayRequest(session.parentPipe, 'turn/start', { threadId: session.parentThreadId, input: [{ type: 'text', text: readFileSync(arg('--prompt')!, 'utf8') }], ...session.agent });
  assert(result.turn?.id); writeFileSync(reservation, JSON.stringify({ delivery: 'acked', turnId: result.turn.id }));
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const current = await relayRequest(session.parentPipe, 'relay/status');
    const completed = current.events.find((event: any) => event.method === 'turn/completed' && event.threadId === session.parentThreadId && event.turnId === result.turn.id);
    if (completed) { writeFileSync(reservation, JSON.stringify({ delivery: 'completed', turnId: result.turn.id, status: completed.status })); console.log(JSON.stringify({ turnId: result.turn.id, status: completed.status })); process.exit(completed.status === 'completed' ? 0 : 1); }
    await delay(500);
  }
  throw new Error('parent result unknown; reservation remains consumed');
} else if (action === 'reconcile') {
  const status = await relayRequest(session.parentPipe, 'relay/status'), results: unknown[] = [];
  for (let i = 1; i <= parentMaxTurns; i++) {
    const file = path.join(session.root, `parent-turn-${i}.json`); if (!existsSync(file)) continue;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    const completed = status.events.find((event: any) => event.method === 'turn/completed' && event.threadId === session.parentThreadId && event.turnId === record.turnId);
    if (completed) { record.delivery = 'completed'; record.status = completed.status; writeFileSync(file, JSON.stringify(record)); }
    results.push({ slot: i, ...record });
  }
  console.log(JSON.stringify(results));
} else if (action === 'cleanup') {
  assert(args.includes('--window-closed'), 'close the dedicated VS Code window first');
  let alive = false; try { await relayRequest(session.parentPipe, 'relay/status'); alive = true; } catch {} assert(!alive, 'parent still owns a live App Server');
  if (session.stage === 'CC-07') {
    assert(session.installationReceipt); const result = uninstall(session.installationReceipt);
    session.phase = 'restored'; save(); console.log(JSON.stringify({ ...result, parentDisconnected: true }));
  } else {
  const current = readFileSync(session.authConfig, 'utf8'); assert(current.includes(session.mcpBlock) || session.phase === 'restored', 'test MCP block changed; preserve user edits and restore manually');
  writeFileSync(session.authConfig, removeFixtureMcp(current, readFileSync(path.join(session.root, 'auth-config.original'), 'utf8')));
  const settingsFile = path.join(session.profile, 'User', 'settings.json'), settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  for (const [key, value] of Object.entries(session.settings)) if (settings[key] === value) delete settings[key];
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  session.phase = 'restored'; save(); console.log(JSON.stringify({ phase: session.phase, parentDisconnected: true, testMcpRemoved: true, profileSettingsRestored: true }));
  }
} else throw new Error('usage: launch|status|parent|cleanup --session <file>');
