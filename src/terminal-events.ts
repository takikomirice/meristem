import type { AgentChoice, ControlEvent } from './contracts.js';
import { stripVTControlCharacters } from 'node:util';
const labels: Record<ControlEvent['kind'], string> = {
  decision_changed: '相談の状態が変わりました',
  decision_proposed: '相談を作成しました', decision_answered: '相談への回答を受け取りました',
  decision_cancelled: '相談を取り消しました', decision_superseded: '以前の提案を取り下げました',
  decision_revised: '修正案を新しい相談として登録しました', plan_change_applied: '承認済みの工程表変更を適用しました',
  wake_limit: '親の再開回数の上限で停止しました', correction_limit: '工程の修正回数の上限で停止しました',
  registered: '担当を登録しました', running: '実行中', waiting_approval: '人の承認待ち',
  waiting_input: '質問への回答待ち', authentication_required: '認証が必要です', limit_reached: '利用上限に達しました',
  failed: '実行に失敗しました', turn_completed: '回答完了・プロセス終了を確認中', completed: '完了・プロセス終了確認済み', report_saved: '報告を記録しました',
  late_report: '停止後の報告を記録しました', stopping: 'runの停止要求を記録しました（各workerの状態は別表示）', stopped: 'プロセス終了確認済み',
  unknown: '終了または配送を確認できません', needs_reconcile: '実行記録の照合が必要です'
};
export function displayEvent(kind: ControlEvent['kind'], decisionKind?: unknown): string {
  const subject = decisionKind === 'parallelism' ? '増員' : decisionKind === 'plan_change' ? '工程表改訂' : '';
  return (subject ? `【${subject}】` : '') + (labels[kind] ?? '状態を確認してください');
}

