// Explicit, no-inference CC-02 preflight. Model/UI acceptance is a separate gate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerRuntime } from '../../src/workers.js';

const arg = (name: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const realExe = arg('--real-exe')!, authHome = arg('--auth-home')!, evidence = arg('--evidence')!;
if (![realExe, authHome, evidence].every(p => p && path.isAbsolute(p)) || existsSync(evidence)) throw new Error('explicit live paths and unused evidence required');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const root = mkdtempSync(path.join(tmpdir(), 'cc02-preflight-')), stateDirectory = path.join(root, 'state'), cwd = mkdtempSync(path.join(tmpdir(), 'cc02-preflight-work-'));
const hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe'), controlExe = path.resolve('.local/chat-control-build/MeristemControl.exe'), mockExe = path.resolve('.local/chat-control-build/MockCodex.exe'), entryPoint = path.resolve('dist/src/cli.js'), mcpEntry = path.resolve('dist/src/mcp.js'), configPath = path.join(root, 'config.json'), pipeName = `meristem-cc01-control-${randomUUID()}`;
const git = (args: string[]) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0); return result.stdout.trim(); };
git(['init', '-b', 'cc02-preflight']); writeFileSync(path.join(cwd, 'isolation-visible'), 'preserve existing file'); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
writeFileSync(configPath, JSON.stringify({ stateDirectory, repository: process.cwd(), runId: 'preflight', pipeName, nodeExecutable: process.execPath, nodeSha256: sha(process.execPath), entryPoint, entrySha256: sha(entryPoint), runtime: { hostExe, hostSha256: sha(hostExe), realExe: mockExe, realSha256: sha(mockExe), authHome, fixture: true }, assignments: [] }));
const host = spawn(controlExe, ['--config', configPath], { windowsHide: true, stdio: 'pipe' }); host.stdout.resume(); host.stderr.resume();
const record: Record<string, unknown> = { stage: 'CC-02', case: 'no_inference_preflight', capturedAt: new Date().toISOString(), turnsSent: 0, result: 'not_run', node: { path: process.execPath, version: process.version, sha256: sha(process.execPath) }, codex: { path: realExe, sha256: sha(realExe), version: spawnSync(realExe, ['--version'], { windowsHide: true, encoding: 'utf8' }).stdout.trim() }, artifactHashes: { host: sha(hostExe), control: sha(controlExe), mcp: sha(mcpEntry), entry: sha(entryPoint) } };
let runtime: WorkerRuntime | undefined, worker: Awaited<ReturnType<WorkerRuntime['start']>> | undefined;
try {
  for (let i = 0; i < 150 && !existsSync(path.join(stateDirectory, 'discovery.json')); i++) await delay(50);
  assert(existsSync(path.join(stateDirectory, 'discovery.json')));
  runtime = new WorkerRuntime({ stateDirectory, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome, fixture: false, mcp: { pipeName, entryPoint: mcpEntry, entrySha256: sha(mcpEntry) } });
  worker = await runtime.start({ workerId: 'preflight', cwd, model: 'gpt-6-luna', effort: 'low' });
  record.realRootAndManagedProfile = true; record.realMcpToolCatalog = true;
  assert.equal(git(['status', '--porcelain', '--untracked-files=all']), ''); assert.equal(readFileSync(path.join(cwd, 'isolation-visible'), 'utf8'), 'preserve existing file'); record.isolationLeavesWorktreeClean = true;
  const stopped = await runtime.stop(worker, 'preflight'); assert.equal(stopped.state, 'stopped'); record.realWorkerStop = stopped.state; record.result = 'passed';
} catch (error) { record.reason = error instanceof Error ? error.message : 'unavailable'; process.exitCode = 1; }
finally {
  if (runtime && worker) await runtime.stop(worker, 'cleanup');
  host.stdin.end(); for (let i = 0; i < 100 && host.exitCode === null && host.signalCode === null; i++) await delay(50);
  record.hostAbsent = host.exitCode !== null || host.signalCode !== null;
  if (!record.hostAbsent) { host.kill(); record.result = 'failed'; process.exitCode = 1; }
  record.realParentWorkerTurns = 'not_run'; record.realVscodeTerminal = 'not_run';
  writeFileSync(evidence, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: record.result, turnsSent: 0, hostAbsent: record.hostAbsent, reason: record.reason }));
}
