import { connect, type Socket } from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { failureKind, protocolReason, RequestFailure } from './failures.js';
let slot = 0;
export async function relayRequest(pipeName: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  if (!/^meristem-cc00-[a-zA-Z0-9-]{1,100}$/.test(pipeName)) throw new Error('invalid parent relay pipe');
  let socket: Socket | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      socket = await new Promise<Socket>((resolve, reject) => {
        const candidate = connect(`\\\\.\\pipe\\${pipeName}`);
        const fail = () => { candidate.destroy(); reject(new Error('parent connection unavailable')); };
        candidate.setTimeout(1000, fail); candidate.once('error', fail);
        candidate.once('connect', () => { candidate.removeListener('error', fail); candidate.setTimeout(0); resolve(candidate); });
      });
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  if (!socket) throw new Error('parent connection unavailable');
  const connected = socket;
  return new Promise((resolve, reject) => {
    const socket = connected; let buffer = Buffer.alloc(0), settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new Error('parent proof unavailable')); } socket.destroy(); };
    socket.setTimeout(method === 'turn/start' || method === 'relay/wake' ? 20000 : 5000, fail); socket.on('error', fail); socket.once('end', fail); socket.once('close', fail);
    socket.write(JSON.stringify({ id: 'cc02-proof', method, params }) + '\n');
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 262144) return fail();
      const end = buffer.indexOf(10); if (end < 0 || settled) return;
      try { const reply = JSON.parse(buffer.subarray(0, end).toString('utf8')); if (reply.error || reply.id !== 'cc02-proof') return fail(); settled = true; resolve(reply.result); socket.destroy(); } catch { fail(); }
    });
  });
}
async function availablePipe(pipeName: string): Promise<Socket> {
  // Retry only connection establishment. Once a request is written its result may be unknown.
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(`\\\\.\\pipe\\${pipeName}-${slot++ % 16}`);
        const failed = (error: Error) => { socket.destroy(); reject(error); };
        socket.once('error', failed); socket.setTimeout(1000, () => failed(new Error('connect timeout')));
        socket.once('connect', () => { socket.removeListener('error', failed); socket.setTimeout(0); resolve(socket); });
      });
    } catch { /* another bounded client may own this slot */ }
  }
  throw new Error('control connection unavailable');
}
export async function pipeRequest(pipeName: string, request: Record<string, unknown>, timeout = 10000): Promise<Record<string, unknown>> {
  if (!/^meristem-cc01-(worker|control)-[a-zA-Z0-9-]{1,90}$/.test(pipeName)) throw new Error('invalid control pipe');
  const frame = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(frame) > 65536) throw new Error('request too large');
  const socket = await availablePipe(pipeName);
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), settled = false;
    const fail = (error?: Error) => { if (!settled) { settled = true; reject(new Error(`control response unavailable (${String(request.method)}: ${(error as NodeJS.ErrnoException)?.code ?? 'closed'})`)); } socket.destroy(); };
    socket.setTimeout(timeout, fail); socket.once('error', fail); socket.once('end', fail); socket.once('close', fail);
    socket.on('data', chunk => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 262144) return fail();
      const end = buffer.indexOf(10); if (end < 0) return;
      try { const result = JSON.parse(buffer.subarray(0, end).toString('utf8')); settled = true; resolve(result); socket.destroy(); }
      catch { fail(); }
    });
    socket.write(frame);
  });
}
// Bounded RPC frames. Only a correlated human request may use respond().
export type RpcFailureReason = 'frame_too_large' | 'invalid_json' | 'process_closed' | 'process_error' | 'stdin_error' | 'owner_closed';
export class RpcTransportFailure extends Error {
  constructor(readonly reason: RpcFailureReason, readonly method: string) { super(`${method}: delivery unknown (${reason})`); }
}
export class Rpc {
  private sequence = 0;
  private closed = false;
  private firstFailure?: RpcFailureReason;
  get failureReason(): RpcFailureReason | undefined { return this.firstFailure; }
  private pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private child: ChildProcessWithoutNullStreams, onEvent: (message: any) => void) {
    let buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        // Include the newline in each frame's existing 1 MiB bound. A single
        // chunk may finish one valid frame and also contain subsequent frames.
        if (end + 1 > 1024 * 1024) { this.fail('frame_too_large'); child.stdin.end(); return; }
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        let message; try { message = JSON.parse(line.toString('utf8')); } catch { this.fail('invalid_json'); child.stdin.end(); return; }
        if (message === null || typeof message !== 'object' || Array.isArray(message)) { this.fail('invalid_json'); child.stdin.end(); return; }
        if (message.method) { onEvent(message); if (this.closed) return; continue; }
        const pending = this.pending.get(message.id); if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new RequestFailure(failureKind(message.error), 'rejected', pending.method, typeof message.error.code === 'number' ? message.error.code : undefined, protocolReason(message.error)));
        else pending.resolve(message.result);
      }
      if (buffer.length > 1024 * 1024) { this.fail('frame_too_large'); child.stdin.end(); }
    });
    child.once('close', () => this.fail('process_closed')); child.once('error', () => this.fail('process_error')); child.stdin.on('error', () => this.fail('stdin_error'));
    child.stderr.resume();
  }
  private fail(reason: RpcFailureReason) { this.firstFailure ??= reason; this.closed = true; for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new RpcTransportFailure(this.firstFailure, item.method)); } this.pending.clear(); }
  call(method: string, params: Record<string, unknown> = {}, timeout = 15000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('transport closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: delivery unknown`)); }, timeout);
      this.pending.set(id, { method, resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method: string): void { if (this.closed) throw new Error('transport closed'); this.child.stdin.write(JSON.stringify({ method }) + '\n'); }
  respond(id: string | number, result: unknown): void { if (this.closed) throw new Error('transport closed'); this.child.stdin.write(JSON.stringify({ id, result }) + '\n'); }
  close(): void { this.fail('owner_closed'); this.child.stdin.end(); }
}
