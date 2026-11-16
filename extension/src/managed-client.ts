import { readFileSync } from 'node:fs';
import { connect as netConnect, Socket } from 'node:net';
import type { ControlConnection, TerminalBinding, WorkerRef } from './control-client';

type RegisteredWorker = { ownerId: string; ownerEpoch: string; workerId: string; attemptId: string; threadId: string };
type Registration = { worker: RegisteredWorker; cwd: string; branch: string; model: string; effort: string; binding: { worker: RegisteredWorker; terminalId: string; windowBindingId: string } };
type Discovery = { pipeName: string; token: string; ownerId: string; ownerEpoch: string; windowBindingId: string; runId: string };
export type HumanRequest = { kind: string; key: string; payloadHash: string; formGeneration: string; worker: RegisteredWorker; cwd: string; turnId: string | null; requestId: string | number; state: string; detail: string };
export type ManagedSession = { terminals: { connection: ControlConnection; binding: TerminalBinding }[]; refresh(): Promise<void>; requests(): Promise<HumanRequest[]>; answer(item: HumanRequest, action: 'accept' | 'decline' | 'cancel'): Promise<void>; dispose(): void };
let slot = 0;
async function availablePipe(pipeName: string): Promise<Socket> {
  for (let attempt = 0; attempt < 16; attempt++) {
    try { return await new Promise<Socket>((resolve, reject) => {
      const socket = netConnect(`\\\\.\\pipe\\${pipeName}-${slot++ % 16}`);
      const failed = (error: Error) => { socket.destroy(); reject(error); };
      socket.once('error', failed); socket.setTimeout(1000, () => failed(new Error('connect timeout')));
      socket.once('connect', () => { socket.removeListener('error', failed); socket.setTimeout(0); resolve(socket); });
    }); } catch { /* only retry before any request bytes are sent */ }
  }
  throw new Error('managed control connection unavailable');
}
export async function connectManaged(discoveryFile: string): Promise<ManagedSession> {
  const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8')) as Discovery;
  if (!/^meristem-cc01-control-[a-zA-Z0-9-]{1,90}$/.test(discovery.pipeName) || !discovery.ownerId || !discovery.ownerEpoch || !discovery.token || !discovery.windowBindingId) throw new Error('explicit managed discovery required');
  const sockets = new Set<Socket>(); let disposed = false;
  async function request(method: string, params: Record<string, unknown> = {}, lease = false): Promise<any> {
    if (disposed) return Promise.reject(new Error('management connection closed'));
    const socket = await availablePipe(discovery.pipeName);
    if (disposed) { socket.destroy(); throw new Error('management connection closed'); }
    return new Promise((resolve, reject) => {
      sockets.add(socket);
      let buffer = Buffer.alloc(0), settled = false;
      const fail = () => { if (!settled) { settled = true; reject(new Error('managed control unavailable')); } socket.destroy(); };
      socket.setTimeout(12000, fail); socket.once('error', fail); socket.once('end', fail);
      socket.once('close', () => { sockets.delete(socket); if (!settled) fail(); if (lease) dispose(); });
      socket.on('data', chunk => {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 262144) return fail();
        const end = buffer.indexOf(10); if (end < 0) return;
        try {
          const response = JSON.parse(buffer.subarray(0, end).toString('utf8'));
          if (!response.ok) return fail();
          settled = true; resolve(response); if (lease) socket.setTimeout(0); else socket.destroy();
        } catch { fail(); }
      });
      socket.write(JSON.stringify({ ...discovery, method, ...params }) + '\n');
    });
  }
  function dispose() { if (disposed) return; disposed = true; for (const socket of sockets) socket.destroy(); sockets.clear(); }
  try {
    await request('lease', {}, true);
    const terminals: ManagedSession['terminals'] = [], known = new Set<string>();
    async function refresh(): Promise<void> {
      const status = await request('status');
      for (const attempt of status.attempts as { state: string; registration: Registration }[]) {
      const registration = attempt.registration;
      if (known.has(registration.worker.attemptId) || registration.worker.threadId === 'pending') continue;
      if (registration.binding.windowBindingId !== discovery.windowBindingId) throw new Error('stale window binding');
      const worker: WorkerRef = { id: registration.worker.workerId, pipeName: discovery.pipeName, cwd: registration.cwd, branch: registration.branch, agent: `${registration.model} / ${registration.effort}`, state: attempt.state, actor: `${registration.worker.ownerId}/${registration.worker.ownerEpoch}/${registration.worker.threadId}`, attemptId: registration.worker.attemptId };
      const binding: TerminalBinding = { worker, attemptId: registration.worker.attemptId };
      const connection: ControlConnection = {
        async readEvents(afterSeq, limit) {
          const result = await request('events', { afterSeq, limit });
          return { events: result.events.filter((event: any) => !event.attemptId || event.attemptId === binding.attemptId).map((event: any) => ({ seq: event.seq, worker, text: event.text })), lastSeq: result.lastSeq };
        },
        async getStatus(target) {
          if (target.id !== worker.id || target.pipeName !== worker.pipeName) throw new Error('worker binding mismatch');
          const current = await request('status'), row = current.attempts.find((a: any) => a.registration.worker.attemptId === binding.attemptId);
          if (!row || JSON.stringify(row.registration.worker) !== JSON.stringify(registration.worker)) throw new Error('stale attempt binding');
          return { cwd: worker.cwd, branch: worker.branch, agent: `${row.registration.model} / ${row.registration.effort}`, state: row.state };
        },
        async stop(target) {
          if (target.attemptId !== binding.attemptId || target.worker.id !== worker.id || target.worker.pipeName !== worker.pipeName) throw new Error('stale terminal binding');
          const response = await request('close_terminal', { binding: registration.binding });
          return { ok: response.result?.state === 'stopped', state: response.result?.state ?? 'unknown' };
        },
        dispose() { /* the window lease, not an individual tab, owns this session */ }
      };
      known.add(registration.worker.attemptId); terminals.push({ connection, binding });
      }
    }
    await refresh();
    return { terminals, refresh, dispose,
      async requests() { return (await request('requests')).requests; },
      async answer(item, action) { await request('answer_request', { answer: { worker: item.worker, key: item.key, payloadHash: item.payloadHash, formGeneration: item.formGeneration, action } }); }
    };
  } catch (error) { dispose(); throw error; }
}
