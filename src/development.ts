// Preparation writes dedicated artifacts only; no subprocess, setup or authentication.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, unlinkSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { buildInstallationControl, identity, localPath, install, uninstall, hasMcpNamespace, type InstallSpec } from './install.js';
import { fileHash, readPlan } from './plan.js';
import { Id, ModelId } from './contracts.js';

type ToolName = 'codex' | 'node' | 'code';
export type EnvironmentInput = {
  implementationRoot: string; envRoot: string; authHome: string;
  codexExe: string; nodeExe: string; codeExe: string; extensionDirectory: string;
  // Explicit handoff identities; never replace these with the discovered hash.
  selectedTools?: Partial<Record<ToolName, { sha256: string; version: string | null }>>;
  settingsFile?: string; controlConfig?: string; sessionFiles?: string[];
  failures?: Array<{ kind: 'logon' | 'setup' | 'timeout'; errorCode?: number }>;
};
export type Diagnostic = {
  code: string; severity: 'info' | 'warning' | 'blocker'; message: string; nextAction: string | null;
};
export type EnvironmentReport = {
  tools: Array<{ name: string; path: string; version: string | null; sha256: string }>;
  diagnostics: Diagnostic[];
};

function checkedPath(file: string): string {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw new Error('invalid path');
  localPath(file);
  return existsSync(file) ? realpathSync(file) : path.resolve(file);
}
function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function metadataVersion(value: unknown): string | null {
  return typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) && value.length <= 80 ? value : null;
}
function read(file: string): string { return readFileSync(checkedPath(file), 'utf8'); }

