import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ManagedSession, StartPreview, UsageCapacity } from './managed-client';
import type * as vscode from 'vscode';

// Follow only the configured relay. Looking for a recent discovery file can bind another window.
export function sidebarTarget(relayPath: string, repository: string) {
  if (!path.isAbsolute(relayPath) || path.basename(relayPath).toLowerCase() !== 'codexrelay.exe') throw new Error('Meristem の制御接続を確認できません。');
  const relay = JSON.parse(readFileSync(relayPath + '.json', 'utf8'));
  const host = relay.controlHost;
  if (host?.parentMode !== 'verified-start' || !path.isAbsolute(host.configPath)) throw new Error('この接続は既存会話からの開始に対応していません。');
  const bytes = readFileSync(host.configPath);
  if (createHash('sha256').update(bytes).digest('hex') !== host.configSha256) throw new Error('制御設定が導入時から変わっています。');
  const config = JSON.parse(bytes.toString('utf8'));
  if (config.mcp?.parentRelay?.mode !== 'verified-start' || (config.mcp.parentRelay.sessionKind ?? 'vscode') !== 'vscode'
    || config.mcp.parentRelay.pipeName !== relay.pipeName || !path.isAbsolute(config.stateDirectory)
    || realpathSync.native(config.repository).toLowerCase() !== realpathSync.native(repository).toLowerCase()) throw new Error('選択したリポジトリと VS Code の制御接続が一致しません。');
  return { file: path.join(config.stateDirectory, 'discovery.json'), repository: realpathSync.native(repository).toLowerCase(), runId: config.runId as string, pipeName: config.pipeName as string };
}

export function usageText(capacity: UsageCapacity, hasPlan: boolean) {
  const value = (at: number | null) => at === null ? '不明' : new Date(at).toLocaleString();
  const reasons: Record<string, string> = { available: '通常の人数上限', legacy: '旧形式の実行', disabled: '残量による自動制限は無効', usage_denied: '利用不可', exhausted: '残量がないため割当待ち', low_remaining: '残量が少ないため人数を制限', usage_unknown: '利用枠の取得待ち' };
  const statuses: Record<string, string> = { ok: '取得済み', stale: '更新待ち', missing: '対象枠なし', account_mismatch: '認証先が一致しません', unsupported: '取得に未対応', unavailable: '取得不能' };
  return [
    ...capacity.windows.map(w => `${w.windowDurationMins === null ? '期間不明' : w.windowDurationMins + ' 分'}　使用 ${w.usedPercent}%　残り ${w.remainingPercent}%　リセット ${value(w.resetsAt === null ? null : w.resetsAt * 1000)}`),
    `利用枠　${statuses[capacity.usageStatus] ?? '取得不能'}　最終取得　${value(capacity.fetchedAt)}`,
    ...(hasPlan ? [`Worker　稼働 ${capacity.activeWorkers} 人 ／ 実効上限 ${capacity.effectiveMaximum} 人`,
    `希望 ${capacity.requestedMaximum} 人　承認上限 ${capacity.approvedMaximum} 人　残量上限 ${capacity.quotaMaximum === null ? '制限なし' : capacity.quotaMaximum + ' 人'}`,
    reasons[capacity.reason] ?? capacity.reason] : [`Worker　稼働 ${capacity.activeWorkers} 人。希望人数と上限は開始範囲の確定後に表示します。`])
  ].join('\n');
}

function display(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => '\\u{' + char.codePointAt(0)!.toString(16) + '}');
}

function gitDestination(value: string) {
  if (/^\w[\w+.-]*:\/\//.test(value)) {
    const url = new URL(value);
    return display(url.protocol + '//' + url.host + url.pathname);
  }
  if (/^[\w-]+::/.test(value)) return 'origin（Git の外部接続コマンド）';
  return display(value.replace(/^[^/:\\\s]+@(?=[^/:\\\s]+:)/, ''));
}

