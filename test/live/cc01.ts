// Explicit non-model Windows acceptance. No turn/start, login, or permission bypass.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyIsolation, WorkerRuntime } from '../../src/workers.js';
import { pipeRequest } from '../../src/protocol.js';

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const realExe = arg('--real-exe'), authHome = arg('--auth-home'), evidence = arg('--evidence');
if (![realExe, authHome, evidence].every(p => p && path.isAbsolute(p)) || existsSync(evidence)) throw new Error('explicit unused evidence and absolute live paths required');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const base = mkdtempSync(path.join(tmpdir(), 'cc01-live-')), stateDirectory = path.join(base, 'state');
const cwd = mkdtempSync(path.join(tmpdir(), 'cc01-live-work-'));
const hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe'), controlExe = path.resolve('.local/chat-control-build/MeristemControl.exe');
const mockExe = path.resolve('.local/chat-control-build/MockCodex.exe'), entryPoint = path.resolve('dist/src/cli.js');
const configPath = path.join(base, 'config.json');
writeFileSync(configPath, JSON.stringify({ stateDirectory, repository: process.cwd(), runId: 'live', pipeName: `meristem-cc01-control-${randomUUID()}`, nodeExecutable: process.execPath, nodeSha256: sha(process.execPath), entryPoint, entrySha256: sha(entryPoint), runtime: { stateDirectory, hostExe, hostSha256: sha(hostExe), realExe: mockExe, realSha256: sha(mockExe), authHome, fixture: true }, assignments: [] }));
const host = spawn(controlExe, ['--config', configPath], { windowsHide: true, stdio: 'pipe' }); host.stdout.resume(); host.stderr.resume();
const record: Record<string, unknown> = { stage: 'CC-01', capturedAt: new Date().toISOString(), turnsSent: 0, result: 'not_run', node: { path: process.execPath, version: process.version, sha256: sha(process.execPath) }, codex: { path: realExe, sha256: sha(realExe), version: spawnSync(realExe, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim() }, artifactHashes: { host: sha(hostExe), control: sha(controlExe), entry: sha(entryPoint) }, fixtureState: stateDirectory, fixtureWork: cwd };
try {
  for (let i = 0; i < 150 && !existsSync(path.join(stateDirectory, 'discovery.json')); i++) await delay(50);
  if (!existsSync(path.join(stateDirectory, 'discovery.json'))) throw new Error('native protected management root unavailable');
  record.child_cannot_read_control_state = verifyIsolation({ stateDirectory, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome, fixture: false }, cwd);
  const runtime = new WorkerRuntime({ stateDirectory, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome, fixture: false });
  const worker = await runtime.start({ workerId: 'preflight', cwd, model: 'gpt-6-luna', effort: 'low' });
  record.realWorkerRootAndProfile = true;
  const stopped = await runtime.stop(worker, 'preflight'); record.realWorkerStop = stopped.state;
  if (stopped.state !== 'stopped') throw new Error('real worker termination unconfirmed');
  const discovery = JSON.parse(readFileSync(path.join(stateDirectory, 'discovery.json'), 'utf8'));
  const status = await pipeRequest(discovery.pipeName, { ...discovery, method: 'status' });
  record.nativeGatewayStatus = status.ok;
  record.result = 'passed';
} catch (error) { record.result = 'not_run'; record.reason = error instanceof Error ? error.message : 'unavailable'; process.exitCode = 1; }
finally {
  host.stdin.end(); for (let i = 0; i < 100 && host.exitCode === null && host.signalCode === null; i++) await delay(50);
  record.hostAbsent = host.exitCode !== null || host.signalCode !== null;
  if (!record.hostAbsent) { host.kill(); record.result = 'failed'; process.exitCode = 1; }
  writeFileSync(evidence, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: record.result, turnsSent: 0, hostAbsent: record.hostAbsent, reason: record.reason }));
}