export function inspectEnvironment(input: EnvironmentInput): EnvironmentReport {
  const report: EnvironmentReport = { tools: [], diagnostics: [] };
  const add = (code: string, severity: Diagnostic['severity'], message: string, nextAction: string | null = null) => {
    report.diagnostics.push({ code, severity, message, nextAction });
  };
  const roots: Partial<Record<'implementationRoot' | 'envRoot' | 'authHome' | 'extensionDirectory', string>> = {};
  for (const name of ['implementationRoot', 'envRoot', 'authHome', 'extensionDirectory'] as const) {
    try {
      roots[name] = checkedPath(input[name]);
      if (!existsSync(roots[name]!) || !statSync(roots[name]!).isDirectory()) {
        add(name + '_unavailable', name === 'envRoot' ? 'warning' : 'blocker', '指定された専用領域を確認できません。', '対象ディレクトリの存在と読取り権限を確認してください。');
      }
    } catch {
      add(name + '_invalid', 'blocker', '絶対パスまたは通常ディレクトリではありません。', 'reparse pointを避けた明示パスを指定してください。');
    }
  }
  const { implementationRoot, envRoot, authHome } = roots;
  if (envRoot && ((implementationRoot && (inside(envRoot, implementationRoot) || inside(implementationRoot, envRoot)))
    || (authHome && (inside(envRoot, authHome) || inside(authHome, envRoot))))) {
    add('environment_overlap', 'blocker', '環境領域が実装または認証領域と重なっています。', '互いに分離した専用領域を指定してください。');
  }
  for (const [name, file] of [['codex', input.codexExe], ['node', input.nodeExe], ['code', input.codeExe]] as const) {
    const selected = input.selectedTools?.[name];
    if (!selected || !/^[a-f0-9]{64}$/.test(selected.sha256)) {
      add(name + '_selection_missing', 'blocker', '選定済みの実行ファイルhashがありません。', '引継ぎ済みの対象とSHA-256を明示してください。');
    }
    try {
      const resolved = checkedPath(file), sha256 = fileHash(readFileSync(resolved));
      let version: string | null = null;
      if (selected && /^[a-f0-9]{64}$/.test(selected.sha256)) {
        try {
          identity(resolved, selected.sha256);
          // A version is handoff metadata bound to the verified bytes, not an executed probe.
          version = metadataVersion(selected.version);
        } catch {
          add(name + '_hash_mismatch', 'blocker', '選定済みhashと実体が一致しません。', '更新された版の適合確認を行ってください。hashだけを差し替えないでください。');
        }
      }
      if (name === 'node' && realpathSync(process.execPath) === resolved) version = process.version;
      report.tools.push({ name, path: resolved, sha256, version });
      if (!version) add(name + '_version_unknown', 'warning', '静的に版を確認できません。', '選定済みhashに対応する版の引継ぎ情報を確認してください。');
      if (name === 'node' && version) {
        const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
        if (major < 24 || (major === 24 && (minor < 22 || (minor === 22 && patch < 1)))) {
          add('node_version_unsupported', 'blocker', 'Node.js 24.22.1以上が必要です。', '確認済みのNode.jsを明示してください。');
        }
      }
    } catch {
      add(name + '_unavailable', 'blocker', '指定した実行ファイルを読み取れません。', '選定済みのパス・存在・読取り権限を確認してください。');
    }
  }
  // PATH is a comparison only. It never supplies a replacement executable.
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  const candidate = (process.env.PATH ?? '').split(path.delimiter).filter(p => path.isAbsolute(p))
    .flatMap(dir => names.map(name => path.join(dir, name))).find(file => existsSync(file));
  if (candidate) {
    try {
      if (checkedPath(candidate) !== checkedPath(input.codexExe)) {
        add('path_codex_differs', 'warning', 'PATH上のCodexと選定済み実体は別です。選定は変更していません。', '選定済みの明示パスを継続して使用してください。');
      }
    } catch { add('path_codex_unknown', 'warning', 'PATH上のCodex実体を確認できません。'); }
  }
  try {
    const file = path.join(roots.extensionDirectory!, 'package.json'), raw = read(file), pkg = JSON.parse(raw);
    const version = metadataVersion(pkg.version);
    if (pkg.publisher !== 'openai' || pkg.name !== 'chatgpt' || !version) throw new Error('invalid extension');
    report.tools.push({ name: 'codex_extension', path: checkedPath(file), version, sha256: fileHash(raw) });
  } catch {
    add('extension_invalid', 'blocker', '指定した公式Codex拡張のmetadataを確認できません。', '選定済み拡張ディレクトリを確認してください。');
  }
  if (authHome) {
    try {
      const auth = checkedPath(path.join(authHome, 'auth.json'));
      add(existsSync(auth) && statSync(auth).isFile() ? 'authentication_present' : 'authentication_missing', 'warning',
        '認証ファイルの存在だけを診断します。正式な認証の有効性は未確認です。', '必要なら別の明示操作で正式認証を確認してください。');
    } catch { add('authentication_unknown', 'warning', '認証ファイルの存在を確認できません。'); }
    try {
      const config = read(path.join(authHome, 'config.toml'));
      // Only recognize the simple, unambiguous selection emitted by the existing runner.
      let inWindows = false, tables = 0;
      const values: Array<string | undefined> = [];
      for (const line of config.split(/\r?\n/)) {
        if (line.trimStart().startsWith('[')) {
          inWindows = /^[ \t]*\[windows\][ \t]*(?:#.*)?$/.test(line);
          if (inWindows) tables++;
        } else if (inWindows && /^[ \t]*sandbox\s*=/.test(line)) {
          values.push(/^[ \t]*sandbox\s*=\s*["'](elevated|mxc)["'][ \t]*(?:#.*)?$/.exec(line)?.[1]);
        }
      }
      const ambiguous = /'''|"""|["'](?:windows|sandbox)["']|\bwindows\s*\.\s*sandbox\s*=/.test(config);
      const sandbox = !ambiguous && tables === 1 && values.length === 1 ? values[0] : undefined;
      add(sandbox ? 'sandbox_' + sandbox : 'sandbox_unknown', sandbox === 'elevated' ? 'info' : 'warning',
        sandbox === 'elevated' ? '設定上のsandboxはelevatedです。起動適合は未確認です。'
          : sandbox === 'mxc' ? '設定上のsandboxはMXCです。OS・ポリシー・管理領域deny・停止の適合は未確認です。'
            : '設定上のsandbox選択を静的に確認できません。', 'setupや切替は行わず、必要なprobeを別の明示操作で実施してください。');
    } catch { add('auth_config_unavailable', 'blocker', '専用認証領域の設定を読み取れません。', '参照先を確認してください。'); }
  }
  if (input.settingsFile) {
    try {
      const raw = read(input.settingsFile), parsed = ts.parseConfigFileTextToJson('settings.json', raw);
      if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) throw new Error('invalid settings');
      const selected = parsed.config['chatgpt.cliExecutable'];
      if (selected !== undefined && checkedPath(selected) !== checkedPath(input.codexExe)) {
        let relayMatches = false;
        try {
          const relay = checkedPath(selected);
          if (statSync(relay).isFile()) {
            const sidecar = JSON.parse(read(relay + '.json'));
            relayMatches = checkedPath(sidecar.realExecutable) === checkedPath(input.codexExe)
              && !!input.selectedTools?.codex && sidecar.realSha256 === input.selectedTools.codex.sha256;
          }
        } catch { /* A missing/changed sidecar must not authorize a relay. */ }
        if (relayMatches) {
          add('settings_relay_unverified', 'warning', 'relay設定の参照先は選定と一致します。relay本体の許可・receiptは未確認です。', '既存installerのreceiptとrelay本体のhashを照合してください。');
        } else {
          add('settings_binding_mismatch', 'blocker', 'VS Code設定の実行ファイル参照が選定と異なります。', '既存relayのreceiptまたは明示した参照を確認してください。');
        }
      }
    } catch { add('settings_invalid', 'blocker', 'VS Code設定の参照を確認できません。', '設定の形式・存在・参照先を確認してください。'); }
  } else { add('settings_not_supplied', 'warning', 'VS Code設定の参照先は未確認です。'); }
  if (input.controlConfig) {
    try {
      const config = JSON.parse(read(input.controlConfig));
      if (checkedPath(config.runtime.realExe) !== checkedPath(input.codexExe)
        || checkedPath(config.nodeExecutable) !== checkedPath(input.nodeExe)
        || checkedPath(config.runtime.authHome) !== authHome
        || config.runtime.realSha256 !== input.selectedTools?.codex?.sha256
        || config.nodeSha256 !== input.selectedTools?.node?.sha256) {
        add('control_binding_mismatch', 'blocker', 'control設定の実体・hash・認証領域が選定と異なります。', '既存runの所有者とreceiptを確認してください。');
      }
    } catch { add('control_config_invalid', 'blocker', 'control設定の参照を確認できません。'); }
  }
  for (const file of input.sessionFiles ?? []) {
    try {
      const session = JSON.parse(read(file)), pid = session.launchPid;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); add('run_process_present', 'warning', '記録されたPIDは存在します。所有者・起動identityは未確認です。', '対象runの正規status経路で照合し、無断停止しないでください。'); }
        catch { /* Absence or access denial alone cannot prove a stopped/restored run. */ }
      }
    } catch { add('run_session_unavailable', 'warning', '試験sessionを読み取れません。'); }
  }
  add('run_state_unknown', 'warning', 'プロセス終了・所有者・設定復元は静的診断だけでは確認できません。', '既存runの正規statusとreceiptを読取りで照合してください。');
  for (const failure of input.failures ?? []) {
    if (failure.kind === 'logon') add(failure.errorCode === 1909 ? 'logon_1909' : 'logon_failed', 'blocker', 'プロセスのログオン失敗が記録されています。', '自動再試行せず正規の権限経路を確認してください。アカウントやポリシーは変更しません。');
    else if (failure.kind === 'setup') add('setup_failed', 'blocker', 'sandbox setup失敗が記録されています。', '同条件のsetupを繰り返さず、対象と失敗事実を確認してください。');
    else if (failure.kind === 'timeout') add('operation_timeout', 'blocker', '操作のtimeoutが記録されています。結果は不明です。', '再送・fallback・再設定を行わず、終了状態を確認してください。');
  }
  return report;
}

export type DevelopmentEnvironment = {
  id: string; envRoot: string; authHome: string; profileDirectory: string; extensionsDirectory: string;
  input: EnvironmentInput; officialExtension: { version: string; sha256: string }; manifestHash: string;
};
export type CompletedBuild = { root: string; manifestHash: string };
export type BuildSnapshot = { id: string; root: string; manifestHash: string };
export type DevelopmentScenario = {
  kind: 'serial' | 'parallel'; planPath: string; repositoryPath: string; repositoryId: string;
  parentCwd: string; parentThreadId: string; branchScope: string[]; agent: { model: string; effort: string };
  approvedMaxTurns?: number; maxInstructions?: number;
};
export type DevelopmentRun = {
  id: string; environmentId: string; snapshot: BuildSnapshot; stateDirectory: string;
  sessionFile: string; controlConfig: string; installSpec: string; phase: 'prepared';
};
export type DevelopmentPhase = 'prepared' | 'running' | 'stopped' | 'restored' | 'unknown';
export type DevelopmentProcess = { pid: number; created: string; executable: string };
export type DevelopmentSession = DevelopmentRun & {
  profile: string; extensions: string; codeExe: string; authHome: string; cwd: string;
  parentThreadId: string; parentPipe: string; pipeName: string;
  controlHash: string; installHash: string;
};
// OS/process effects live in the explicit live runner, never in preparation or inspection.
export interface DevelopmentDriver {
  assertIdle(session: DevelopmentSession): Promise<void>;
  launch(session: DevelopmentSession): Promise<DevelopmentProcess>;
  status(session: DevelopmentSession, process: DevelopmentProcess): Promise<'running' | 'stopped' | 'unknown'>;
  stop(session: DevelopmentSession, process: DevelopmentProcess): Promise<'stopped' | 'unknown'>;
}
export type ChangeClass = 'logic' | 'extension' | 'runtime' | 'launch' | 'acceptance';
export type RefreshAction = 'tests_only' | 'reload_window' | 'restart_session' | 'fresh_acceptance';
export function selectRefresh(change: string): RefreshAction {
  if (change === 'logic') return 'tests_only';
  if (change === 'extension') return 'reload_window';
  if (change === 'acceptance') return 'fresh_acceptance';
  return 'restart_session';
}

// Host reload drops the management lease: close it through the owned stop path and
// open a fresh host. Neither a DB nor a model-turn allowance is inherited.
export async function refreshDevelopmentRun(environment: DevelopmentEnvironment, run: DevelopmentRun,
  options: { change: string; snapshot: BuildSnapshot; scenario: DevelopmentScenario }, driver: DevelopmentDriver) {
  const action = selectRefresh(options.change);
  if (action !== 'reload_window' && action !== 'restart_session') throw new Error('use tests or independent acceptance runner');
  verifyEnvironment(environment); verifySnapshot(environment, options.snapshot); sessionFor(environment, run);
  if (options.snapshot.id === run.snapshot.id) throw new Error('refresh requires a new snapshot');
  validateScenario(environment, options.scenario);
  ownedLifecycle(environment, run);
  const root = path.dirname(run.sessionFile);
  // Reserve before effects. Repeating an interrupted CLI never resends an unknown launch.
  saveNew(path.join(root, 'refresh.json'), { action, snapshot: options.snapshot, phase: 'reserved' });
  const stopped = await stopDevelopmentRun(environment, run, driver);
  if (stopped.phase !== 'stopped') return { action, phase: 'unknown' as const, run };
  await restoreDevelopmentRun(environment, run, driver);
  const next = prepareRun(environment, options.snapshot, options.scenario);
  // Persist the successor before any launch, including a failed/unknown delivery.
  saveNew(path.join(root, 'refresh-result.json'), { action, run: next });
  const started = await startDevelopmentRun(environment, next, driver);
  return { action, phase: started.phase, run: next };
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function saveNew(file: string, value: unknown) {
  const bytes = json(value);
  localPath(file); writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  identity(file, fileHash(bytes));
}
function disjoint(a: string, b: string) { return !inside(a, b) && !inside(b, a); }
function environmentData(environment: DevelopmentEnvironment) {
  const { manifestHash: _hash, ...data } = environment;
  return data;
}
function verifyEnvironment(environment: DevelopmentEnvironment) {
  const root = checkedPath(environment.envRoot);
  const raw = read(path.join(root, 'environment.json'));
  if (fileHash(raw) !== environment.manifestHash || raw !== json(environmentData(environment))) throw new Error('environment manifest changed');
  if (environment.profileDirectory !== path.join(root, 'profile') || environment.extensionsDirectory !== path.join(root, 'extensions')
    || environment.authHome !== environment.input.authHome || root !== environment.input.envRoot) throw new Error('environment binding mismatch');
  localPath(environment.profileDirectory); localPath(environment.extensionsDirectory);
  identity(checkedPath(path.join(environment.input.extensionDirectory, 'package.json')), environment.officialExtension.sha256);
  for (const [name, file] of [['codex', environment.input.codexExe], ['node', environment.input.nodeExe], ['code', environment.input.codeExe]] as const) {
    checkedPath(file); identity(file, environment.input.selectedTools?.[name]?.sha256 ?? '');
  }
}

export function prepareEnvironment(input: EnvironmentInput, report: EnvironmentReport): DevelopmentEnvironment {
  if ([...report.diagnostics, ...inspectEnvironment(input).diagnostics].some(d => d.severity === 'blocker')) throw new Error('environment has blockers');
  return preparation(checkedPath(input.envRoot), checkedPath(input.authHome), () => prepareEnvironmentUnlocked(input, report));
}
function prepareEnvironmentUnlocked(input: EnvironmentInput, report: EnvironmentReport): DevelopmentEnvironment {
  // Re-inspect, rather than trusting a stale report or silently accepting new tool bytes.
  const current = inspectEnvironment(input);
  if ([...report.diagnostics, ...current.diagnostics].some(d => d.severity === 'blocker')) throw new Error('environment has blockers');
  if (json(report.tools) !== json(current.tools)) throw new Error('inspection report changed or stale');
  const extension = current.tools.find(tool => tool.name === 'codex_extension')!;
  const envRoot = checkedPath(input.envRoot), authHome = checkedPath(input.authHome);
  // Persist only the explicit selections, never settings, logs, failure text or credentials.
  const selected: EnvironmentInput = {
    implementationRoot: checkedPath(input.implementationRoot), envRoot, authHome,
    codexExe: checkedPath(input.codexExe), nodeExe: checkedPath(input.nodeExe), codeExe: checkedPath(input.codeExe),
    extensionDirectory: checkedPath(input.extensionDirectory), selectedTools: Object.fromEntries(
      (['codex', 'node', 'code'] as const).map(name => [name, { sha256: input.selectedTools![name]!.sha256, version: metadataVersion(input.selectedTools![name]!.version) }]))
  };
  const manifest = path.join(envRoot, 'environment.json');
  if (existsSync(manifest)) {
    const raw = read(manifest), data = JSON.parse(raw);
    if (json(data.input) !== json(selected)) throw new Error('environment selection changed');
    const environment = { ...data, manifestHash: fileHash(raw) } as DevelopmentEnvironment;
    verifyEnvironment(environment); return environment;
  }
  const environment: DevelopmentEnvironment = { id: randomUUID(), envRoot, authHome,
    profileDirectory: path.join(envRoot, 'profile'), extensionsDirectory: path.join(envRoot, 'extensions'), input: selected,
    officialExtension: { version: extension.version!, sha256: extension.sha256 }, manifestHash: '' };
  mkdirSync(envRoot, { recursive: true });
  // Exclusive creation protects existing user files and concurrent initializers.
  mkdirSync(environment.profileDirectory); mkdirSync(path.join(environment.profileDirectory, 'User'));
  saveNew(path.join(environment.profileDirectory, 'User/settings.json'), { 'workbench.startupEditor': 'none', 'chatgpt.runCodexInWindowsSubsystemForLinux': false });
  mkdirSync(environment.extensionsDirectory); mkdirSync(path.join(envRoot, 'snapshots')); mkdirSync(path.join(envRoot, 'runs'));
  saveNew(manifest, environmentData(environment));
  environment.manifestHash = fileHash(readFileSync(manifest));
  return environment;
}

function snapshotId(id: string) {
  if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) throw new Error('invalid build ID');
  return id;
}
function relativeFile(root: string, relative: string) {
  if (!relative || /[\\:\x00-\x1f]/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('snapshot path rejected');
  const file = checkedPath(path.join(root, relative));
  if (!inside(file, root) || file === root) throw new Error('snapshot path escapes root');
  return file;
}
// Same fixed runtime layout as the installer/release package. Never walk authHome or all of .local/dist.
function buildFiles(root: string): Record<string, string> {
  root = checkedPath(root);
  const files: Record<string, string> = {};
  const add = (relative: string) => {
    const file = relativeFile(root, relative);
    if (!lstatSync(file).isFile()) throw new Error('regular build file required');
    files[relative] = fileHash(readFileSync(file));
  };
  const tree = (relative: string) => {
    const dir = relativeFile(root, relative);
    for (const name of readdirSync(dir).sort()) {
      const child = relative + '/' + name, file = relativeFile(root, child), item = lstatSync(file);
      if (item.isDirectory()) tree(child); else add(child);
    }
  };
  for (const file of ['package.json', 'package-lock.json', 'extension/package.json']) add(file);
  for (const dir of ['dist/src', 'extension/dist/src']) {
    for (const file of readdirSync(relativeFile(root, dir)).sort()) {
      relativeFile(root, dir + '/' + file); // Reject links even when the entry would not be copied.
      if (file.endsWith('.js')) add(dir + '/' + file);
    }
  }
  tree('migrations');
  for (const name of ['CodexRelay', 'CodexWorkerHost', 'MeristemControl']) add(`.local/chat-control-build/${name}.exe`);
  for (const required of ['dist/src/cli.js', 'dist/src/mcp.js', 'dist/src/install.js', 'extension/dist/src/extension.js', 'migrations/001-control.sql']) {
    if (!files[required]) throw new Error('incomplete build');
  }
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    const dependency = entry as { dev?: boolean; version?: string };
    if (!relative || (dependency.dev && relative !== 'node_modules/typescript')) continue;
    if (!relative.startsWith('node_modules/')) throw new Error('dependency path rejected');
    const pkg = JSON.parse(readFileSync(relativeFile(root, relative + '/package.json'), 'utf8'));
    if (!dependency.version || pkg.version !== dependency.version) throw new Error('dependency version drift');
    tree(relative);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

// Call only after successful, awaited npm build and build-native.ps1 (-OutputDirectory).
// The receipt pins those completed bytes; it does not run or infer success of a compiler.
export function recordBuildCompletion(buildRoot: string): CompletedBuild {
  const root = checkedPath(buildRoot), first = json(buildFiles(root));
  if (json(buildFiles(root)) !== first) throw new Error('build changed during completion');
  return { root, manifestHash: fileHash(first) };
}
export function snapshotBuild(environment: DevelopmentEnvironment, completed: CompletedBuild, id: string = randomUUID()): BuildSnapshot {
  verifyEnvironment(environment); snapshotId(id);
  const source = checkedPath(completed.root);
  if (![environment.envRoot, environment.authHome].every(root => disjoint(source, root))) throw new Error('build input must be separate from managed environment');
  const files = buildFiles(completed.root);
  if (fileHash(json(files)) !== completed.manifestHash) throw new Error('build changed since completion');
  const root = checkedPath(path.join(environment.envRoot, 'snapshots', id));
  // Reserve a never-reused ID. On failure, leave an uncommitted directory with no manifest.
  mkdirSync(root);
  for (const [relative, hash] of Object.entries(files)) {
    const source = relativeFile(completed.root, relative), target = relativeFile(root, relative);
    identity(source, hash); mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL); identity(target, hash);
  }
  if (json(buildFiles(completed.root)) !== json(files) || json(buildFiles(root)) !== json(files)) throw new Error('build changed during snapshot');
  verifyEnvironment(environment);
  const manifest = { version: 1, id, environmentId: environment.id, files };
  saveNew(path.join(root, 'snapshot.json'), manifest);
  return { id, root, manifestHash: fileHash(json(manifest)) };
}
function verifySnapshot(environment: DevelopmentEnvironment, snapshot: BuildSnapshot) {
  snapshotId(snapshot.id);
  const expected = checkedPath(path.join(environment.envRoot, 'snapshots', snapshot.id));
  if (snapshot.root !== expected) throw new Error('snapshot root mismatch');
  const raw = read(path.join(expected, 'snapshot.json')), manifest = JSON.parse(raw);
  if (fileHash(raw) !== snapshot.manifestHash || manifest.version !== 1 || manifest.id !== snapshot.id || manifest.environmentId !== environment.id) throw new Error('snapshot manifest changed');
  for (const [relative, hash] of Object.entries(manifest.files)) identity(relativeFile(expected, relative), hash as string);
  if (json(buildFiles(expected)) !== json(manifest.files)) throw new Error('snapshot changed');
}

export function prepareRun(environment: DevelopmentEnvironment, snapshot: BuildSnapshot, scenario: DevelopmentScenario): DevelopmentRun {
  verifyEnvironment(environment);
  return preparation(environment.envRoot, environment.authHome, () => prepareRunUnlocked(environment, snapshot, scenario));
}
function prepareRunUnlocked(environment: DevelopmentEnvironment, snapshot: BuildSnapshot, scenario: DevelopmentScenario): DevelopmentRun {
  verifyEnvironment(environment); verifySnapshot(environment, snapshot);
  const { plan, repository, cwd, approvedMaxTurns, maxInstructions } = validateScenario(environment, scenario);
  const id = randomUUID(), root = checkedPath(path.join(environment.envRoot, 'runs', id));
  mkdirSync(root);
  const stateDirectory = path.join(root, 'state'), controlConfig = path.join(root, 'control.json'), sessionFile = path.join(root, 'session.json'), installSpec = path.join(root, 'install.json');
  const pipeName = `meristem-cc01-control-${randomUUID()}`, parentPipe = `meristem-cc00-${randomUUID()}`;
  const planPath = path.join(root, 'plan.md'), bytes = readFileSync(plan.path);
  if (fileHash(bytes) !== plan.fileHash) throw new Error('plan changed concurrently');
  writeFileSync(planPath, bytes, { flag: 'wx' });
  const spec: InstallSpec = { implementationRoot: snapshot.root, realExe: environment.input.codexExe, nodeExe: environment.input.nodeExe,
    helperExtension: path.join(snapshot.root, 'extension'), settings: path.join(environment.profileDirectory, 'User/settings.json'),
    codexConfig: path.join(environment.authHome, 'config.toml'), controlConfig, installDirectory: path.join(root, 'installation'), parentCwd: cwd };
  const config = buildInstallationControl(spec, { runId: id, stateDirectory, pipeName,
    nodeSha256: environment.input.selectedTools!.node!.sha256, realSha256: environment.input.selectedTools!.codex!.sha256,
    wake: approvedMaxTurns > maxInstructions ? { ...scenario.agent, maxTurns: approvedMaxTurns - maxInstructions } : undefined,
    parentRelay: { pipeName: parentPipe, threadId: scenario.parentThreadId },
    scope: { fixture: true, plan: true, planPath, repositoryId: scenario.repositoryId, repositoryPath: repository,
      branchScope: [...scenario.branchScope], maxInstructions, assignments: [] } });
  saveNew(controlConfig, config); saveNew(installSpec, spec);
  const run: DevelopmentRun = { id, environmentId: environment.id, snapshot, stateDirectory, controlConfig, sessionFile, installSpec, phase: 'prepared' };
  // Recheck before committing the session. An interrupted/changed generation is never ready to start.
  verifyEnvironment(environment); verifySnapshot(environment, snapshot);
  if (fileHash(readFileSync(plan.path)) !== plan.fileHash) throw new Error('plan changed concurrently');
  identity(planPath, plan.fileHash);
  identity(controlConfig, fileHash(json(config))); identity(installSpec, fileHash(json(spec)));
  saveNew(sessionFile, { ...run, scenario: scenario.kind, cwd, parentThreadId: scenario.parentThreadId, pipeName, parentPipe,
    profile: environment.profileDirectory, extensions: environment.extensionsDirectory, codeExe: environment.input.codeExe,
    authHome: environment.authHome, planPath, planHash: plan.fileHash, turnsSent: 0, approvedMaxTurns,
    controlHash: fileHash(json(config)), installHash: fileHash(json(spec)) });
  return run;
}
function validateScenario(environment: DevelopmentEnvironment, scenario: DevelopmentScenario) {
  const approvedMaxTurns = scenario.approvedMaxTurns ?? 0, maxInstructions = scenario.maxInstructions ?? 0;
  if (![approvedMaxTurns, maxInstructions].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 20) || maxInstructions > approvedMaxTurns) throw new Error('explicit finite budget required');
  if (approvedMaxTurns - maxInstructions > 12) throw new Error('invalid wake budget');
  Id.parse(scenario.parentThreadId); Id.parse(scenario.repositoryId); ModelId.parse(scenario.agent.model); Id.parse(scenario.agent.effort);
  if (!['serial', 'parallel'].includes(scenario.kind)) throw new Error('unsupported scenario');
  const plan = readPlan(checkedPath(scenario.planPath)), repository = checkedPath(scenario.repositoryPath), cwd = checkedPath(scenario.parentCwd);
  if (plan.plan.schema_version !== 1 || checkedPath(plan.plan.run.repository) !== repository || !scenario.branchScope.includes(plan.plan.run.integration_branch)
    || plan.plan.run.max_parallel !== (scenario.kind === 'serial' ? 1 : 2)) throw new Error('scenario plan binding mismatch');
  for (const dir of [repository, cwd, checkedPath(plan.plan.run.worktrees_root)]) {
    if (![environment.envRoot, environment.authHome, environment.input.implementationRoot].every(root => disjoint(dir, root))) throw new Error('scenario must be separate from managed environment');
    if (!statSync(dir).isDirectory()) throw new Error('scenario directory required');
  }
  return { plan, repository, cwd, approvedMaxTurns, maxInstructions };
}

type EnvironmentLease = { token: string; environmentId: string; runId: string; sessionFile: string };
type Lifecycle = { phase: DevelopmentPhase; lease: EnvironmentLease; process?: DevelopmentProcess;
  launchAttempted: boolean; receipt?: string; receiptHash?: string; retained?: string[] };
const leaseFiles = (envRoot: string, authHome: string) => [path.join(authHome, '.meristem-development-lease.json'), path.join(envRoot, '.development-lease.json')];
function releaseFiles(files: string[], owner: unknown) {
  for (const file of [...files].reverse()) { identity(file, fileHash(json(owner))); unlinkSync(file); }
}
function acquireFiles(files: string[], owner: unknown) {
  const acquired: string[] = [];
  try { for (const file of files) { saveNew(file, owner); acquired.push(file); } }
  catch { releaseFiles(acquired, owner); throw new Error('development lease already held or unavailable'); }
}
// Legacy acceptance writes use the same auth reservation, without changing their lifecycle.
export function acquireDevelopmentAuthOperation(authHome: string): () => void {
  const files = [path.join(checkedPath(authHome), '.meristem-development-lease.json')];
  const owner = { token: randomUUID(), operation: 'acceptance_config' };
  acquireFiles(files, owner); return () => releaseFiles(files, owner);
}
function preparation<T>(envRoot: string, authHome: string, action: () => T): T {
  const owner = { token: randomUUID(), operation: 'prepare' }, files = leaseFiles(envRoot, authHome);
  // Reserve auth first, so a competing environment cannot touch shared configuration.
  localPath(envRoot); mkdirSync(envRoot, { recursive: true });
  acquireFiles(files, owner);
  try { return action(); } finally { releaseFiles(files, owner); }
}
function sessionFor(environment: DevelopmentEnvironment, run: DevelopmentRun): DevelopmentSession {
  const root = checkedPath(path.join(environment.envRoot, 'runs', Id.parse(run.id)));
  const expected = { environmentId: environment.id, sessionFile: path.join(root, 'session.json'),
    controlConfig: path.join(root, 'control.json'), installSpec: path.join(root, 'install.json'), stateDirectory: path.join(root, 'state') };
  for (const [key, value] of Object.entries(expected)) if (run[key as keyof DevelopmentRun] !== value) throw new Error('run binding changed');
  const session = JSON.parse(read(expected.sessionFile)) as DevelopmentSession;
  for (const [key, value] of Object.entries({ ...expected, id: run.id, profile: environment.profileDirectory,
    extensions: environment.extensionsDirectory, codeExe: environment.input.codeExe, authHome: environment.authHome })) {
    if (session[key as keyof DevelopmentSession] !== value) throw new Error('session binding changed');
  }
  if (json(session.snapshot) !== json(run.snapshot)) throw new Error('snapshot binding changed');
  identity(session.controlConfig, session.controlHash); identity(session.installSpec, session.installHash);
  const spec = JSON.parse(read(session.installSpec)) as InstallSpec, config = JSON.parse(read(session.controlConfig));
  if (spec.settings !== path.join(environment.profileDirectory, 'User/settings.json') || spec.codexConfig !== path.join(environment.authHome, 'config.toml')
    || spec.installDirectory !== path.join(root, 'installation') || spec.controlConfig !== session.controlConfig
    || spec.implementationRoot !== run.snapshot.root || spec.parentCwd !== session.cwd || config.runId !== run.id
    || config.stateDirectory !== run.stateDirectory || config.pipeName !== session.pipeName || config.mcp.parentRelay.pipeName !== session.parentPipe
    || config.mcp.parentRelay.threadId !== session.parentThreadId) throw new Error('run configuration binding changed');
  return session;
}
function lifecycleFile(run: DevelopmentRun) { return path.join(path.dirname(run.sessionFile), 'lifecycle.json'); }
function saveLifecycle(run: DevelopmentRun, before: string, value: Lifecycle) {
  const file = lifecycleFile(run), temp = file + '.' + randomUUID() + '.tmp'; localPath(file);
  identity(file, fileHash(before)); saveNew(temp, value);
  try { identity(file, fileHash(before)); renameSync(temp, file); } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function ownedLifecycle(environment: DevelopmentEnvironment, run: DevelopmentRun): Lifecycle {
  const state = JSON.parse(read(lifecycleFile(run))) as Lifecycle;
  if (state.lease.environmentId !== environment.id || state.lease.runId !== run.id || state.lease.sessionFile !== run.sessionFile) throw new Error('lease owner mismatch');
  for (const file of leaseFiles(environment.envRoot, environment.authHome)) identity(file, fileHash(json(state.lease)));
  return state;
}
function operation(environment: DevelopmentEnvironment, run: DevelopmentRun) {
  sessionFor(environment, run);
  const owner = { token: randomUUID(), runId: run.id }, files = [path.join(environment.envRoot, '.development-operation.json')];
  acquireFiles(files, owner); return () => releaseFiles(files, owner);
}
function verifyReceipt(environment: DevelopmentEnvironment, run: DevelopmentRun, state: Lifecycle) {
  const receipt = path.join(path.dirname(run.sessionFile), 'installation/installation.json');
  if (state.receipt !== receipt || !state.receiptHash) throw new Error('owned installation receipt unavailable');
  identity(receipt, state.receiptHash);
  const data = JSON.parse(read(receipt));
  if (data.settings !== path.join(environment.profileDirectory, 'User/settings.json') || data.codexConfig !== path.join(environment.authHome, 'config.toml')) throw new Error('receipt binding changed');
  const session = sessionFor(environment, run), config = JSON.parse(read(run.controlConfig));
  const directory = path.dirname(receipt), control = path.join(directory, 'control.json');
  const block = `\n[mcp_servers.meristem]\ncommand = ${JSON.stringify(environment.input.nodeExe)}\nargs = [${JSON.stringify(config.mcp.entryPoint)}, "--pipe", ${JSON.stringify(session.pipeName)}]\n`;
  if (data.installed !== JSON.stringify(path.join(directory, 'CodexRelay.exe')) || data.mcpBlock !== block
    || json(JSON.parse(read(control))) !== json(config) || data.artifacts?.[control] !== fileHash(read(control))) throw new Error('receipt run ownership mismatch');
}
export async function startDevelopmentRun(environment: DevelopmentEnvironment, run: DevelopmentRun, driver: DevelopmentDriver) {
  verifyEnvironment(environment); verifySnapshot(environment, run.snapshot);
  const session = sessionFor(environment, run), unlock = operation(environment, run);
  try {
    if (existsSync(lifecycleFile(run))) throw new Error('run already started; never retry unknown launch');
    if (existsSync(path.join(path.dirname(run.sessionFile), 'installation'))) throw new Error('preexisting installation is not owned by this start');
    const lease: EnvironmentLease = { token: randomUUID(), environmentId: environment.id, runId: run.id, sessionFile: run.sessionFile };
    acquireFiles(leaseFiles(environment.envRoot, environment.authHome), lease);
    const state: Lifecycle = { phase: 'prepared', lease, launchAttempted: false };
    // Persist ownership before any external effect. A crash leaves the lease for reconciliation.
    try {
      if (hasMcpNamespace(read(path.join(environment.authHome, 'config.toml')))) throw new Error('existing MCP namespace requires ownership review');
      saveNew(lifecycleFile(run), state);
    } catch (error) { releaseFiles(leaseFiles(environment.envRoot, environment.authHome), lease); throw error; }
    try {
      await driver.assertIdle(session);
      sessionFor(environment, run); verifyEnvironment(environment); verifySnapshot(environment, run.snapshot);
      const result = install(JSON.parse(read(run.installSpec)));
      state.receipt = result.receipt; state.receiptHash = fileHash(read(state.receipt));
      let before = read(lifecycleFile(run)); state.launchAttempted = true; state.phase = 'unknown'; saveLifecycle(run, before, state);
      state.process = await driver.launch(session);
      if (!Number.isSafeInteger(state.process.pid) || state.process.pid <= 0 || !state.process.created || state.process.executable !== session.codeExe) throw new Error('launch identity unavailable');
      before = read(lifecycleFile(run)); state.phase = await driver.status(session, state.process) === 'running' ? 'running' : 'unknown';
      saveLifecycle(run, before, state); return state;
    } catch {
      const before = read(lifecycleFile(run));
      const receipt = path.join(path.dirname(run.sessionFile), 'installation/installation.json');
      if (existsSync(receipt) && !state.receipt) {
        const candidate = { ...state, receipt, receiptHash: fileHash(read(receipt)) };
        try { verifyReceipt(environment, run, candidate); state.receipt = receipt; state.receiptHash = candidate.receiptHash; }
        catch { state.launchAttempted = true; } // Unknown/foreign receipt: retain the lease, never uninstall it.
      }
      state.phase = state.launchAttempted ? 'unknown' : 'stopped'; saveLifecycle(run, before, state);
      throw new Error('development start failed; ownership retained for stop/restore');
    }
  } finally { unlock(); }
}
export async function statusDevelopmentRun(environment: DevelopmentEnvironment, run: DevelopmentRun, driver: DevelopmentDriver) {
  const session = sessionFor(environment, run);
  if (!existsSync(lifecycleFile(run))) return { phase: 'prepared' as const, observed: 'not_started' as const };
  const recorded = JSON.parse(read(lifecycleFile(run))) as Lifecycle;
  if (recorded.phase === 'restored') return { phase: 'restored' as const, observed: 'stopped' as const };
  const state = ownedLifecycle(environment, run);
  if (state.phase === 'stopped') {
    try { await driver.assertIdle(session); return { phase: 'stopped' as const, observed: 'stopped' as const }; }
    catch { return { phase: 'unknown' as const, observed: 'unknown' as const }; }
  }
  let observed: 'running' | 'stopped' | 'unknown' = state.launchAttempted ? 'unknown' : 'stopped';
  if (state.process) { try { observed = await driver.status(session, state.process); } catch { /* Never infer stop from disconnection. */ } }
  return { phase: observed === 'running' && state.phase === 'running' ? 'running' : 'unknown', observed };
}
export async function stopDevelopmentRun(environment: DevelopmentEnvironment, run: DevelopmentRun, driver: DevelopmentDriver) {
  const session = sessionFor(environment, run), unlock = operation(environment, run);
  try {
    const state = ownedLifecycle(environment, run), before = read(lifecycleFile(run));
    if (state.phase === 'stopped') return { phase: 'stopped' as const };
    let stopped = !state.launchAttempted;
    if (state.process) { try { stopped = await driver.stop(session, state.process) === 'stopped'; } catch { stopped = false; } }
    state.phase = stopped ? 'stopped' : 'unknown'; saveLifecycle(run, before, state); return { phase: state.phase };
  } finally { unlock(); }
}
export async function restoreDevelopmentRun(environment: DevelopmentEnvironment, run: DevelopmentRun, driver: DevelopmentDriver) {
  const unlock = operation(environment, run);
  try {
    const previous = read(lifecycleFile(run)), saved = JSON.parse(previous) as Lifecycle;
    if (saved.phase === 'restored') {
      if (saved.lease.environmentId !== environment.id || saved.lease.runId !== run.id || saved.lease.sessionFile !== run.sessionFile) throw new Error('lease owner mismatch');
      for (const file of leaseFiles(environment.envRoot, environment.authHome)) {
        localPath(file);
        if (existsSync(file) && read(file) === json(saved.lease)) unlinkSync(file);
      }
      return { phase: 'restored' as const, retained: saved.retained ?? [] };
    }
    const state = ownedLifecycle(environment, run);
    if (state.phase !== 'stopped') throw new Error('stop unknown or not confirmed');
    await driver.assertIdle(sessionFor(environment, run));
    ownedLifecycle(environment, run);
    if (!state.receipt && existsSync(path.join(path.dirname(run.sessionFile), 'installation'))) {
      throw new Error('installation receipt ownership unknown; lease remains held');
    }
    if (state.receipt) {
      verifyReceipt(environment, run, state);
      try { state.retained = uninstall(state.receipt).retained; }
      finally { state.receiptHash = fileHash(read(state.receipt)); saveLifecycle(run, previous, state); }
    }
    // Installer preserves edited tables. They still reserve this authHome until resolved.
    if (hasMcpNamespace(read(path.join(environment.authHome, 'config.toml')))) throw new Error('edited MCP configuration retained; lease remains held');
    state.phase = 'restored'; saveLifecycle(run, read(lifecycleFile(run)), state);
    releaseFiles(leaseFiles(environment.envRoot, environment.authHome), state.lease);
    return { phase: state.phase, retained: state.retained ?? [] };
  } finally { unlock(); }
}
