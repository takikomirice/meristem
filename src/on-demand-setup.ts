import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliRepository } from './cli-setup.js';
import { localPath } from './install.js';
import { eligibleTasks, fileHash, readPlan, type TaskState } from './plan.js';
import type { RuntimeConfig } from './workers.js';

export const inspectAgent = { model: 'gpt-6-luna', effort: 'low' };

function contains(root: string, target: string) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

export function resolveOnDemandFile(relativeFile: string, cwd = process.cwd()) {
  if (!relativeFile || path.isAbsolute(relativeFile) || /[:\x00-\x1f]/.test(relativeFile)
    || relativeFile.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git'
      || (part !== '.' && /[. ]$/.test(part)))) throw new Error('invalid_file');
  const repository = cliRepository(cwd);
  const target = path.resolve(repository, relativeFile);
  localPath(target);
  const absolute = realpathSync.native(target);
  const file = path.relative(repository, absolute).split(path.sep).join('/');
  if (!contains(repository, absolute) || file.split('/').some(part => part.toLowerCase() === '.git')
    || !statSync(absolute).isFile()) throw new Error('invalid_file');
  return { repository, absolute, file };
}

// VS Code retains old extension directories after updates. Use its installation
// registry to select the installed version rather than guessing from directory order.
export function sidebarExecutable(extensions: string) {
  const registry = path.join(extensions, 'extensions.json');
  localPath(registry);
  const records = JSON.parse(readFileSync(registry, 'utf8'));
  const matches = Array.isArray(records) ? records.filter(row => row?.identifier?.id === 'openai.chatgpt') : [];
  if (matches.length !== 1) throw new Error('official_extension_unavailable');
  const { version, relativeLocation } = matches[0];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)
    || relativeLocation !== 'openai.chatgpt-' + version + '-win32-x64') throw new Error('official_extension_unavailable');
  const folder = path.join(extensions, relativeLocation), manifest = path.join(folder, 'package.json');
  localPath(manifest);
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.publisher?.toLowerCase() !== 'openai' || pkg.name !== 'chatgpt' || pkg.version !== version) throw new Error('official_extension_unavailable');
  const exe = path.join(folder, 'bin/windows-x86_64/codex.exe');
  localPath(exe);
  return realpathSync.native(exe);
}

export function onDemandRuntime(repository: string, stateDirectory: string): RuntimeConfig {
  const home = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  if (!path.isAbsolute(home)) throw new Error('invalid_auth_home');
  localPath(home);
  const authHome = realpathSync.native(home);
  const extensions = path.join(homedir(), '.vscode/extensions');
  if ([authHome, extensions, stateDirectory].some(dir => contains(repository, dir) || contains(dir, repository))) {
    throw new Error('runtime_overlaps_repository');
  }
  const realExe = sidebarExecutable(extensions);
  const hostExe = fileURLToPath(new URL('../../.local/chat-control-build/CodexWorkerHost.exe', import.meta.url));
  localPath(hostExe);
  return { hostExe, hostSha256: fileHash(readFileSync(hostExe)), realExe, realSha256: fileHash(readFileSync(realExe)),
    authHome, stateDirectory, fixture: false, managedProfile: true };
}

// Editing stays gated until the ordinary sidebar can attest the human-approved scope.
// This read-only preview shares the broker's eligibility rules and has no run to resume.
export function previewOnDemandPlan(relativeFile: string) {
  const { repository, file, absolute } = resolveOnDemandFile(relativeFile);
  const snapshot = readPlan(absolute), { run, tasks, schema_version } = snapshot.plan;
  if (schema_version !== 2 || path.relative(repository, run.repository) !== '') throw new Error('invalid_plan');
  const states: Record<string, TaskState> = Object.create(null), initialTasks: string[] = [];
  for (;;) {
    const [next] = eligibleTasks(snapshot, states);
    if (!next) break;
    initialTasks.push(next);
    states[next] = { state: 'assigned' };
  }
  return { status: 'sidebar_authorization_unverified', file, planHash: snapshot.planHash, branch: run.integration_branch,
    worktrees: run.worktrees_root, requestedMaxParallel: run.max_parallel, initialTasks,
    tasks: tasks.map(task => ({ id: task.id, scope: task.scope, dependsOn: task.depends_on, agent: task.agent })) };
}