export function terminalText(value: string, maxBytes: number): string {
  const safe = stripVTControlCharacters(value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\|$)/g, ''))
    .replace(/[\x00-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\b(?:Authorization["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+\S+|\S+)|Bearer\s+\S+|(?:api[_-]?key|(?:access|refresh|auth)[_-]?token|password|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)|(?:sk-|gh[pousr]_|github_pat_)[a-z0-9_-]{12,})/gi, '[redacted]');
  const bytes = Buffer.from(safe);
  const marker = ' [表示省略]';
  return bytes.length <= maxBytes ? safe : new TextDecoder().decode(bytes.subarray(0, maxBytes - Buffer.byteLength(marker)), { stream: true }) + marker;
}

type Activity = { text: string; source: 'tool' | 'worker'; result?: string };
type ActivityEvent = { text: string; source: 'tool' | 'worker' | 'settings'; seq: number };
const activityCapacity = 64;
const testCommand = /^(?:(?:npm|pnpm)\s+(?:run\s+)?test(?=[:\s]|$)|yarn\s+test(?=[:\s]|$)|node\s+--test(?:\s|$)|(?:npx\s+)?(?:vitest|jest|pytest)(?:\s|$)|(?:dotnet|cargo|go)\s+test(?:\s|$))/i;

function codexActivity(method: string, item: any): Activity | undefined {
  if (method !== 'item/started' && method !== 'item/completed') return;
  if (item?.type === 'agentMessage' && item.phase === 'commentary' && method === 'item/completed') {
    // Commentary is worker-authored, but its free-form body can contain private conversation.
    return { source: 'worker', text: 'ワーカーが進捗を説明しました' };
  }
  if (item?.type === 'fileChange') return { source: 'tool', text: method === 'item/started' ? 'ファイルを編集中' : 'ファイルを編集する処理が終了しました' };
  if (item?.type !== 'commandExecution') return;
  const actions: unknown[] = Array.isArray(item.commandActions) ? item.commandActions.slice(0, 16) : [];
  const types = actions.map(action => (action as { type?: string } | null)?.type);
  // Identify common commands, including Codex's Windows shell wrapper. Never display arguments.
  const commands = [item.command, ...actions.map(action => (action as { command?: string } | null)?.command)]
    .filter((command): command is string => typeof command === 'string')
    .map(command => command.slice(0, 1024).trimStart().replace(/^(?:"[^"]*(?:pwsh|powershell)(?:\.exe)?"|[^"\s]*(?:pwsh|powershell)(?:\.exe)?)\s+(?:(?:-NoProfile|-NonInteractive|-NoLogo)\s+)*-Command\s+["']?/i, '').trimStart());
  const test = commands.some(command => testCommand.test(command));
  const search = types.includes('search') || commands.some(command => /^(?:rg(?:\.exe)?|Select-String)\s/i.test(command));
  const read = types.includes('read') || commands.some(command => /^Get-Content\s/i.test(command));
  const list = types.includes('listFiles') || commands.some(command => /^Get-ChildItem(?:\s|$)/i.test(command));
  const git = commands.some(command => /^git(?:\.exe)?\s/i.test(command));
  const [text, operation] = test ? ['テストを実行', 'テストコマンド']
    : search ? ['作業ツリーを検索', '検索']
    : read ? ['ファイル読み取り', 'ファイル読み取り']
    : list ? ['ファイル一覧を取得', 'ファイル一覧の取得']
    : git ? ['Gitコマンドを実行', 'Git操作'] : ['コマンド実行', 'コマンド'];
  if (method === 'item/started') return { source: 'tool', text: `${text}中` };
  let result: string | undefined;
  let ending = '終了';
  if (Number.isSafeInteger(item.exitCode)) {
    ending = item.exitCode === 0 ? '完了' : '失敗';
    result = item.exitCode === 0 ? `${operation}が成功しました` : `${operation}が正常終了しませんでした（終了コード ${item.exitCode}）`;
    if (item.exitCode === 1 && commands.length && commands.every(command => /^rg(?:\.exe)?\s/i.test(command) && !/[|;&\r\n]/.test(command))) {
      ending = '完了';
      result = '検索に一致する項目はありませんでした';
    }
  }
  return { source: 'tool', text: operation === 'コマンド' ? 'コマンド実行終了' : operation + ending, result };
}

export class TerminalActivity {
  private readonly events: ActivityEvent[] = [];
  private sequence = 0;
  latest?: ActivityEvent & { source: 'tool' | 'worker' };
  lastActivityAt: string | null = null;
  lastResult?: string;
  constructor(public agent?: AgentChoice) {}

  recordAgent(next: AgentChoice): void {
    const previous = this.agent;
    this.agent = next;
    if (!previous) return;
    const changes: string[] = [];
    if (previous.model !== next.model) changes.push(`${previous.model}→${next.model}`);
    if (previous.effort !== next.effort) changes.push(`${previous.effort}→${next.effort}`);
    if (changes.length) {
      const seq = ++this.sequence;
      this.events[(seq - 1) % activityCapacity] = { seq, source: 'settings', text: `[設定変更]${changes.join(', ')}` };
    }
  }

  record(method: string, item: unknown): void {
    const activity = codexActivity(method, item);
    if (!activity) return;
    const event = { seq: ++this.sequence, text: activity.text, source: activity.source };
    this.latest = event;
    this.lastActivityAt = new Date().toISOString();
    if (activity.result) this.lastResult = activity.result;
    this.events[(event.seq - 1) % activityCapacity] = event;
  }

  read(afterSeq: number, limit: number) {
    const earliest = Math.max(1, this.sequence - activityCapacity + 1);
    const first = Math.max(earliest, afterSeq + 1), activityEvents: ActivityEvent[] = [];
    for (let seq = first; seq <= this.sequence && activityEvents.length < limit; seq++) {
      activityEvents.push(this.events[(seq - 1) % activityCapacity]);
    }
    return { activityEvents, lastActivitySeq: activityEvents.at(-1)?.seq ?? afterSeq, omittedActivityCount: Math.max(0, earliest - afterSeq - 1) };
  }
}
