import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { startCliTerminal } from './cli-terminal.js';
import { Actor } from './actors.js';
import { Id } from './contracts.js';
import { type CliRun, verifyCliArtifacts, verifyCliIsolation } from './cli-setup.js';
import { availablePipe, pipeRequest, relayRequest } from './protocol.js';

const maxFrame = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function validateCliMessage(data: Buffer, binary: boolean): string {
  if (binary || data.length > maxFrame) throw new Error('Codex TUI message exceeds the text frame limit');
  const text = decoder.decode(data);
  const message = JSON.parse(text);
  if (!message || typeof message !== 'object' || Array.isArray(message) || /[\r\n]/.test(text))
    throw new Error('Expected a single JSON-RPC object from Codex TUI');
  return text + '\n';
}

async function waitFor<T>(read: () => T | undefined, ended: () => boolean): Promise<T> {
  for (let i = 0; i < 300 && !ended(); i++) {
    const value = read();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error('公式 TUI または Meristem 制御ホストを接続できませんでした。');
}

async function leaseTerminal(discovery: Record<string, any>, terminal: { pid: number; created: string }) {
  const socket = await availablePipe(discovery.pipeName);
  try {
    socket.setTimeout(12000, () => socket.destroy(new Error('CLI lease timed out')));
    socket.write(JSON.stringify({ ...discovery, method: 'lease', sessionKind: 'cli', terminal }) + '\n');
    let reply = '';
    for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
      reply += chunk.toString('utf8');
      if (reply.length > 65536) break;
      if (reply.includes('\n')) {
        const result = JSON.parse(reply.slice(0, reply.indexOf('\n')));
        if (!result.ok) break;
        const id = Id.parse(result.leaseId);
        socket.setTimeout(0);
        return { socket, id, humanControlVerified: result.humanControlVerified === true };
      }
    }
    throw new Error('TUI のプロセスと通信先を照合できませんでした。');
  } catch (error) { socket.destroy(); throw error; }
}

async function waitForExit(child: ChildProcess, closed: Promise<void>) {
  if (child.exitCode === null && !child.signalCode) {
    await Promise.race([closed, delay(3000, undefined, { ref: false })]);
    if (child.exitCode === null && !child.signalCode) child.kill();
  }
  await closed;
}

