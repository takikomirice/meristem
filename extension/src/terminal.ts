import type * as vscode from 'vscode';
import { stripVTControlCharacters } from 'node:util';
import type { ControlConnection, DisplayEvent, TerminalBinding, StopResult } from './control-client';

const EVENT_LIMIT = 100;
const EVENT_BYTES = 64 * 1024;
const QUEUE_BYTES = 1024 * 1024;
const sinks=new Set<(event:DisplayEvent)=>void>();
const stops=new WeakMap<vscode.Terminal,()=>Promise<StopResult>>();
const disposals=new WeakMap<vscode.Terminal,()=>void>();
const SECRET = /(?:Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|password|authorization)\s*[:=]\s*\S+)/gi;
export function sanitize(text: string): string {
  return stripVTControlCharacters(text.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(SECRET, '[redacted]');
}

class Emitter<T> {
  private listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void): vscode.Disposable => { this.listeners.push(listener); return { dispose: () => { this.listeners=this.listeners.filter(item=>item!==listener); } }; };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
}

export function openWorkerTerminal(api: typeof vscode, connection: ControlConnection, binding: TerminalBinding): vscode.Terminal {
  binding={...binding,worker:{...binding.worker}};
  let closed = false, seq = 0, queuedBytes = 0, omitted = 0;
  let drawing: NodeJS.Immediate | undefined;
  let currentState=binding.worker.state;
  let stopSettled=false,lastDisplayedSeq=0;
  let stopPromise: Promise<StopResult> | undefined, programmatic = false, currentAgent = binding.worker.agent;
  const queue: string[] = [];
  const write = new Emitter<string>();
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    open: () => { enqueueText(`Worker ${binding.worker.id}  ${binding.worker.state}\nActor: ${binding.worker.actor ?? binding.worker.id}\nAttempt: ${binding.worker.attemptId ?? binding.attemptId}\nCWD: ${binding.worker.cwd}\nBranch: ${binding.worker.branch}\nRequested agent: ${binding.worker.agent}\n[Recorded events follow; current state is refreshed separately]\n`); void poll(); },
    close: () => {
      if (closed) return;
      closed = true;
      sinks.delete(receive);
      if(drawing) clearImmediate(drawing);
      queue.length=0;queuedBytes=0;
      if (!programmatic) void connection.getStatus(binding.worker).then(current => !['completed', 'stopped'].includes(current.state) ? stopOnce() : undefined).catch(() => undefined);
    },
    handleInput: (_input: string) => { /* display-only: input and paste never reach the worker */ }
  };
  async function poll(): Promise<void> {
    while (!closed&&!stopSettled) {
      try {
        const batch = await connection.readEvents(seq, EVENT_LIMIT);
        seq = Math.max(seq, batch.lastSeq);
        if(batch.omittedCount)enqueueText(`[${batch.omittedCount} older host events omitted]\n`);
        for (const event of batch.events) enqueue(event);
        const current = await connection.getStatus(binding.worker);
        if(stopSettled) return;
        if (current.state !== currentState) { currentState=current.state; enqueueText(`Worker state: ${currentState}\n`); }
        if (current.agent !== currentAgent) { currentAgent = current.agent; enqueueText(`Requested agent: ${currentAgent}\n`); }
        flush();
        if (currentState==='completed'||currentState==='stopped') return;
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : 'unknown';
        enqueueText(`[control connection unavailable (${code}); latest state will be retried]\r\n`); flush();
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  function enqueue(event: DisplayEvent): void {
    if (event.worker.id===binding.worker.id && event.worker.pipeName===binding.worker.pipeName && event.worker.attemptId===binding.worker.attemptId && event.worker.actor===binding.worker.actor && event.seq>lastDisplayedSeq) {
      lastDisplayedSeq=event.seq;enqueueText(event.text.endsWith('\n')?event.text:event.text+'\n');
    }
  }
  function receive(event:DisplayEvent):void {if(!closed){enqueue(event);flush();}}
  function enqueueText(text: string): void {
    const normalized=sanitize(text).replace(/\n/g,'\r\n');
    const marker='\r\n[oversized event omitted]\r\n';
    const safe = Buffer.byteLength(normalized) > EVENT_BYTES
      ? new TextDecoder().decode(Buffer.from(normalized).subarray(0,EVENT_BYTES-Buffer.byteLength(marker)),{stream:true})+marker : normalized;
    const size = Buffer.byteLength(safe);
    while (queue.length && queuedBytes + size > QUEUE_BYTES) { queuedBytes -= Buffer.byteLength(queue.shift()!); omitted++; }
    if (size > QUEUE_BYTES) { omitted++; return; }
    queue.push(safe); queuedBytes += size;
  }
  function flush(): void {
    if(drawing||closed||(!queue.length&&!omitted)) return;
    drawing=setImmediate(()=>{
      drawing=undefined;
      if(closed) return;
      if(omitted){const count=omitted;omitted=0;write.fire(`[${count} events omitted; latest state obtained separately]\r\n`);}
      else {const line=queue.shift()!;queuedBytes-=Buffer.byteLength(line);write.fire(line);}
      flush();
    });
  }
  const terminal = api.window.createTerminal({ name: `Worker ${binding.worker.id}`, pty, isTransient: true });
  sinks.add(receive);
  function stopOnce(): Promise<StopResult> {
    return stopPromise ??= connection.stop(binding).then(result => {
    currentState=result.state;stopSettled=result.ok&&(result.state==='stopped'||result.state==='completed');
    enqueueText(`Worker state: ${result.state}\n`);flush();
    return result;
    });
  }
  stops.set(terminal, stopOnce);
  disposals.set(terminal, () => { programmatic = true; terminal.dispose(); });
  return terminal;
}

export function publishWorkerEvent(event: DisplayEvent): void {for(const sink of sinks)sink(event);}
export function stopWorkerTerminal(terminal:vscode.Terminal):Promise<StopResult> {
  const stop=stops.get(terminal);return stop?stop():Promise.reject(new Error('terminal is not bound to a fixture'));
}
export function disposeWorkerTerminal(terminal: vscode.Terminal): void { disposals.get(terminal)?.(); }
