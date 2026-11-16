// Explicitly opted-in, disposable CC-00 fixtures. Never selects a chat by title/latest.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { connect } from './relay-client.mjs';

const argv = process.argv.slice(2);
function flag(key) { const i = argv.indexOf(key); return i < 0 ? undefined : argv[i + 1]; }
assert(argv.includes('--live') && flag('--case'), 'Requires --live --case <transport|prepare-ui|status|rpc|restore-ui>');
const caseName = flag('--case');
const fixtureBase = path.resolve('.local/chat-control/CC-00');
mkdirSync(fixtureBase, { recursive: true });
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function loadSession() {
  const file = path.resolve(flag('--session') ?? '');
  assert(file.startsWith(fixtureBase + path.sep) && path.basename(file) === 'session.json', 'Use this runner\'s disposable session.json');
  const session = JSON.parse(readFileSync(file, 'utf8'));
  assert(session.testId?.startsWith('CC-00-') && path.resolve(session.root) === path.dirname(file));
  return session;
}
function setup(kind) {
  const realExecutable = flag('--real-exe');
  assert(realExecutable && path.isAbsolute(realExecutable) && existsSync(realExecutable), 'Explicit --real-exe <installed extension codex.exe> required');
  const version = spawnSync(realExecutable, ['--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(version.status, 0, 'Real exe --version must succeed');
  const root = mkdtempSync(path.join(fixtureBase, '試験 space-'));
  const work = path.join(root, 'work'), otherCwd = path.join(root, '別の作業 space');
  for (const dir of [work, otherCwd]) mkdirSync(dir, { recursive: true });
  const exe = path.join(root, 'Codex 中継.exe');
  copyFileSync('.local/chat-control-build/CodexRelay.exe', exe);
  const config = { realExecutable, realSha256: sha(realExecutable), pipeName: 'meristem-cc00-' + randomUUID(),
    allowedCwds: [work, otherCwd], testProfile: 'CC-00-' + kind };
  save(exe + '.json', config);
  const session = { testId: 'CC-00-' + kind + '-' + randomUUID(), root, work, otherCwd, exe, ...config,
    relaySha256: sha(exe), realVersion: version.stdout.trim(), createdAt: new Date().toISOString() };
  save(path.join(root, 'session.json'), session);
  return session;
}
async function status(session) {
  const c = await connect(session.pipeName);
  try { return (await c.call('relay/status')).result; } finally { c.socket.end(); }
}
if (caseName === 'prepare-ui') {
  const session = setup('ui');
  const codeExe = flag('--code-exe');
  assert(codeExe && path.isAbsolute(codeExe) && existsSync(codeExe), 'Explicit --code-exe required');
  const profile = path.join(session.root, 'profile');
  mkdirSync(path.join(profile, 'User'), { recursive: true });
  const settings = { 'chatgpt.cliExecutable': session.exe, 'workbench.startupEditor': 'none',
    'window.title': 'CC-00 isolated — ${rootName}', 'security.workspace.trust.enabled': true };
  save(path.join(profile, 'User', 'settings.json'), settings);
  const projectConfig = path.join(session.work, '.codex'); mkdirSync(projectConfig);
  const toml = '[mcp_servers.cc00_caller]\ncommand = ' + JSON.stringify(process.execPath) + '\nargs = [' +
    JSON.stringify(path.resolve('spikes/chat-control/caller-probe.mjs')) + ']\n';
  writeFileSync(path.join(projectConfig, 'config.toml'), toml);
  writeFileSync(path.join(session.work, 'AGENTS.md'), '# CC-00 disposable fixture\nOnly perform the explicit CC-00 test instruction. Never edit settings, auth, or files outside this fixture.\n');
  const env = { ...process.env }; delete env.CODEX_THREAD_ID; delete env.CODEX_TURN_ID;
  // The VS Code-hosted command runner exports Electron's Node mode and IPC hooks.
  // A dedicated GUI instance must start through the ordinary Electron entry point.
  for (const key of Object.keys(env)) if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) delete env[key];
  const child = spawn(codeExe, ['--new-window', '--user-data-dir', profile, '--skip-welcome', '--skip-release-notes', session.work],
    { env, windowsHide: false, stdio: 'ignore', detached: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  Object.assign(session, { profile, codeExe, launchedPid: child.pid, originalSettings: {}, installedSettings: settings, settingsRestored: false });
  save(path.join(session.root, 'session.json'), session);
  console.log(JSON.stringify({ session: path.join(session.root, 'session.json'), launchedPid: child.pid, profile }));
  // Keep the tool's owned process session alive until the dedicated GUI exits.
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  console.log(JSON.stringify({ testWindowProcessExited: exit }));
} else if (caseName === 'status') {
  console.log(JSON.stringify(await status(loadSession()), null, 2));
} else if (caseName === 'rpc') {
  const session = loadSession();
  const request = JSON.parse(readFileSync(flag('--request'), 'utf8'));
  const c = await connect(session.pipeName);
  try {
    const result = await c.call(request.method, request.params);
    const file = path.join(session.root, 'last-rpc.json');
    // Private fixture output only. Public evidence must select correlation/settings facts.
    save(file, result); console.log(JSON.stringify({ saved: file, ok: !result.error, error: result.error ?? null }));
  } finally { c.socket.end(); }
} else if (caseName === 'restore-ui') {
  const session = loadSession(); assert(session.profile, 'UI session required');
  const settingsFile = path.join(session.profile, 'User', 'settings.json');
  const current = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const installed = session.installedSettings ?? { 'chatgpt.cliExecutable': session.exe, 'workbench.startupEditor': 'none',
    'window.title': 'CC-00 isolated — ${rootName}', 'security.workspace.trust.enabled': true };
  for (const [key, value] of Object.entries(installed)) {
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) continue; // preserve edits made during the test
    if (Object.hasOwn(session.originalSettings, key)) current[key] = session.originalSettings[key];
    else delete current[key];
  }
  save(settingsFile, current);
  session.settingsRestored = true; save(path.join(session.root, 'session.json'), session);
  console.log('Test profile settings restored. Close only this test window and verify owned process exit.');
} else if (caseName === 'transport') {
  const session = setup('transport');
  const home = path.join(session.root, 'home'); mkdirSync(home);
  const env = { ...process.env, CODEX_HOME: home };
  for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key)) delete env[key];
  const child = spawn(session.exe, ['app-server'], { env, cwd: session.work, windowsHide: true });
  const pending = new Map(); let sequence = 0, buffer = '', turns = 0, stderr = '';
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  const failPending = error => { for (const call of pending.values()) call.reject(error); pending.clear(); };
  child.on('error', failPending);
  child.on('close', () => failPending(Error('App Server closed before RPC reply')));
  child.stdin.on('error', failPending);
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-1024); });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      let m;
      try { m = JSON.parse(buffer.slice(0, end)); } catch { failPending(Error('Malformed upstream frame')); child.kill(); return; }
      buffer = buffer.slice(end + 1);
      if (m.method === 'turn/started') turns++;
      if (pending.has(m.id)) { const call = pending.get(m.id); pending.delete(m.id); call.resolve(m); }
    }
  });
  const uiCall = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timeoutMs = Number(flag('--timeout-ms') ?? 25000);
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 25000);
  const timeout = setTimeout(() => { failPending(Error('Transport probe timeout')); child.kill(); }, timeoutMs);
  const evidence = { testId: session.testId, capturedAt: new Date().toISOString(), node: process.version,
    realExecutable: session.realExecutable, realVersion: session.realVersion, realSha256: session.realSha256,
    relaySha256: session.relaySha256, kind: 'real Codex; simulated UI client; no model generation', uiVerified: false };
  let c;
  try {
    const init = await uiCall('initialize', { clientInfo: { name: 'cc00_transport_probe', version: '0.0.0' }, capabilities: { experimentalApi: false } });
    assert(init.result); child.stdin.write('{"method":"initialized"}\n');
    c = await connect(session.pipeName);
    const account = await c.call('account/read', { refreshToken: false }); assert.equal(account.result.account, null);
    const first = await c.call('thread/start', { cwd: session.work, ephemeral: true });
    const second = await c.call('thread/start', { cwd: session.otherCwd, ephemeral: true });
    assert(first.result && second.result); assert.notEqual(first.result.thread.id, second.result.thread.id);
    assert.equal(first.result.thread.parentThreadId, null); assert.equal(second.result.thread.parentThreadId, null);
    const observed = (await c.call('relay/status')).result;
    assert.equal(observed.registeredThreads.length, 2); assert.equal(observed.jobAssigned, true);
    Object.assign(evidence, { result: 'passed', account: 'unauthenticated', distinctRootIds: true,
      differentCwds: true, actualAcl: observed.pipeAcl, initializeCapabilities: observed.initializeCapabilities,
      serverVersion: observed.serverVersion, modelTurnsObserved: turns,
      limitations: ['No VS Code UI', 'No inference, settings effectiveness, interruption, or caller metadata verified', 'No other-user login token available for access-denial trial'] });
  } catch (e) { evidence.result = 'failed'; evidence.reason = e.message; process.exitCode = 1; }
  finally {
    c?.socket.destroy(); child.stdin.end(); const exit = await closed; clearTimeout(timeout);
    evidence.exitCode = exit; evidence.exitObserved = true;
    const file = path.resolve(flag('--evidence') ?? 'docs/validation/chat-control/CC-00.transport.evidence.json'); save(file, evidence);
    console.log(JSON.stringify(evidence, null, 2));
  }
} else throw Error('Unknown live case');