export async function confirmStart(api: typeof vscode, session: ManagedSession, preview: StartPreview, current: () => boolean) {
  const { scope, parent } = preview, plan = scope.planScope;
  const editable = scope.permissionPermit?.allowedProfileIds.includes('workspace') ?? true;
  const tasks = preview.tasks;
  const routing = scope.modelRouting;
  const quota = plan.usagePolicy;
  const folder = display(path.win32.basename(scope.repositoryPath));
  const destination = gitDestination(plan.gitDestination);
  const summary = [
    scope.maxInstructions === 0 ? '今回は接続と確認のみです。ワーカーへの指示は0回です。' :
      `この Codex 会話から、同時に最大${plan.approvedMaximum}人のワーカーに作業を依頼できるようになります。報告はこの会話で確認できます。`,
    `工程表　${display(path.win32.basename(scope.planPath))}`,
    ...(tasks ? [`作業（全${tasks.count}件）　${tasks.names.map(display).join('、')}${tasks.count > tasks.names.length ? ' ほか' : ''}`] : []),
    editable ? 'ワーカーは担当フォルダーのファイルを編集できます。' : 'ワーカーに許可するのは、ファイルの読み取りと結果の報告です。',
    ...(editable && plan.scopedGitSave ? [`担当ブランチの変更をコミットし、${destination} に送信できます。`] : []),
    ...(routing?.tasks.length ? [`工程表で指定した${routing.tasks.length}件の作業でモデルの自動切り替えを許可します（1件につき最大${routing.maxAutomaticChangesPerTask}回）。`] : []),
    ...(scope.permissionPermit?.allowedReviewers.includes('auto_review') ? ['追加の許可要求には自動審査を使います。'] : [])
  ];
  const details = [`対象フォルダー　${display(scope.repositoryPath)}`, `工程表　${display(scope.planPath)}（形式の版 ${plan.planVersion}）`,
    `ワーカーの作業場所　${display(plan.worktreesRoot)}`, `対象ブランチ　${scope.branchScope.map(display).join('、')}`, `統合先ブランチ　${display(plan.integrationBranch)}`,
    ...(editable ? [`書き込みを許可する場所　${(scope.permissionPermit?.writableRoots ?? [plan.worktreesRoot]).map(display).join('、')}`] : []),
    `Git の送信先　${destination}`,
    `同時に作業する人数　工程表の希望は${plan.requestedMaximum}人、今回許可する上限は${plan.approvedMaximum}人`,
    ...(quota?.enabled ? [`Codex の利用枠が残り${quota.threshold}％以下なら最大${quota.lowMaximum}人に制限します。`] : []),
    ...(scope.maxInstructions !== undefined ? [`ワーカーへの指示は合計${scope.maxInstructions}回までです。`] : []),
    ...(routing ? [`最初のモデル　${routing.mode === 'learned' ? '条件を満たす実績があれば推奨モデルを使用' : '工程表の指定を使用'}`,
      `切り替え可能なモデル　${routing.candidates.map(c => c.model + ' (' + c.effort + ')').join('、')}`,
      ...routing.tasks.map(task => `対象の工程　${task.taskId}（指定モデル ${task.agent.model} / ${task.agent.effort}）`),
      `対象工程表の照合値　${routing.planHash}`, ...(routing.summarySha256 ? [`モデル実績の照合値　${routing.summarySha256}`] : [])] : []),
    `親の会話 ID　${parent.threadId}`, `実行 ID　${preview.runId}`];
  const confirm = 'この範囲で開始', more = '詳しい範囲を見る', back = '開始の確認に戻る';
  const question = scope.maxInstructions === 0 ? `「${folder}」で接続を確認しますか？` : `「${folder}」の作業をワーカーに任せますか？`;
  while (current()) {
    const choice = await api.window.showInformationMessage(question, { modal: true, detail: summary.join('\n\n') }, confirm, more);
    if (choice === more) {
      if (await api.window.showInformationMessage('今回許可する作業の詳細', {modal:true, detail:details.join('\n')}, back) !== back) return;
      continue;
    }
    if (choice !== confirm || !current()) return;
    await session.start(preview);
    await api.window.showInformationMessage(scope.maxInstructions === 0 ? '確認用の実行を開始しました。' : 'この会話からワーカーに作業を依頼できるようになりました。');
    return;
  }
}
