# MC-04a: タスク保留・実行枠管理

2026-11-17（日本時間）。[元計画](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md)のMC-04aだけを対象とする。MCP接続とMC-03との結合受入はMC-04bに残す。

## 引継ぎと固定した契約

- 統合・実装担当は本作業のroot。起点はMC-02完了を含む`6c41c3f`、branchは`feat/mc-04a-task-holds`。専用worktreeで依存・dist・native出力を分離した。
- MC-02の現在PC対応表・証拠とDE-06／項目5の記録を確認した。通常の実行承認ゲート、別プロセスのlive resume、実UIの取消等の留保を維持する。
- DE-05の環境manifest／snapshot参照を読み、3runのlifecycleが`restored`、環境とauthの両leaseが不在であることを確認した。既存snapshot・設定・認証・実プロセスへ変更しない。
- 相談は既存`DecisionService`と実Storeを使う。`task_holds`行は回答・取消で削除されるため、実行保留の事実は既存`plan_task_state`のJSONに別途保存する。DB schema、共通の`TaskHold`、相談・正式approval RPCの契約は変更しない。

## 実装と次工程の呼出し順

1. `PlanControl.holdTask(ref, taskId, decisionId)`で同run・現行plan・対象taskのpending blocking相談を照合し、保留を保存する。操作IDとrevisionを既存の原子的操作へ結び付ける。非blocking相談はholdに変換しない。
2. attemptが存在する場合は`Broker.parkTask(runId, worker)`を呼ぶ。既存`WorkerRuntime.stop`によるturn中断・native Job空確認・host終了確認を使い、確認できたattemptだけ実行枠を解放する。未知・owner不一致では解放せず、既存の安全停止へ戻す。未割当タスクは停止対象を持たないため最初から枠を消費しない。
3. 回答保存だけでは再開しない。`PlanControl.resumeTask(ref, taskId, resolvedDecisionId)`が全保留相談の回答、plan、終了identity、未解決の正式RPC、Gitとworktree予約を再照合して`resume_ready`にする。その後の通常割当でも再照合する。
4. 同じworktreeを新attempt・新threadに割り当てる。旧WorkerRefへの新規指示と成果受入を拒否する。既存operationの再読取は配送を繰り返さない。

保留中のscope・競合資源・履歴継続先worktreeは、実行枠の解放後も予約する。独立タスクだけを実行可能にする。未コミット変更は保存し、dirtyなままの再開は拒否する。停止確認がunknownなら既存の全体停止へ戻し、親wakeのフェンス・stop_generation更新・他attemptの停止も行う。通常の全体停止・タブ閉鎖の意味は維持する。

保留中に独立タスクが統合されても、再開対象のbranchへその変更を取り込む必要はない。元base・宣言済み依存・clean状態を照合して再開する。統合worktreeの検証と最終SHAに全入力を含める検証は維持し、別タスクの変更を再開対象のscopeへ混入させない。

## 実装上の判断

- 現行の`DecisionAnswer`には回答の承認意味を示すフィールドがない。自然文や任意のoption IDから許可を推測せず、現行計画の相談に対する`optionId: resume`のみを明示的な再開回答とする。自由記述を伴う回答、否定、取消、superseded、仕様変更相談では再開しない。MC-03／04bのフォームはこの選択肢を明示し、修正案は新相談／MC-08の計画改訂へ戻す。呼出し側がこの選択肢を提示する必要がある。
- 保留の原因となった相談を新相談で置き換える対応付けは、この工程では追加しない。否定・取消済み相談を新しい回答で上書きして再開できるとは扱わず、後続の明示的な改訂経路で解決する。
- 中断済みthreadの履歴継続はMC-10の接続範囲。MC-04aではGit成果を保持して新threadへ明示的に再割当する。会話の連続性はこの工程の保証に含めない。
- `src/workers.ts`は既存の停止確認をそのまま再利用するため変更不要。READMEの通常操作や設定は変わらず、README更新は不要。

## 検証

変更前の対象5ファイルは70/70成功。保留枠・資源予約のテストと未実装APIでREDを確認し、履歴継続からの予約worktree再利用、未割当タスクのGit初期化前再開でも個別にREDを確認した。

新規テストは安全な枠解放、非blocking相談、回答と停止の競合、取消／否定／自由記述、古いplan／成果、dirty Git、複数相談、未知停止／owner不一致、同じworktreeの予約、broker再起動を扱う。native fixtureではAのJob・host終了とmarker停止、Bのmarker継続を同時に確認する。実モデル・実UI・OS sandboxの追加受入は`not_run`。

独立した読取りレビューでImportantが2件（unknown停止時の全体フェンス、独立統合後の保留再開）見つかった。両方を実Store／GitによるテストでRED確認後に修正し、2/2のGREENを確認した。Critical／Minorは0件。MCP接続・認証の結合、中断thread履歴、自然文の許可意味、実機受入はレビュー対象外として上記の範囲へ明示的に引き継ぐ。最終テスト結果は実装担当が別途確認する。

最終検証は次のとおり。

| 検証 | 結果 |
|---|---|
| `npm.cmd run build:native` | 成功。専用worktreeのnative／MockCodexを使用 |
| `npm.cmd run typecheck`、`npm.cmd run build` | 最終コードで成功 |
| 元計画指定の5ファイルの`node --test` | レビュー修正前82/82。レビュー修正2件は個別RED→GREENを追加し、最終制御全体で再検証 |
| `node --test --test-concurrency=1 test/*.test.mjs` | 42/42成功 |
| `npm.cmd run test:control` | 最終コードで258/258成功。元計画指定5ファイルとレビュー修正を含む |
| `npm.cmd run test:terminal` | 14/14成功 |
| `git diff --check` | 成功 |

最終の通常・制御・端末テストは合計314件成功。標準`npm.cmd run verify`はnative／型／build成功後、既存の`malformed_or_disconnected_display_client_does_not_stop_worker`が一時ディレクトリ削除のEPERMで失敗し、通常41/42で終了した。これはMC-02にも記録された既存の失敗で、標準verify全体の成功とは扱わない。通常テストを直列で再実行して42/42、制御・端末は上記の別コマンドで確認した。timeout・停止条件・安全性を弱めていない。

自己レビューでは、停止確認前の枠解放、回答保存だけでの配送、取消・古い計画・旧attemptからの成果受入、保留worktreeの横取りがないことを確認した。unknown時は全体停止へ戻り、独立統合後も元タスクのscopeと最終SHA検証を維持する。transactionの失敗時は操作と保留変更がロールバックする。元checkout、未コミット成果、既存証拠、認証・設定、回数上限、既存の全体停止を変更していない。

MC-04aの実装・検証・自己レビューは完了。MC-04bのMCP接続と5.4節の結合受入は未実施で、MC-04全体の完了にはしない。README更新はなし。ログ・RED／GREEN・ledgerは専用worktreeの`.local/`に保持する。Gitのcommit SHAとpush先・結果は完了報告とledgerに記録する。
