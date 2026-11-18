import { connect as netConnect, Socket } from 'node:net';

export type WorkerRef = { id: string; pipeName: string; cwd: string; branch: string; agent: string; state: string; actor?: string; attemptId?: string };
// Mirrors MC-01's WorkerPresentation. Kept local to the separately built extension.
export type WorkerPresentation = { displayName: string; taskId: string; activity: string; activitySource: 'tool' | 'worker' | null; lastActivityAt: string | null; decisionIds: string[] };
export type ConsultationSummary = { id: string; recipient: 'coordinator' | 'human'; question: string; state: 'pending' | 'resolved' | 'cancelled' | 'superseded'; taskIds: string[]; blockingTaskIds: string[] };
export type WorkerStatus = { cwd: string; branch: string; agent: string; state: string; presentation?: WorkerPresentation; consultations?: ConsultationSummary[]; consultationsTruncated?: boolean; taskState?: string; slotReleased?: boolean; permissionSummary?: string; appliedAgent?: string; lastResult?: string; connection?: 'connected' | 'unknown' };
export type TerminalBinding = { worker: WorkerRef; attemptId: string; fixture?: true; managed?: true; presentation?: WorkerPresentation };
export type DisplayEvent = { seq: number; worker: WorkerRef; text: string; source?: 'tool' | 'worker' | 'settings' };
type DisplayBatch = { events: DisplayEvent[]; lastSeq: number; omittedCount?: number; hasMore?: boolean; activityEvents?: DisplayEvent[]; lastActivitySeq?: number; omittedActivityCount?: number };
export type StopResult = { ok: boolean; state: string; jobClosed?: boolean };
export type OwnerRef = { fixture: true; pipeName: string; worker: WorkerRef; attemptId: string };
export interface ControlConnection {
  readEvents(afterSeq: number, limit: number, afterActivitySeq?: number): Promise<DisplayBatch>;
  getStatus(worker: WorkerRef): Promise<WorkerStatus>;
  stop(binding: TerminalBinding): Promise<StopResult>;
  retire?(binding: TerminalBinding): Promise<StopResult>;
  rename?(binding: TerminalBinding, displayName: string): Promise<string>;
  dispose(): void;
}

let nextPipeSlot=0;
function request(pipeName: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!/^meristem-cc00r-[a-zA-Z0-9-]{1,90}$/.test(pipeName)) return Promise.reject(new Error('fixture pipe required'));
  return new Promise((resolve, reject) => {
    const slot=nextPipeSlot++%16;
    const socket: Socket = netConnect('\\\\.\\pipe\\' + pipeName + '-' + slot);
    let data = '', settled=false;
    const fail=(error:Error)=>{if(settled)return;settled=true;reject(error);socket.destroy();};
    socket.setEncoding('utf8');
    socket.setTimeout(3000,()=>socket.destroy(new Error('fixture control request timed out')));
    socket.once('error', fail);
    socket.once('end',()=>fail(new Error('fixture control closed before response')));
    socket.once('close',()=>fail(new Error('fixture control closed before response')));
    socket.on('data', chunk => {
      if(settled)return;
      data += chunk;
      if(Buffer.byteLength(data)>262144){fail(new Error('fixture control response too large'));return;}
      const end = data.indexOf('\n');
      if (end >= 0) { settled=true;try { resolve(JSON.parse(data.slice(0, end))); } catch (error) { reject(error); } socket.destroy(); }
    });
    socket.once('connect', () => socket.write(JSON.stringify({ method, ...params }) + '\n'));
  });
}

export async function connect(owner: OwnerRef): Promise<ControlConnection> {
  if (owner?.fixture !== true || !owner.attemptId || owner.worker.pipeName!==owner.pipeName) throw new Error('explicit CC-00R fixture binding required');
  const binding={...owner,worker:{...owner.worker}};
  return {
    async readEvents(afterSeq, limit) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('bounded event read required');
      const response = await request(binding.pipeName, 'events', { afterSeq, limit });
      const events = Array.isArray(response.events) ? response.events.map((event): DisplayEvent => ({
        seq: Number((event as Record<string, unknown>).seq), worker: binding.worker,
        text: String((event as Record<string, unknown>).text ?? '')
      })).filter(event=>Number.isSafeInteger(event.seq)&&event.seq>afterSeq).slice(0,limit) : [];
      return { events, lastSeq: Number.isSafeInteger(response.lastSeq) ? Number(response.lastSeq) : afterSeq, omittedCount:Number.isSafeInteger(response.omittedCount)?Math.max(0,Number(response.omittedCount)):0 };
    },
    async getStatus(worker) {
      if (worker.id !== binding.worker.id) throw new Error('worker binding mismatch');
      const status = await request(binding.pipeName, 'status');
      return { cwd: String(status.cwd ?? worker.cwd), branch: String(status.branch??worker.branch), agent: String(status.agent??worker.agent), state: String(status.state ?? 'unknown') };
    },
    async stop(terminal) {
      if (terminal.fixture !== true || terminal.worker.id !== binding.worker.id || terminal.worker.pipeName!==binding.pipeName || terminal.attemptId!==binding.attemptId) throw new Error('stale terminal binding');
      const status = await request(binding.pipeName, 'status');
      if (status.state !== 'running') return { ok: true, state: String(status.state ?? 'unknown') };
      return await request(binding.pipeName, 'stop') as StopResult;
    },
    dispose() { /* each bounded request owns and closes its pipe connection */ }
  };
}
