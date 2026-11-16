import type { ControlEvent } from './contracts.js';
const labels: Record<ControlEvent['kind'], string> = {
  wake_limit: '親の再開回数の上限で停止しました', correction_limit: '工程の修正回数の上限で停止しました',
  registered: '担当を登録しました', running: '実行中', waiting_approval: '人の承認待ち',
  waiting_input: '質問への回答待ち', authentication_required: '認証が必要です', limit_reached: '利用上限に達しました',
  failed: '実行に失敗しました', turn_completed: '回答完了・プロセス終了を確認中', completed: '完了・プロセス終了確認済み', report_saved: '報告を記録しました',
  late_report: '停止後の報告を記録しました', stopping: 'runの停止要求を記録しました（各workerの状態は別表示）', stopped: 'プロセス終了確認済み',
  unknown: '終了または配送を確認できません', needs_reconcile: '実行記録の照合が必要です'
};
export function displayEvent(kind: ControlEvent['kind']): string { return labels[kind] ?? '状態を確認してください'; }
