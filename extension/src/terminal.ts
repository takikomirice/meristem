import type * as vscode from 'vscode';
import { stripVTControlCharacters } from 'node:util';
import type { ControlConnection, DisplayEvent, TerminalBinding, StopResult, WorkerStatus } from './control-client';

const EVENT_LIMIT = 100;
const EVENT_BYTES = 64 * 1024;
const QUEUE_BYTES = 1024 * 1024;
const workerStates: Readonly<Record<string, string>> = {
  starting: '起動中', idle: '指示待ち', running: '実行中', waiting_input: '回答待ち', waiting_approval: '承認待ち',
  stopping: '停止中', stopped: '停止済み', completed: '完了', failed: '失敗', unknown: '実行状態不明'
};
const permissionLabels = new Map([
  ['meristem-managed（割り当て先への書き込み、承認: auto_review）', '割り当て先に書き込み可 · 自動レビュー'],
  ['meristem-managed（割り当て先への書き込み、承認: user）', '割り当て先に書き込み可 · 手動承認'],
  ['meristem-read-only（読み取り専用、承認: auto_review）', '読み取り専用 · 自動レビュー'],
  ['meristem-read-only（読み取り専用、承認: user）', '読み取り専用 · 手動承認']
]);
const sinks=new Set<(event:DisplayEvent)=>void>();
const stops=new WeakMap<vscode.Terminal,()=>Promise<StopResult>>();
const disposals=new WeakMap<vscode.Terminal,()=>void>();
const details=new WeakMap<vscode.Terminal,()=>void>();
const terminalStatus = new WeakMap<vscode.Terminal, { refresh(): Promise<void>; finished(): boolean }>();