export async function openCliSession(run: CliRun, resumeThreadId?: string) {
  verifyCliArtifacts(run);
  if (resumeThreadId !== undefined) Id.parse(resumeThreadId);
  const config = JSON.parse(readFileSync(run.configPath, 'utf8'));
  const parentPipe: string = config.mcp.parentRelay.pipeName;
  const previous = existsSync(run.discoveryPath) ? JSON.parse(readFileSync(run.discoveryPath, 'utf8')).ownerEpoch : undefined;
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + token);
  let transport: WebSocket | undefined, tui: ReturnType<typeof startCliTerminal> | undefined, relay: ChildProcess | undefined, lease: Socket | undefined;
  let relayClosed = Promise.resolve(), tuiClosed = Promise.resolve();
  let discovery: Record<string, any> | undefined;
  let ending = false, finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0, perMessageDeflate: false, maxPayload: maxFrame,
    verifyClient({ req }: { req: IncomingMessage }) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      return !ending && !transport && !req.headers.origin && req.url === '/' &&
        actual.length === expected.length && timingSafeEqual(actual, expected);
    }
  });
  const close = async () => {
    if (ending) return closed;
    ending = true;
    lease?.destroy();
    transport?.terminate();
    server.close();
    tui?.close();
    // Keep the broker alive while the native lease-loss handler stops its workers and saves evidence.
    if (lease && discovery && relay?.exitCode === null && !relay.signalCode) {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        try {
          let offset: number | null = 0, settled = true;
          do {
            const snapshot = await pipeRequest(discovery.pipeName, { ...discovery, method: 'status', attemptOffset: offset, registrationOnly: true }, 1500);
            const run = snapshot.run as { state: string };
            const rows = snapshot.attempts as { state: string; stopResult?: unknown }[];
            settled &&= run.state !== 'active' && rows.every(row => ['completed', 'stopped'].includes(row.state) || row.stopResult);
            offset = snapshot.nextAttemptOffset as number | null;
          } while (settled && offset !== null && Date.now() < until);
          if (settled && offset === null) break;
        } catch { break; }
        await delay(100);
      }
    }
    relay?.stdin?.end();
    await Promise.all([relay && waitForExit(relay, relayClosed), tui && waitForExit(tui.process, tuiClosed)]);
    finish();
  };
  server.on('error', () => { void close(); });
  server.on('connection', ws => {
    transport = ws;
    // Hold traffic until the native host proves that the exact TUI owns this TCP client.
    ws.pause();
    ws.on('error', () => { void close(); });
    ws.once('close', () => { void close(); });
  });
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback listener unavailable');
    const env = { ...process.env, CODEX_HOME: run.authHome };
    const upstream = spawn(run.relayExe, ['app-server'], { cwd: run.repository, env, windowsHide: true, stdio: 'pipe' });
    relay = upstream;
    relayClosed = new Promise<void>(resolve => upstream.once('close', () => resolve()));
    upstream.on('error', () => { void close(); });
    upstream.once('exit', () => { void close(); });
    upstream.stdin.on('error', () => { void close(); });
    upstream.stderr.resume();
    const current = await waitFor(() => {
      if (!existsSync(run.discoveryPath)) return undefined;
      let item;
      try { item = JSON.parse(readFileSync(run.discoveryPath, 'utf8')); } catch { return undefined; }
      return item.runId === run.runId && item.pipeName === config.pipeName && item.ownerEpoch !== previous ? item : undefined;
    }, () => ending);
    discovery = current;
    verifyCliIsolation(run);
    const args = ['--no-alt-screen', '--remote', `ws://127.0.0.1:${address.port}`, '--remote-auth-token-env', 'MERISTEM_TUI_TOKEN', '-C', run.repository];
    if (resumeThreadId !== undefined) args.push('resume', resumeThreadId);
    const terminal = startCliTerminal(config.cliTerminal.executable, run.realExe, args, run.repository, { ...env, MERISTEM_TUI_TOKEN: token });
    tui = terminal;
    tuiClosed = new Promise<void>(resolve => terminal.process.once('close', () => resolve()));
    terminal.process.on('error', () => { void close(); });
    terminal.process.once('exit', () => { void close(); });
    const [ws, identity] = await Promise.all([waitFor(() => transport, () => ending), terminal.identity]);
    const held = await leaseTerminal(current, identity);
    lease = held.socket;
    lease.on('error', () => { void close(); });
    lease.once('close', () => { void close(); });
    if (ending) { lease.destroy(); throw new Error('TUI disconnected during startup'); }
    ws.on('message', (raw, binary) => {
      try {
        const frame = validateCliMessage(raw as Buffer, binary);
        if (!upstream.stdin.write(frame)) {
          ws.pause();
          upstream.stdin.once('drain', () => ws.resume());
        }
      } catch { void close(); }
    });
    // Limit incomplete JSONL frames and wait for each WS write before reading the next chunk.
    void (async () => {
      let rest = Buffer.alloc(0);
      for await (const chunk of upstream.stdout) {
        rest = Buffer.concat([rest, chunk]);
        let end;
        while ((end = rest.indexOf(10)) !== -1) {
          if (end > maxFrame) throw new Error('App Server frame too large');
          const text = decoder.decode(rest.subarray(0, end));
          rest = rest.subarray(end + 1);
          await new Promise<void>((resolve, reject) => ws.send(text, error => error ? reject(error) : resolve()));
        }
        if (rest.length > maxFrame) throw new Error('App Server frame too large');
      }
    })().catch(() => { void close(); });
    ws.resume();
    return {
      closed, close, humanControlVerified: held.humanControlVerified,
      async parent(threadId: string) {
        const owner = await relayRequest(parentPipe, 'relay/status');
        if (!owner.managementEnabled || !owner.observedThreads.includes(threadId)) throw new Error('保存した親会話の再接続を確認できません。');
        return Actor.parse({ ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, threadId });
      },
      async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
        if (ending) throw new Error('CLI session closed');
        const result = await pipeRequest(current.pipeName, { ...params, ...current, method, leaseId: held.id }, method === 'usage' ? 45000 : 20000);
        if (result.error === 'human_cli_origin_unverified') throw new Error('開始元を確認できません。エクスプローラーから開いた対話型 PowerShell で meristem.ps1 を実行してください。');
        if (result.ok !== true) throw new Error('Meristem が操作を受け付けませんでした。対象と状態を再確認してください。');
        return result;
      }
    };
  } catch (error) { await close(); throw error; }
}
