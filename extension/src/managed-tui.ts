import type * as vscode from 'vscode';
import type WebSocket from 'ws';
import { spawn, execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type { ManagedSession } from './managed-client';
import type { IncomingMessage } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

type Target = { runId: string; pipeName: string; repository: string; file: string; relay: string; configPath: string; realExe: string; authHome: string };
const limit = 8 * 1024 * 1024;
const runTool = promisify(execFile);

// The extension host owns the relay and the listening endpoint. No Codex or VS Code
// settings are patched. The native lease checks both process identities and TCP owners.
export async function openManagedTerminal(api: typeof vscode, context: vscode.ExtensionContext, repository: string, plan: string,
  attach: (target: Target & { terminalPid: number }) => Promise<ManagedSession>) {
  const official = api.extensions.getExtension('openai.chatgpt');
  if (process.platform !== 'win32' || !official) throw new Error('Windows x64 用の公式 Codex 拡張を導入してください。');
  const codexPath = path.join(official.extensionPath, 'bin/windows-x86_64/codex.exe');
  const runtime = context.asAbsolutePath('runtime'), node = path.join(runtime, 'node/node.exe'), setup = path.join(runtime, 'dist/src/ide-setup.js');
  if (!existsSync(node) || !existsSync(codexPath)) throw new Error('同梱の Node または公式 Codex の実行ファイルを確認できません。');
  const realExe = realpathSync.native(codexPath);
  const environment = { ...process.env };
  const filtered: Record<string, null> = {};
  for (const key of Object.keys(environment)) {
    if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|^OPENAI_|^CODEX_(THREAD_ID|TURN_ID|API_|BASE_URL)|^NODE_(OPTIONS|PATH)$/i.test(key)) {
      delete environment[key];
      filtered[key] = null;
    }
  }
  const helper = async (args: string[]) => {
    try { return (await runTool(node, [setup, ...args], { env: environment, windowsHide: true, timeout: 120000, maxBuffer: 65536 })).stdout; }
    catch (error) { throw new Error(String((error as { stderr?: string }).stderr ?? '').trim().slice(0, 500) || '実行環境の準備に失敗しました。'); }
  };
  const target: Target = JSON.parse(await helper(['prepare', context.globalStorageUri.fsPath, repository, plan, realExe]));
  const token = randomBytes(32).toString('hex'), bearer = Buffer.from('Bearer ' + token);
  const { WebSocketServer } = require(path.join(runtime, 'node_modules/ws')) as typeof import('ws');
  let socket: WebSocket | undefined, terminal: vscode.Terminal | undefined, closed = false;
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0, perMessageDeflate: false, maxPayload: limit,
    verifyClient({ req }: { req: IncomingMessage }) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      return !closed && !socket && !req.headers.origin && req.url === '/' && actual.length === bearer.length && timingSafeEqual(actual, bearer);
    }
  });
  const relay = spawn(target.relay, ['app-server'], { cwd: repository, env: { ...environment, CODEX_HOME: target.authHome }, windowsHide: true, stdio: 'pipe' });
  let session: ManagedSession | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    closing.dispose();
    const finish = () => {
      session?.dispose();
      socket?.terminate();
      server.close();
      terminal?.dispose();
      relay.stdin.end();
      const deadline = setTimeout(() => { if (relay.exitCode === null && !relay.signalCode) relay.kill(); }, 3000);
      deadline.unref();
    };
    if (session && !session.closed && session.runState !== 'stopped') void session.stopRun().then(finish, finish);
    else finish();
  };
  const closing = api.window.onDidCloseTerminal(t => { if (t === terminal) cleanup(); });
  context.subscriptions.push({ dispose: cleanup });
  relay.on('error', cleanup); relay.once('exit', cleanup); relay.stdin.on('error', cleanup); relay.stderr.resume();
  server.on('error', cleanup);
  server.on('connection', ws => {
    if (socket || closed) { ws.terminate(); return; }
    socket = ws; ws.pause(); ws.on('error', cleanup); ws.once('close', cleanup);
  });
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('公式 Codex の接続先を準備できません。');
    for (let i = 0; !closed && !existsSync(target.file) && i < 300; i++) await delay(100);
    if (closed || !existsSync(target.file)) throw new Error('制御プログラムを開始できません。');
    await helper(['isolation', target.configPath]);
    if (!api.workspace.isTrusted || !api.workspace.workspaceFolders?.some(f => f.uri.scheme === 'file' && f.uri.fsPath === repository)) throw new Error('対象フォルダーが変わりました。');
    terminal = api.window.createTerminal({
      name: 'Meristem 親チャット', shellPath: target.realExe, cwd: repository,
      shellArgs: ['--no-alt-screen', '--remote', `ws://127.0.0.1:${address.port}`, '--remote-auth-token-env', 'MERISTEM_TUI_TOKEN', '-C', repository],
      env: { ...filtered, CODEX_HOME: target.authHome, MERISTEM_TUI_TOKEN: token }, isTransient: true
    });
    terminal.show();
    const terminalPid = await terminal.processId;
    for (let i = 0; !socket && !closed && i < 300; i++) await delay(100);
    if (!socket || !terminalPid || closed) throw new Error('公式 Codex ターミナルの接続を確認できません。');
    const ws: WebSocket = socket;
    session = await attach({ ...target, terminalPid });
    if (closed) { session.dispose(); throw new Error('親チャットが閉じられました。'); }
    ws.on('message', (raw, binary) => {
      try {
        if (binary || !Buffer.isBuffer(raw) || raw.length > limit) throw new Error();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw), message = JSON.parse(text);
        if (!message || typeof message !== 'object' || Array.isArray(message) || /[\r\n]/.test(text)) throw new Error();
        if (!relay.stdin.write(text + '\n')) { ws.pause(); relay.stdin.once('drain', () => ws.resume()); }
      } catch { cleanup(); }
    });
    void (async () => {
      let rest = Buffer.alloc(0);
      for await (const chunk of relay.stdout) {
        rest = Buffer.concat([rest, chunk]);
        let end;
        while ((end = rest.indexOf(10)) !== -1) {
          if (end > limit) throw new Error();
          const line = new TextDecoder('utf-8', { fatal: true }).decode(rest.subarray(0, end));
          rest = rest.subarray(end + 1);
          await new Promise<void>((resolve, reject) => ws.send(line, error => error ? reject(error) : resolve()));
        }
        if (rest.length > limit) throw new Error();
      }
    })().catch(cleanup);
    ws.resume();
    return { dispose: cleanup };
  } catch (error) { cleanup(); throw error; }
}
