# MC-04b: 相談・タスク保留・明示再開の結合

2026-11-17（日本時間）。[工程表](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md)のMC-04bと、MC-03／MC-04の受入確認を対象とする。

## 統合と範囲

統合担当はroot。共通起点`6c41c3f`から、MC-03a／03bの`e2d7a64`（先行`3591dc2`を含む）とMC-04aの`844c363`を専用worktreeへ順番にmergeした。統合起点は`48c7b50`、作業branchは`feat/mc-04b-consultation-holds`。両元worktreeと元の`docs/worker-coordination-plan`はクリーンで、未コミット差分・既存証拠を上書きしていない。MC-02／DEの留保と実機記録も維持する。

`src/mcp.ts`から既存PlanControl／Brokerを接続し、DB migration、相談・保留の共有schema、権限設定、回数上限、モデル選択を追加変更しない。native gatewayとMCP transportでは`hold_task`に既存の起動と同じ有限timeout枠を使う。停止unknown時には他attemptの全体停止も待つためで、認証境界や停止の成功条件は緩和しない。

## MCP契約

| 入口 | 結果と制約 |
|---|---|
| `hold_task` | `OperationRef`、`taskId`、`decisionId`。親専用・plan run限定。現行blocking相談を保留へ結び付け、対象attemptのnative停止を確認してから実行枠を解放する |
| `resume_task` | `OperationRef`、`taskId`、`resolvedDecisionId`。親専用。MC-04aの回答・plan・Git・終了identity・他相談の照合を行い、`resume_ready`にする。新attempt起動や指示送信は行わない |

holdの保存とnative停止は段階を分ける。停止中は旧attemptを人数に含め、相談の回答・取消で`task_holds`行が消えても実行保留を保持する。同一hold operationが重なってもBrokerの同じ停止結果を待ち、別attemptを停止しない。停止確認後のTaskHold結果を同じoperationへ保存する。再開後の古いhold／resume operationは記録済み結果だけを返す。

slot解放の返却値は、実際に停止を確認した元attemptの結果に結び付ける。別のMCP callが先にresume／createまで進んでも、元の確認結果を後続attemptの状態から再計算しない。現在の状態は`get_status`で確認する。

全保留相談に、現行計画のまま再開する`optionId: resume`の解決済み回答が必要。人向けフォームの自由記述はMC-03aの新しい未承認proposalへ進み、旧案の承認へ読み替えない。取消・superseded・否定・未解決の別相談では再開しない。保留原因の置換・計画改訂はMC-08へ、中断threadの履歴再開はMC-10へ残す。MC-04bは新thread・新attemptで同じclean worktreeを使う。

## 結合テスト

| テスト | 確認した境界 |
|---|---|
| `consultation_answer_does_not_resume_before_safe_parking` | 回答が停止完了より先でも旧attemptを人数から外さず、独立タスクの上限超過起動・早期resumeを拒否。同operationのhold、resume、再開後のhold再読取で処理を繰り返さない |
| `cancelled_or_superseded_consultation_never_resumes_held_work` | 取消・superseded・否定・人の修正案でhold行が消えても保留を維持。未コミット成果、別相談、古いplanを保持して再開を拒否 |
| `consultation_hold_answer_resume_keeps_independent_worker_running` | 相談→対象だけhold→独立担当の指示続行→標準MCPフォーム／非tool callback→明示resume→新attemptを実Store／Gitで通す。ワーカーからの制御、旧WorkerRef、二重起動を拒否 |
| `hold_result_keeps_confirmed_cleanup_if_resume_wins_the_reply_race` | 停止完了からhold応答までの間にresume／createが進んでも、元attemptの確認結果と再試行結果を保持 |
| `parking_confirms_native_job_without_stopping_independent_worker` | 実WorkerRuntimeをMCP holdへ接続。native Job空、Aのmarker停止、Bのmarker継続を同時に確認 |

最初の3件は未接続toolのREDを確認後にGREENになった。応答競合も`releasedExecutionSlot`がfalseへ戻るREDを確認し、元attemptの停止結果から返す修正後にGREENとなった。native停止は成功stubだけで代替せず、既存MockCodex／Windows Job／hostの終了とmarkerで確認した。人の回答は標準SDKのInMemoryTransportによる模擬クライアントで、実人間・実UIの新規受入とは区別する。

## 最終検証と受入

| 検証 | 結果 |
|---|---|
| `npm.cmd run build:native`、`npm.cmd run typecheck`、`npm.cmd run build` | 成功 |
| `node --test dist/test/decisions.test.js dist/test/mcp.test.js dist/test/requests.test.js dist/test/wake.test.js` | 94/94成功 |
| `node --test dist/test/plan.test.js dist/test/plan-control.test.js dist/test/broker.test.js dist/test/parallel.test.js dist/test/workers.test.js` | 84/84成功 |
| 標準`npm.cmd run verify` | 終了コード0。native・型・build、通常42・制御287・端末14の計343件成功 |
| 文書・差分 | ローカル参照の存在、MC-03／MC-04の各項目と試験の対応、`git diff --check`を確認 |

全体ログ中の一時fixture`related.test.js`の意図的な失敗は開発CLIの失敗伝播試験で、その親テストと最終集計は成功している。MC-04aで記録した標準verifyのEPERMやMC-03aの中断を過去にさかのぼって成功へ変更せず、今回は統合コードで標準verify全体が成功した別の実績として記録する。

独立した読取りレビューはCritical／Important／Minorの修正指摘なし。MCPからPlanControl／Broker／Store／WorkerRuntime、相談・wake、有限timeoutの接続を確認した。レビュー担当はテストを再実行せず、後から追加した文書も評価対象外としたため、実行結果と文書は実装担当が別途確認した。実機受入、取消・superseded後の保留置換、中断thread履歴も対象外として後続工程へ引き継ぐ。

自己レビューでは操作ID・revisionの再照合、停止前の人数計上、unknownでの全体フェンス、人のcallbackと正式approval RPCの分離、元attemptの結果保存、Git・成果・未コミットデータ・予約の保全を確認した。追加のDB migration・依存・権限設定・自動モデル送信・未解放lockはない。

実装・検証・自己レビューを終え、工程表のMC-03の5項目、MC-04の5項目、5.4節の3つの結合確認をチェックした。最終のチェック記録は文書変更だけなので、参照と差分を確認し、同じ全体テストを繰り返さない。commit SHA・元ブランチへの反映・push結果は完了報告とledgerに記録する。

実モデル、実UI、通常の実行承認ゲート、OS sandboxの新規実機受入は`not_run`。通常profile・認証・専用環境manifest／snapshot・既存runを変更していない。MC-05以降とMC-12の実機受入を先取りしない。日英READMEと運用リファレンスを更新する。ログ・ledgerは本worktreeの`.local/mc04b/`に保持する。