const SECRET = /\b(?:Authorization["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+\S+|\S+)|Bearer\s+\S+|(?:api[_-]?key|(?:access|refresh|auth)[_-]?token|password|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)|(?:sk-|gh[pousr]_|github_pat_)[a-z0-9_-]{12,})/gi;
export function sanitize(text: string): string {
  return stripVTControlCharacters(text.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(SECRET, '[redacted]');
}
function boundedText(text: string, bytes: number, marker: string): string {
  return Buffer.byteLength(text) <= bytes ? text
    : new TextDecoder().decode(Buffer.from(text).subarray(0, bytes - Buffer.byteLength(marker)), { stream: true }) + marker;
}
function preview(text: string, bytes: number): string {
  return boundedText(sanitize(text).replace(/\n/g, ' '), bytes, ' [表示省略]');
}

class Emitter<T> {
  private listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void): vscode.Disposable => { this.listeners.push(listener); return { dispose: () => { this.listeners=this.listeners.filter(item=>item!==listener); } }; };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
}

export function openWorkerTerminal(api: typeof vscode, connection: ControlConnection, binding: TerminalBinding): vscode.Terminal {
  binding={...binding,worker:{...binding.worker}};
  let closed = false, seq = 0, activitySeq = 0, queuedBytes = 0, omitted = 0;
  let drawing: NodeJS.Immediate | undefined;
  let currentState=binding.worker.state;
  let stopSettled=false,lastDisplayedSeq=0;
  let lastActivitySeq = 0, statusRequest = 0, appliedStatusRequest = 0;
  let stopPromise: Promise<StopResult> | undefined, programmatic = false;
  let status: WorkerStatus = { ...binding.worker, presentation: binding.presentation };
  let currentName = terminalName();
  let displayedFields = new Set<string>(), nextFields = displayedFields;
  let pendingSummary: string | undefined;
  const queue: string[] = [];
  const write = new Emitter<string>();
  const nameChanged = new Emitter<string>();
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidChangeName: nameChanged.event,
    open: () => { void poll(); },
    close: () => {
      if (closed) return;
      closed = true;
      sinks.delete(receive);
      if(drawing) clearImmediate(drawing);
      queue.length=0;pendingSummary=undefined;queuedBytes=0;
      if (!programmatic && !finished(currentState)) {
        // The managed broker atomically checks the binding and process state when closing.
        const check = binding.managed ? stopOnce() : connection.getStatus(binding.worker).then(current => !finished(current.state) ? stopOnce() : undefined);
        void check.catch(() => undefined);
      }
    },
    handleInput: (_input: string) => { /* display-only: input and paste never reach the worker */ }
  };
  function finished(state: string): boolean { return state === 'completed' || state === 'stopped'; }
  async function refreshStatus(activities: DisplayEvent[] = []): Promise<void> {
    const request = ++statusRequest;
    const current = await connection.getStatus(binding.worker);
    if (closed || request < appliedStatusRequest) return;
    appliedStatusRequest = request;
    status = current; currentState = current.state;
    renderStatus(activities); flush();
  }
  async function poll(): Promise<void> {
    while (!closed&&!stopSettled) {
      try {
        const wasFinished = finished(currentState);
        const batch = await connection.readEvents(seq, EVENT_LIMIT, activitySeq);
        const activities = (batch.activityEvents ?? []).slice(0, EVENT_LIMIT)
          .filter(event => forThisWorker(event) && event.seq > lastActivitySeq);
        await refreshStatus(activities);
        if(closed||stopSettled) return;
        seq = Math.max(seq, batch.lastSeq);
        activitySeq = Math.max(activitySeq, batch.lastActivitySeq ?? activitySeq);
        if(batch.omittedCount)enqueueText(`[${batch.omittedCount} older host events omitted]\n`);
        if (batch.omittedActivityCount) enqueueText(`[活動イベント ${batch.omittedActivityCount} 件省略]\n`);
        for (const event of batch.events.slice(0, EVENT_LIMIT)) enqueue(event);
        for (let i = 0; i < activities.length;) {
          const first = activities[i++];
          let last = first, count = 1;
          while (i < activities.length && activities[i].seq === last.seq + 1 &&
                 activities[i].source === first.source && activities[i].text === first.text) {
            last = activities[i++]; count++;
          }
          enqueue(count === 1 ? first : { ...last, text: `${first.text}（${count}件）` }, true);
        }
        flush();
        if (finished(currentState)) {
          // One more page can contain events written after the last events read but before confirmed cleanup.
          if (binding.managed && (!wasFinished || batch.hasMore)) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
          if (!status.consultations?.some(consultation => consultation.state === 'pending')) return;
        }
      } catch {
        if(closed||stopSettled) return;
        status = { ...status, connection: 'unknown' }; renderStatus(); flush();
      }
      await new Promise(resolve => setTimeout(resolve, finished(currentState) ? 5000 : 500));
    }
  }
  function terminalName(): string {
    return sanitize(status.presentation?.displayName ?? `Worker ${binding.worker.id}`).replace(/\n/g, ' ').slice(0, 128) || `Worker ${sanitize(binding.worker.id)}`;
  }
  function renderStatus(activities: DisplayEvent[] = []): void {
    const name = terminalName();
    if (name !== currentName) { currentName = name; nameChanged.fire(name); }
    const presentation = status.presentation;
    const identity = `担当: ${name}` + (presentation ? ` · タスク ${preview(presentation.taskId, 512)}` : '');
    const state = Object.hasOwn(workerStates, status.state) ? workerStates[status.state] : preview(status.state, 256);
    const stateLine = `状態: ${state}`;
    const permission = status.permissionSummary ?? '未確認';
    const modelLine = `モデル：${preview(status.appliedAgent ?? status.agent, 512)}`;
    const lines = [identity, stateLine, modelLine, `権限：${preview(permissionLabels.get(permission) ?? permission, 1024)}`,
      `接続: ${status.connection === 'unknown' ? '不明（最新の実行状態は未確認）' : '接続済み'}`];
    if (status.lastResult && status.lastResult !== '情報なし') lines.push(`直近結果: ${preview(status.lastResult, 1024)}`);
    if (presentation) {
      const activitySource = presentation.activitySource === 'tool' ? ' [ツール]' : presentation.activitySource === 'worker' ? ' [ワーカー説明]' : '';
      if (status.taskState) lines.push(`タスク状態: ${status.taskState === 'assigned' ? '割当済み' : status.taskState === 'held' ? '保留中' : status.taskState === 'retired' ? '担当を解除済み' : preview(status.taskState, 128)}`);
      if (status.slotReleased !== undefined) lines.push(`実行枠: ${status.slotReleased ? '解放済み' : '終了確認待ち'}`);
      if (presentation.activity && presentation.activity !== '情報なし') lines.push(`${finished(status.state) ? '最後の作業' : '現在の作業'}${activitySource}: ${preview(presentation.activity, 2048)}`);
      const last = presentation.lastActivityAt, timestamp = last ? Date.parse(last) : NaN;
      if (Number.isFinite(timestamp)) lines.push(`最終活動: ${last}`);
      const consultationStart = lines.length;
      const ids = presentation.decisionIds.slice(0, 128);
      const consultations = status.consultations?.slice(0, 128);
      let displayed = 0;
      for (const id of ids) {
        const consultation = consultations?.find(item => item.id === id);
        const entry = [`相談 ${preview(id, 512)}: 詳細未取得`];
        if (consultation) {
          entry[0] = `相談 ${preview(id, 512)} [${consultation.state}] → ${consultation.recipient === 'human' ? '人' : 'Coordinator'}: ${preview(consultation.question, 256)}`;
          if (consultation.state === 'pending') {
            entry.push(`続行範囲: ${preview(consultation.taskIds.slice(0, 128).filter(task => !consultation.blockingTaskIds.includes(task)).join(', ') || 'なし', 512)}`, `保留範囲: ${preview(consultation.blockingTaskIds.slice(0, 128).join(', ') || 'なし', 512)}`);
          }
        }
        // Reserve space for the omission count; CRLF bytes count toward the event cap.
        if (Buffer.byteLength([...lines, ...entry].join('\r\n')) > EVENT_BYTES - 256) break;
        lines.push(...entry); displayed++;
      }
      const omittedConsultations = presentation.decisionIds.length - displayed;
      if (!ids.length && !status.consultationsTruncated) lines.push('相談: なし');
      if (omittedConsultations > 0) lines.push(`[${omittedConsultations} consultations omitted]`);
      if (status.consultationsTruncated) lines.push('[相談の一部は表示省略]');
      // Keep each consultation and its scopes together when the list changes.
      const consultationsText = lines.splice(consultationStart).join('\n');
      if (consultationsText) lines.push(consultationsText);
    } else lines.push('現在の作業・相談・最終活動: 詳細未取得');
    nextFields = new Set(lines);
    const activityInLog = displayedFields.size > 0 && !finished(status.state) &&
      activities.some(event => event.source === presentation?.activitySource && event.text === presentation?.activity);
    const initial = displayedFields.size === 0;
    const changed = lines.filter(line => !displayedFields.has(line) && !(activityInLog && line.startsWith('現在の作業')) &&
      !(!initial && status.appliedAgent && (line === modelLine || line.startsWith('権限：'))) &&
      !(initial && (line === '接続: 接続済み' || line === '相談: なし' || line === 'タスク状態: 割当済み')));
    if (changed[0] === identity) {
      if (changed[1] === stateLine) changed.splice(1, 1);
      changed[0] = identity.slice('担当: '.length) + ' · ' + state;
    }
    if (changed.length) enqueueText(changed.join('\n') + '\n', true);
    else if (pendingSummary) { queuedBytes -= Buffer.byteLength(pendingSummary); pendingSummary = undefined; }
    if (!pendingSummary) displayedFields = nextFields;
  }
  function forThisWorker(event: DisplayEvent): boolean {
    return event.worker.id === binding.worker.id && event.worker.pipeName === binding.worker.pipeName &&
      event.worker.attemptId === binding.worker.attemptId && event.worker.actor === binding.worker.actor;
  }
  function enqueue(event: DisplayEvent, activity = false): void {
    if (forThisWorker(event) && event.seq>(activity ? lastActivitySeq : lastDisplayedSeq)) {
      if (activity) lastActivitySeq = event.seq;
      else lastDisplayedSeq = event.seq;
      if (binding.managed && !activity && !event.source && event.text === '担当を登録しました') return;
      const prefix = event.source === 'tool' ? '[ツール] ' : event.source === 'worker' ? '[ワーカー説明] ' : '';
      enqueueText(prefix + (event.text.endsWith('\n')?event.text:event.text+'\n'));
    }
  }
  function receive(event:DisplayEvent):void {if(!closed){enqueue(event);flush();}}
  function enqueueText(text: string, summary = false): void {
    const normalized=sanitize(text).replace(/\n/g,'\r\n');
    const marker='\r\n[oversized event omitted]\r\n';
    const safe = boundedText(normalized, EVENT_BYTES, marker);
    const size = Buffer.byteLength(safe);
    // One replaceable status snapshot has priority over logs, within the same 1 MiB budget.
    if (summary) {
      if (pendingSummary) queuedBytes -= Buffer.byteLength(pendingSummary);
      pendingSummary = safe;
    } else queue.push(safe);
    queuedBytes += size;
    while (queue.length && queuedBytes > QUEUE_BYTES) { queuedBytes -= Buffer.byteLength(queue.shift()!); omitted++; }
  }
  function flush(): void {
    if(drawing||closed||(!queue.length&&!omitted&&!pendingSummary)) return;
    drawing=setImmediate(()=>{
      drawing=undefined;
      if(closed) return;
      if(pendingSummary){const summary=pendingSummary;pendingSummary=undefined;queuedBytes-=Buffer.byteLength(summary);displayedFields=nextFields;write.fire(summary);}
      else if(omitted){const count=omitted;omitted=0;write.fire(`[${count} events omitted; latest state obtained separately]\r\n`);}
      else {const line=queue.shift()!;queuedBytes-=Buffer.byteLength(line);write.fire(line);}
      flush();
    });
  }
  const terminal = api.window.createTerminal({ name: currentName, pty, isTransient: true });
  sinks.add(receive);
  function stopOnce(): Promise<StopResult> {
    return stopPromise ??= connection.stop(binding).then(result => {
    currentState=result.state;stopSettled=result.ok&&(result.state==='stopped'||result.state==='completed');
    appliedStatusRequest = ++statusRequest;
    status = { ...status, state: result.state }; renderStatus();flush();
    return result;
    });
  }
  stops.set(terminal, stopOnce);
  disposals.set(terminal, () => { programmatic = true; terminal.dispose(); });
  details.set(terminal, () => {
    if (closed) return;
    enqueueText(`詳細\nWorker ID: ${binding.worker.id}\nActor: ${binding.worker.actor ?? binding.worker.id}\nAttempt: ${binding.worker.attemptId ?? binding.attemptId}\nCWD: ${status.cwd}\nBranch: ${status.branch}\n適用権限: ${preview(status.permissionSummary ?? '未確認', 1024)}\n`); flush();
  });
  terminalStatus.set(terminal, { refresh: refreshStatus, finished: () => finished(currentState) });
  return terminal;
}

export function publishWorkerEvent(event: DisplayEvent): void {for(const sink of sinks)sink(event);}
export function stopWorkerTerminal(terminal:vscode.Terminal):Promise<StopResult> {
  const stop=stops.get(terminal);return stop?stop():Promise.reject(new Error('terminal is not bound to a fixture'));
}
export function disposeWorkerTerminal(terminal: vscode.Terminal): void { disposals.get(terminal)?.(); }
export function showWorkerTerminalDetails(terminal: vscode.Terminal): void { details.get(terminal)?.(); }
export async function refreshWorkerTerminal(terminal: vscode.Terminal): Promise<void> { await terminalStatus.get(terminal)?.refresh(); }
export function workerTerminalFinished(terminal: vscode.Terminal): boolean { return terminalStatus.get(terminal)?.finished() ?? false; }
