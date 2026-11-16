import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import { fileHash, readPlan } from './plan.js';
import { Id } from './contracts.js';

const absolute = z.string().refine(p => path.isAbsolute(p) && !/[\x00-\x1f]/.test(p));
const Spec = z.object({ implementationRoot: absolute, realExe: absolute, nodeExe: absolute, helperExtension: absolute, settings: absolute, sourceSettings: absolute.optional(), codexConfig: absolute, controlConfig: absolute, installDirectory: absolute, parentCwd: absolute }).strict();
const key = 'chatgpt.cliExecutable';
function hasMcpNamespace(text: string): boolean {
  // Conservative declaration check: do not parse/rewrite unrelated TOML values.
  // Unicode escapes in quoted keys can spell the same namespace.
  return text.split(/\r?\n/).some(line => {
    const declaration = (line.trimStart().startsWith('[') ? line : line.slice(0, Math.max(0, line.indexOf('='))))
      .replace(/\\(?:u([a-f0-9]{4})|U([a-f0-9]{8}))/gi, (_all, short, long) => String.fromCodePoint(parseInt(short ?? long, 16)));
    return /^[ \t]*\[\s*["']?mcp_servers["']?\s*\.\s*["']?meristem["']?\s*[.\]]/i.test(declaration)
      || /^[ \t]*["']?mcp_servers["']?\s*[.]?/i.test(declaration)
      || /^[ \t]*\[\s*["']?mcp_servers["']?\s*\]/i.test(declaration);
  });
}
type Manifest = { version: 1; state: 'prepared' | 'installed' | 'restored'; settings: string; previous?: string; installed: string; codexConfig: string; mcpBlock: string; artifacts: Record<string, string>; versions: { node: string; codex: string }; retained?: string[] };
function localPath(file: string) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('reparse path rejected');
    if (path.dirname(current) === current) break;
  }
}
function jsonc(text: string) {
  const parsed = ts.parseConfigFileTextToJson('settings.json', text);
  const source = ts.parseJsonText('settings.json', text), expression = (source.statements[0] as ts.ExpressionStatement)?.expression;
  if (parsed.error || !expression || !ts.isObjectLiteralExpression(expression)) throw new Error('settings must be a JSONC object');
  const properties = expression.properties;
  const names = properties.map(p => p.name && ts.isStringLiteral(p.name) ? p.name.text : '');
  if (names.some(n => !n) || new Set(names).size !== names.length) throw new Error('duplicate or invalid settings key');
  const property = properties.find(p => p.name && ts.isStringLiteral(p.name) && p.name.text === key) as ts.PropertyAssignment | undefined;
  return { source, expression, property };
}
function setting(text: string): string | undefined {
  const { source, property } = jsonc(text); return property?.initializer.getText(source);
}
function editSetting(text: string, value?: string): string {
  const { source, expression, property } = jsonc(text);
  if (property) {
    if (value !== undefined) return text.slice(0, property.initializer.getStart(source)) + value + text.slice(property.initializer.end);
    // Installed missing keys are inserted first; remove only that property and its comma.
    const start = property.getStart(source), end = property.end;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
    scanner.setTextPos(end);
    if (scanner.scan() === ts.SyntaxKind.CommaToken) return text.slice(0, start) + text.slice(end, scanner.getTokenPos()) + text.slice(scanner.getTextPos());
    scanner.setTextPos(expression.getStart(source) + 1);
    let comma = -1;
    while (scanner.getTextPos() < start && scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
      if (scanner.getTokenPos() >= start) break;
      comma = scanner.getToken() === ts.SyntaxKind.CommaToken ? scanner.getTokenPos() : -1;
    }
    return (comma >= 0 ? text.slice(0, comma) + text.slice(comma + 1, start) : text.slice(0, start)) + text.slice(end);
  }
  if (value === undefined) return text;
  const start = expression.getStart(source) + 1;
  return text.slice(0, start) + `\n  ${JSON.stringify(key)}: ${value}${expression.properties.length ? ',' : ''}` + text.slice(start);
}
function replace(file: string, before: string, after: string) {
  localPath(file);
  if (readFileSync(file, 'utf8') !== before) throw new Error('configuration changed concurrently');
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, after, { flag: 'wx' });
  try {
    if (readFileSync(file, 'utf8') !== before) throw new Error('configuration changed concurrently');
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function identity(file: string, expected: string) {
  if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expected ?? '') || fileHash(readFileSync(file)) !== expected) throw new Error('artifact identity mismatch');
}
function version(executable: string) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('executable version unavailable');
  return result.stdout.trim();
}
export function install(input: unknown) {
  const s = Spec.parse(input);
  [s.settings, s.codexConfig, s.installDirectory].forEach(localPath);
  const config = JSON.parse(readFileSync(s.controlConfig, 'utf8'));
  const runtime = config.runtime, mcp = config.mcp;
  if (!mcp?.scope?.plan || !mcp.parentRelay?.threadId || config.assignments?.length || mcp.scope.assignments?.length) throw new Error('explicit plan and parent binding required');
  Id.parse(config.runId); Id.parse(mcp.parentRelay.threadId);
  if (!/^meristem-cc01-control-[a-zA-Z0-9-]{1,90}$/.test(config.pipeName) || !/^meristem-cc00-[a-zA-Z0-9-]{1,90}$/.test(mcp.parentRelay.pipeName)) throw new Error('invalid pipe binding');
  const plan = readPlan(mcp.scope.planPath);
  if (realpathSync(plan.plan.run.repository) !== realpathSync(config.repository) || realpathSync(config.repository) !== realpathSync(mcp.scope.repositoryPath) || !mcp.scope.branchScope.includes(plan.plan.run.integration_branch)) throw new Error('plan repository or branch mismatch');
  const inside = (dir: string, root: string) => { const r = path.relative(root, dir); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
  if (!path.isAbsolute(config.stateDirectory) || [config.repository, s.implementationRoot, plan.plan.run.worktrees_root].some(root => inside(s.installDirectory, root) || inside(config.stateDirectory, root)) || inside(s.installDirectory, config.stateDirectory) || inside(config.stateDirectory, s.installDirectory)) throw new Error('installation and run state require separate directories outside repositories and worktrees');
  localPath(config.stateDirectory);
  if (runtime.fixture || realpathSync(runtime.realExe) !== realpathSync(s.realExe) || realpathSync(config.nodeExecutable) !== realpathSync(s.nodeExe) || realpathSync(s.nodeExe) !== realpathSync(process.execPath) || realpathSync(runtime.authHome) !== realpathSync(path.dirname(s.codexConfig))) throw new Error('runtime binding mismatch');
  const root = s.implementationRoot, build = path.join(root, '.local/chat-control-build');
  if (realpathSync(config.entryPoint) !== realpathSync(path.join(root, 'dist/src/cli.js')) || realpathSync(mcp.entryPoint) !== realpathSync(path.join(root, 'dist/src/mcp.js')) || realpathSync(runtime.hostExe) !== realpathSync(path.join(build, 'CodexWorkerHost.exe'))) throw new Error('implementation root mismatch');
  for (const [file, sha] of [[runtime.realExe, runtime.realSha256], [runtime.hostExe, runtime.hostSha256], [config.nodeExecutable, config.nodeSha256], [config.entryPoint, config.entrySha256], [mcp.entryPoint, mcp.entrySha256]]) identity(file, sha);
  const nodeVersion = version(s.nodeExe), codexVersion = version(s.realExe);
  const numbers = /^v(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion)?.slice(1).map(Number);
  if (!numbers || numbers[0] < 24 || (numbers[0] === 24 && (numbers[1] < 22 || (numbers[1] === 22 && numbers[2] < 1)))) throw new Error('Node 24.22.1 or newer required');
  const helper = JSON.parse(readFileSync(path.join(s.helperExtension, 'package.json'), 'utf8'));
  if (helper.name !== 'meristem-chat-control-fixture' || helper.publisher !== 'meristem-local' || helper.main !== './dist/src/extension.js' || !existsSync(path.join(s.helperExtension, helper.main))) throw new Error('built helper extension required');
  if (existsSync(s.installDirectory)) throw new Error('installation directory must be new; preserve previous receipt');
  if (s.sourceSettings && existsSync(s.settings)) throw new Error('profile clone target already exists');
  const before = s.sourceSettings ? readFileSync(s.sourceSettings, 'utf8') : readFileSync(s.settings, 'utf8');
  const previous = setting(before), auth = readFileSync(s.codexConfig, 'utf8');
  if (hasMcpNamespace(auth)) throw new Error('existing, dotted or inline MCP namespace requires manual review');
  if (auth.includes('\u0000')) throw new Error('invalid Codex configuration');
  const relay = path.join(s.installDirectory, 'CodexRelay.exe');
  const mcpBlock = `\n[mcp_servers.meristem]\ncommand = ${JSON.stringify(s.nodeExe)}\nargs = [${JSON.stringify(mcp.entryPoint)}, "--pipe", ${JSON.stringify(config.pipeName)}]\n`;
  const receipt = path.join(s.installDirectory, 'installation.json');
  const manifest: Manifest = { version: 1, state: 'prepared', settings: s.settings, previous, installed: JSON.stringify(relay), codexConfig: s.codexConfig, mcpBlock, artifacts: {}, versions: { node: nodeVersion, codex: codexVersion } };
  mkdirSync(s.installDirectory);
  const control = path.join(s.installDirectory, 'control.json');
  writeFileSync(control, JSON.stringify(config, null, 2)); copyFileSync(path.join(build, 'CodexRelay.exe'), relay);
  const controlExe = path.join(build, 'MeristemControl.exe');
  writeFileSync(relay + '.json', JSON.stringify({ realExecutable: s.realExe, realSha256: runtime.realSha256, pipeName: mcp.parentRelay.pipeName, allowedCwds: [realpathSync(s.parentCwd)], testProfile: 'CC-00R-managed', controlHost: { executable: controlExe, sha256: fileHash(readFileSync(controlExe)), configPath: control, configSha256: fileHash(readFileSync(control)), parentThreadId: mcp.parentRelay.threadId } }, null, 2));
  for (const file of [s.realExe, s.nodeExe, relay, relay + '.json', control, controlExe, runtime.hostExe, config.entryPoint, mcp.entryPoint, path.join(s.helperExtension, helper.main)]) manifest.artifacts[file] = fileHash(readFileSync(file));
  writeFileSync(receipt, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  if (s.sourceSettings) { mkdirSync(path.dirname(s.settings), { recursive: true }); writeFileSync(s.settings, before, { flag: 'wx' }); }
  try {
    const settings = editSetting(before, manifest.installed); jsonc(settings);
    replace(s.settings, before, settings);
    replace(s.codexConfig, auth, auth + mcpBlock);
    manifest.state = 'installed'; writeFileSync(receipt, JSON.stringify(manifest, null, 2));
  } catch (error) { uninstall(receipt); throw error; }
  return { state: 'installed', receipt, versions: manifest.versions, automaticStart: false };
}
export function uninstall(receipt: string) {
  localPath(receipt);
  const m = JSON.parse(readFileSync(receipt, 'utf8')) as Manifest;
  if (m.version !== 1 || !path.isAbsolute(m.settings) || !path.isAbsolute(m.codexConfig) || !m.mcpBlock.startsWith('\n[mcp_servers.meristem]\n')) throw new Error('invalid installation receipt');
  const retained: string[] = [];
  if (existsSync(m.settings)) {
    const current = readFileSync(m.settings, 'utf8');
    if (setting(current) === m.installed) { const restored = editSetting(current, m.previous); jsonc(restored); replace(m.settings, current, restored); }
    else retained.push('settings: user value retained');
  }
  const auth = readFileSync(m.codexConfig, 'utf8'), start = auth.indexOf(m.mcpBlock);
  const suffix = start < 0 ? '' : auth.slice(start + m.mcpBlock.length);
  // An appended key still belongs to our table. Preserve the whole changed table.
  const nextTable = /^[ \t]*\[/m.exec(suffix), tableTail = nextTable ? suffix.slice(0, nextTable.index) : suffix;
  if (start >= 0 && auth.indexOf(m.mcpBlock, start + 1) < 0 && !tableTail.trim() && !hasMcpNamespace(suffix)) replace(m.codexConfig, auth, auth.slice(0, start) + suffix);
  else if (m.state !== 'restored') retained.push('MCP: user value retained or installation not applied');
  m.state = 'restored'; m.retained = retained; writeFileSync(receipt, JSON.stringify(m, null, 2));
  return { state: m.state, retained, artifactsPreserved: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(process.argv[2] === 'install' ? install(JSON.parse(readFileSync(process.argv[3], 'utf8'))) : process.argv[2] === 'uninstall' ? uninstall(process.argv[3]) : (() => { throw new Error('install or uninstall required'); })())); }
  catch (e) { console.error(e instanceof Error ? e.message : 'installation failed'); process.exitCode = 1; }
}
