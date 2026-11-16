# Codex拡張＋子CLI・統合ターミナルによる連続実装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement the explicitly requested stage. Steps use checkbox (`- [ ]`) syntax for tracking. 今回は計画・設計・READMEの改訂のみ。後日の工程実装依頼では、その工程の実装・必要な検証・自己レビューまで完了し、別工程へ勝手に進めない。一般的な承認手順だけを理由に承認済み範囲で停止しない。

**Goal:** 普段のCodex拡張の親が、独立した子CLIへ工程を割り当て、VS Code内の統合ターミナルで進行確認・停止を行い、報告から再開してGit成果を受け入れられるようにする。

**Architecture:** 親用中継と一つのNode管理プロセスを残し、子ごとに専用native hostとCodex App Serverを所有する。小さなVS Code補助拡張はログ・状態のターミナル表示と停止を担当し、子への直接入力は実装しない。工程の判断とGit統合は親AI、配送・依存条件・永続記録・停止確認はプログラムが担当する。

**Tech Stack:** Windows x64、C#／.NET Framework標準API、Node.js 24.22.1以上、TypeScript、公式MCP SDK 1.32.2、zod 4.6.7、Node組込みSQLite、VS Code標準Terminal/Pseudoterminal API、`node:test`、PowerShell。VS Code型定義・TypeScript・yamlは必要な工程で互換性確認後に固定する。

**Spec:** [設計書 revision 2](../specs/2026-11-15-codex-chat-control-design.md)。改訂日2026-11-15（日本時間）。変更前の計画はGitの`51c2dbc`に保存され、旧[CC-00結果](../../validation/chat-control/CC-00.md)と証拠は変更しない。[旧調査](../../validation/chat-control/report.md)のA/B/C判定を新方式の成立へ読み替えない。

## Global Constraints

- 親は通常のCodex拡張、子は担当別の独立CLI App Server。子の通常Codexパネル、TUI、外部terminal window、子への人の直接入力は初期版に含めない。
- 統合ターミナルはログ・状態・停止用。親の指示はMCPと構造化RPCで送り、文字入力・貼付け・`sendText`から子を操作しない。人の承認専用UIは直接CLI入力とは別に実装する。
- 新工程は新しい子を既定とし、親が修正継続を明示した時だけ同じ履歴を再利用できる。プロセスを使い捨てても、未コミット変更・worktree・Git成果・報告・実行記録を自動削除しない。
- 親用中継は親再開・実呼出し元照合のために残す。子を親App Serverへ作らず、子停止で親の共有jobをkillしない。
- 本物のCodexとNodeは明示した絶対パス・版・hashを記録する。PATHの旧版や最も新しそうなexeを選ばない。親拡張のhandshake・承認・権限設定を書き換えない。
- 子ごとに専用jobを所有し、suspended作成→所属確認→実行とする。jobへの所属だけで公式sandbox／実行サービス配下のコマンド停止まで保証しない。実機の追記停止と所有identityを確認する。
- 停止猶予3秒、強制終了後の確認上限5秒、500 msマーカーの無増加観測2秒を初期値とする。停止確認不能は`unknown`、runは停止維持とし、次工程・同じworktreeの再利用を禁止する。
- 人が実行中の子タブを閉じたら、新規配送・親wakeを先に禁止して対象子を止める。兄弟は現在turnの完了と報告保存まで可能。全体停止と親UI停止は全管理対象子を止める。完了タブの閉鎖・パネル非表示・タブ切替はrun停止にしない。
- 初期同時実行は子2件、親は別枠。通常監視でモデルを呼ばず、完了・失敗・質問・人の承認待ちの時だけ親を再開する。MCP通知やterminal表示だけを親再開としない。
- 親・子の実metadataとnativeが確認した接続元を照合する。本文やツール引数で身元・役割を宣言させない。登録外thread、別owner/epoch、内部サブエージェントの自己昇格を拒否する。
- ChatGPTの正式な認証経路を使い、APIキー課金へ暗黙に切り替えない。人の承認・OS承認・ログインを親AIが代行しない。対応UIがない要求は保留／未対応にして止める。
- 管理DB・credential・discovery情報は利用者の管理領域。repo／argv／モデル出力へ秘密を出さない。raw通信・認証応答・全会話履歴を証拠へ複製しない。
- Gitは子ごとのworktree／branchと親専用integration worktree。main/protected branchへの直接push、force-push、利用者の未コミット変更破棄を既定にしない。既存の別Meristemと旧証拠は保持する。
- VS Code終了後の実行継続・自動起動・terminal自動復元は初期版の保証外。管理接続喪失時は停止へ寄せ、再起動後は照合と明示再開を要求する。

## Review Focus

| 条件 | 必要な挙動 | 試験を置く工程 |
|---|---|---|
| タブ閉鎖・host死亡・broker EOFの直前にshellが孫を起動 | 所有する子だけを停止し、追加マーカーなしを確認。親・兄弟・対照Dは生存 | CC-00R / CC-01 |
| terminalへの貼付け・OSC/ANSI・大きなログ・遅い描画 | 子へ入力を送らず、秘密や制御列を表示せず、RPC読取りを詰まらせない | CC-00R / CC-02 |
| 親終了直前の報告、人の同時入力、停止直後の遅延報告 | 報告を保持し、二重起動・意図しないsteer・停止後wakeをしない | CC-03 |
| 再起動・PID再利用・同名terminal・同じthreadの別attempt | owner/epochと作成identityで照合。不明結果を再送せず、別対象を停止しない | CC-01 / CC-02 |
| 承認フォームの重複回答、報告後変更、統合時の競合 | 元要求を一度だけ解決し、candidate/integration SHAを分けて再検証する | CC-04 / CC-05 / CC-06 |

## 1. 現状と工程の順序

| ID | 状態・成果 | 依存 | 実機の出口 |
|---|---|---|---|
| CC-00 | 旧共有App Server中継の実証を実施済み。採用保留の履歴 | なし | [結果](../../validation/chat-control/CC-00.md)を保持。子の通常パネル方式は再実装しない |
| CC-00R | **受入完了（専用fixture構成）** | 旧CC-00の事実 | 子CLI分離・統合ターミナル・実コマンド停止・親再開入口・metadataの再実証 |
| CC-01 | **実装・検証完了（管理fixture／無推論実CLI）**。永続記録・登録・停止・再照合 | CC-00R合格 | [結果・確認範囲](../../validation/chat-control/CC-01.md)。切断・再起動でも停止と不明結果を保持 |
| CC-02 | **専用fixtureの実機受入完了**。親／子MCPとterminal表示を製品契約へ接続 | CC-01 | [結果](../../validation/chat-control/CC-02.md)。B・再開Aの報告、A履歴想起、親最終読取と正常終了を確認。過去の起動・切断原因は未特定 |
| CC-03 | **専用fixture受入完了**。親を休ませた連続運転 | CC-02 | [結果](../../validation/chat-control/CC-03.md)。非表示での連続2工程・最終確認、active／idle／親タブ閉鎖／VS Code終了を別試行で記録。正式承認は人が操作。VS Code終了は生存する指示待ちの子で確認 |
| CC-04 | **対応APIの専用fixture受入完了**。質問・正式elicitation・フォーム失効を追加 | CC-03 | [対応表・残作業](../../validation/chat-control/CC-04.md)。全6項目を検証。未対応APIと試行上の制約を記録 |
| CC-05 | **実装・ローカルbare remote fixture検証完了**。工程表と直列Git | CC-04の対応結果を記録 | [結果と制約](../../validation/chat-control/CC-05.md)。新担当・修正attempt・候補／統合受入。実モデル／GitHub試験は未実施 |
| CC-06 | **完了（専用ローカルremoteで実機受入）**。子2件の並列作業と統合 | CC-05 | [結果・確認範囲](../../validation/chat-control/CC-06.md)。タブ・プロセス・worktree分離、競合解消と統合後検証。GitHub統合pushは別確認 |
| CC-07 | **完了（専用環境で総合受入）**。スキル・導入・復元 | CC-06 | [結果](../../validation/chat-control/CC-07-continuation.md)。直列／並列、通常親UI、正式承認、GitHub readback、設定復元。通常profile導入・公開配布は別操作 |

CC-00の成功項目をCC-00Rの合格へコピーしない。新方式の停止・terminal連携・親再開の入口が不成立ならCC-01へ進めない。承認UIだけが非対応の場合は、無権限の後続試験を行える条件を記録できるが、承認が必要な実操作を成功stubや暗黙許可で通さない。

### 共通の検証運用

通常テストは偽Codex・偽MCP・VS Code API adapterのfixtureとローカルGitだけを使う。実モデル／GitHubを通常testへ混ぜない。各工程は失敗するテスト→最小実装→関連テスト→必要な実機条件→自己レビュー→証拠とcommit/pushを一単位とする。必須検証後、変更や未解決懸念がなければ反復しない。

CC-00Rの実子CLI入口は`direct-probe.mjs --live --case preflight|shell`と`direct-suite.mjs --live --case acceptance`。本物のexe、専用fixture root、認証home、evidence出力先を必須にし、モデル試験には承認済み台帳を追加する。`terminal-probe.mjs`のmock/UI経路と旧`relay-probe.mjs`を履歴として保持する。具体的な引数はREADMEを参照。CC-01とCC-02の無推論preflightは`powershell.exe -NoProfile -File scripts/run-live.ps1 -Case CC-01|CC-02 -Live`を実装済み。CC-02のモデル受入は専用`test/live/cc02-prepare.ts`／`cc02-session.ts`を使用する。CC-03は`test/live/two-stages.ts`を実装済み。CC-04は`test/live/approval-roundtrip.ts`を実装済み。CC-05はローカルGit fixture、CC-06は `test/live/parallel-merge.ts` のローカルfixture／専用実機runnerを実装済み。

未認証・ネットワーク制限・UI未接続なら`not_run`。実VS Code操作はその時点のComputer Useスキルと共通READMEに従う。正式な接続・承認がなければ利用者操作で確認し、未観測の画面を合格にしない。制限や実行ポリシーは変更して回避しない。

## 2. ファイルと責任

| 場所 | 改訂後の責任・初出 |
|---|---|
| `native/Program.cs`, `StdioRelay.cs`, `LocalPipe.cs` | 既存。親用通信、管理Nodeの別stdio、ACL付き接続元確認へ限定して変更 |
| `native/ProcessTree.cs` | 既存。所有job・handle継承・終了確認を共用。worker単位の所有を維持 |
| `native/WorkerProgram.cs`, `native/WorkerHost.cs` | 新規CC-00R。子Codexを所有する専用exeの入口・停止・接続EOF処理 |
| `extension/package.json`, `extension/tsconfig.json`, `extension/src/extension.ts` | 新規CC-00R。補助拡張の起動・コマンド・終了。既存Codex拡張は変更しない |
| `extension/src/control-client.ts`, `extension/src/terminal.ts` | 新規CC-00R。明示owner接続、ターミナル表示、閉鎖／停止通知、入力を渡さない |
| `src/contracts.ts`, `src/protocol.ts`, `src/workers.ts`, `src/terminal-events.ts` | CC-01で製品化。識別・API変換・worker寿命・表示用イベントの許可項目 |
| `src/broker.ts`, `src/store.ts`, `src/cli.ts`, `migrations/001-control.sql` | CC-01。単一writer・状態・停止・ローカルCLI |
| `src/mcp.ts`, `src/actors.ts` | CC-02。公式SDK、実metadataと起動元の照合、役割制約 |
| `src/wake.ts`, `src/requests.ts`, `extension/src/approval.ts` | CC-03/04。親再開、質問と正式承認、承認専用modal |
| `src/plan.ts`, `src/git-evidence.ts` | CC-05。計画領域、依存条件、Git事実、生成進捗 |
| `spikes/chat-control/terminal-probe.mjs`, `test/worker-host.test.mjs`, `extension/test/terminal.test.ts` | CC-00R。新方式の専用実証とfixture。仮brokerは試験scopeだけ |
| `test/live/*.ts`, `scripts/run-live.ps1` | CC-01以降。明示した実Codex・実VS Code・試験GitHub受入 |
| `scripts/build-native.ps1`, `scripts/install.ps1`, `scripts/uninstall.ps1` | buildは既存を拡張、install/uninstallはCC-07。変更キーと前値だけを復元 |
| `skills/codex-chat-coordination/SKILL.md`, `references/plan-and-report.md` | CC-07。実装済みツールに対応する親／子の運用 |
| `docs/validation/chat-control/CC-00R.*`, `CC-01.*`〜`CC-07.*` | 新証拠。旧`CC-00.*`・旧planning記録は上書きしない |

CC-00Rで補助拡張のbuild・型検査・testを用意し、ルートの検証コマンドに接続する。既存MCP SDK/zodのlockは再利用する。新しい依存はその工程で必要なものだけ導入する。CC-00Rの仮brokerを永続化や権限確認の完成品として公開しない。

## 3. 共通契約

### 識別・状態・寿命

- `OwnerRef = { ownerId: string, ownerEpoch: string }`。親用relayと各worker hostがそれぞれ持つ。
- `ActorRef = OwnerRef & { threadId: string }`。親／担当rootを特定する。
- `WorkerRef = ActorRef & { workerId: string, attemptId: string }`。同じworker/threadを再利用しても、再起動で新owner/epoch・attemptへ更新する。
- `TerminalBinding = { windowBindingId, terminalId, worker: WorkerRef }`。表示名・PIDだけでは停止先を選ばない。
- `CallerIdentity = { actor: ActorRef, turnId: string }`。nativeが確認した接続元と実MCP metadataから作る。`CallContext = CallerIdentity & { role: 'parent' | 'worker', runId: string }`は確認済みbindingから導出し、ツール引数では受けない。
- `RunPermit = { bindingId, parent: ActorRef, planHash, repositoryId, branchScope, confirmedAt }`。人の正式な一回限りのbinding。子の自己昇格、別repo・親への流用は禁止。
- `AgentChoice = { model: string, effort: string }`。実catalogで送信直前に検証する。
- `OperationRef = { operationId: string, runId: string, expectedRevision: number }`。同じID・同じpayloadは保存済み結果、異なるpayloadは拒否。
- `StopResult = { worker: WorkerRef, state: 'interrupt_requested' | 'stopping' | 'stopped' | 'unknown', evidenceRefs: string[] }`。
- run: `active / stopped / needs_reconcile / completed`。task: `pending / assigned / running / waiting_approval / waiting_input / candidate_ready / accepted / failed / interrupted / unknown`。操作配送: `prepared / sent_unknown / acked / settled / cancelled`。

`turn/completed`、terminal終了、process終了、工程受入は別。正常な報告とturn終了後はworkerを後始末し、停止確認不能なら候補を確定しない。正常完了によるhost解放はrun停止へ変換しない。人のタブ閉鎖・停止ではrunの新規配送とwakeを止める。

### MCPの公開面（CC-02）

| ツール | 入力の概要 | 呼出し元と効果 |
|---|---|---|
| `start_run` | `planPath`, `operationId` | 親候補。人のbinding後にrunを作る |
| `create_worker` | `OperationRef`, `taskId` | 親。専用host・root thread・ログタブを作り`WorkerRef`を返す |
| `send_instruction` | `OperationRef`, `taskId`, `target: WorkerRef`, `agent: AgentChoice`, `text` | 親。対象workerのidleと試行を検証して送る |
| `get_status` | `runId`, `taskId?`, `afterEventSeq?` | 親／該当子。モデルを起動せず、状態・停止確認・イベントを返す |
| `report` | `OperationRef`, `taskId`, `report` | 主担当子。送信者は実身元から決める |
| `answer_request` | `OperationRef`, `requestKey`, `answer?` | 親。質問へ回答。権限承認は人の正式UIへ移り、`answer`で許可を代用しない |
| `record_decision` | `OperationRef`, `taskId`, `decision`, `evidenceRefs` | 親。再試行、履歴継続、新担当、候補／統合受入、休止、終了の判断を記録 |
| `stop_worker` | `OperationRef`, `target: WorkerRef` | 親。対象子の停止とrunの新規配送抑止 |
| `stop_run` / `resume_run` | `OperationRef` | 親。全体停止／照合済みの明示再開 |

旧計画の未実装名`create_chat`は`create_worker`へ変更する。既存の公開製品APIの変更ではない。terminal閉鎖・ローカル停止CLIは、人の操作として同じbroker停止処理へ入る。子は他workerの作成・指示・停止、親登録、受入判断を行えない。

計画parser、worktree自動作成、Git受入はCC-05で有効化する。CC-02は明示した試験fixture scopeだけを使う。未実装機能を成功stubとして公開しない。

## CC-00: 旧方式の実施記録（再実装対象外）

旧構成は共有App Server上の通常子パネルを第一希望とした。`51c2dbc`に実装・16件のfixture検証・実機結果を保存済み。UI停止後もコマンドが継続したため、新構成の合格証拠には使わない。元の詳細な工程と[結果](../../validation/chat-control/CC-00.md)、[UI証拠](../../validation/chat-control/CC-00.ui.evidence.json)を保持する。

## CC-00R: 専用子CLIと統合ターミナルの接続・停止を実証する

**Files:** Create `native/WorkerProgram.cs`, `native/WorkerHost.cs`, `extension/package.json`, `extension/tsconfig.json`, `extension/src/extension.ts`, `extension/src/control-client.ts`, `extension/src/terminal.ts`, `spikes/chat-control/terminal-probe.mjs`, `test/worker-host.test.mjs`, `extension/test/terminal.test.ts`。Modify 既存native、`test/fixtures/MockCodex.cs`, `scripts/build-native.ps1`, `package.json`/lock。Evidence `CC-00R.*`。

**Interfaces:** 試験用`probeStart({ cwd, agent }): Promise<WorkerRef>`、`probeStop(worker: WorkerRef): Promise<StopResult>`。補助拡張は`connect(binding: OwnerRef): Promise<ControlConnection>`、`openWorkerTerminal(binding: TerminalBinding): Terminal`、`publishWorkerEvent(event): void`。この工程の管理接続は専用profileの明示fixtureのみ。DB・製品向けMCP変更操作はまだ作らない。

`ControlConnection`は`readEvents(afterSeq, limit)`、`getStatus(worker: WorkerRef)`、`stop(binding: TerminalBinding)`、`dispose()`だけを持つ。readEventsは`{ events: DisplayEvent[], lastSeq: number }`、getStatusはcwd/branch/AgentChoice/現在状態、stopはStopResultを返す。`DisplayEvent = { seq: number, worker: WorkerRef, text: string }`とし、publishWorkerEventは同型だけを受ける。表示接続にworker作成・指示送信の入口を渡さない。

- [x] `dedicated_worker_stop_spares_parent_peer_and_control`、`suspended_child_does_not_run_before_job_assignment`、`host_exit_or_broker_eof_stops_descendants`、`interrupt_ack_is_not_process_stop`を偽Codexと独立したマーカーで失敗させる。親・A・B・対照Dの所有単位を分け、A停止後も他のマーカーが増えることをassertする。
- [x] worker hostを既存ProcessTreeで実装する。子のRPC stdioと停止／状態用の制御を分け、broker EOFやhost異常終了でも専用jobを閉じる。nativeのACL実装は既存LocalPipeへ集約し、限定handlerで再利用する。同時接続は最大16件とし、`terminal_client_does_not_exclude_mcp_or_stop_client`で表示接続が制御口を占有しないことを確認する。親App Serverとbrokerも別の所有単位で起動し、broker失敗後も親通常通信を残す。
- [x] `terminal_input_and_paste_never_dispatch`、`running_terminal_close_stops_only_bound_attempt`、`completed_terminal_close_is_display_only`、`hidden_panel_does_not_stop_worker`、`stale_terminal_binding_cannot_stop_new_attempt`をVS Code adapter fixtureで失敗させる。
- [x] 最小補助拡張でログ用Pseudoterminalを作る。タブ名・状態・cwd・branch・要求設定を表示し、`isTransient: true`とする。500 ms間隔・最大100件の有限pollでイベントを取得し、無期限購読でpipeを塞がない。入力handlerは子へ接続せず、閉鎖／停止commandだけを試験brokerへ送る。完了タブは残し、再起動時の表示復元は実装しない。
- [x] `terminal_logs_strip_control_sequences_and_secrets`、`large_or_slow_terminal_output_does_not_block_rpc`を失敗させ、allowlist・制御列除去を実装する。表示イベント64 KiB、未描画キュー1 MiBの上限と省略件数をassertし、最新状態は再取得で補う。rawプロトコルや認証応答をterminalへ流さない。
- [x] 親用中継の既存16テストを保ち、実管理IDの完全衝突・途中切断・形式変更での管理応答漏出を追加検証する。対象版の制約とhashを固定し、漏出や通常UI破壊が残る版を昇格させない。子用stdioには拡張IDとの多重化を持ち込まない。
- [x] `build:native`へ`CodexWorkerHost.exe`とfixtureのbuildを追加する。補助拡張は`extension/tsconfig.json`でsrc/testをdistへcompileし、ルートに`build:extension`・`typecheck:extension`・`test:terminal`を定義する。`test:terminal`は`node --test extension/dist/test/terminal.test.js`を実行する。
- [x] `powershell.exe -NoProfile -File scripts/build-native.ps1 -OutputDirectory .local/chat-control-build -WithFixtures`、`npm run typecheck:extension`、`npm run build:extension`、`node --test test/relay-spike.test.mjs test/worker-host.test.mjs`、`npm run test:terminal`を実行する。Expected: 全件PASS、実モデル呼出し0件。
- [x] 新runnerへ`--live`・case・実exe・fixture root・証拠出力先を必須化する。専用VS Code profileで親Pと子A/Bを用意し、A/Bを別cwdの専用App Serverへ作る。子が通常Codexパネルに出ることは試験条件にしない。
- [x] 実catalogからmodel/effortを選び、子Aへの送信・同じ履歴への追加依頼を確認する。ターミナルに表示した指定値、返却設定、対象turn、実効値未確認を区別する。無効値とbusy中の指定も分類する。
- [x] 旧失敗を再現する実shellと孫プロセスの追記を、通常の公式sandboxのまま開始する。Aタブ閉鎖／明示停止で追記と所有プロセスが止まり、P・B・Dが続くことを確認する。さらにbroker EOF・host強制終了・VS Code終了を別fixtureで試す。RPC中断や窓の消失だけを合格にしない。
- [x] 親Pの最終応答後、試験brokerに保存した子結果から親用中継経由でPの新ターンを一度開始し、通常UIを確認する。実MCP metadataと各所有job/接続元・root threadの相関も記録する。これはCC-03の無人2工程達成ではない。
- [x] 専用profileを復元し、試験所有プロセスの不在・対照の後片付けを確認する。`CC-00R.md`とevidenceへ、合格／不成立／未実施を保存する。旧CC-00証拠は更新しない。親UI再開の復元に加え、追加試験の設定復元・全25個の専用profileプロセス不在も確認済み。

**Done:** 実VS Code内で子のログ・停止を扱え、実Codexが始めたコマンドを所有単位で止められる。子の作成・履歴継続、親再開入口、呼出し元相関が新構成で確認できる。未解決の停止・身元・中継漏出があれば方式を再検討し、CC-01を実装しない。

**実施状況:** CC-00Rの13項目を受入済み。実shell/孫プロセスに対してタブ閉鎖・明示停止・broker EOF・host強制終了・VS Code終了を確認し、A停止後もP/B/Dが継続した。子の同履歴継続、親/子MCPのJob・root thread・turn相関、前回の通常親UI再開を個別証跡で確認。今回追加12枠は全数計上済み（正常完了11、完了未確認1、残り0）。最終版はnative build・root 33 tests・terminal 12 tests・型検査・実CLI無推論preflightをPASS。実モデル停止時と最終版のhash、試験後の修正範囲を分けて記録した。CC-01の実装・検証結果は次節を参照。[実施結果](../../validation/chat-control/CC-00R.md)、[専用子CLI受入証跡](../../validation/chat-control/CC-00R.direct-acceptance.evidence.json)、[親UI再開証跡](../../validation/chat-control/CC-00R.parent-wake.evidence.json)を参照。

## CC-01: 永続記録・登録・停止と再照合

**Files:** Create `tsconfig.json`, `src/contracts.ts`, `src/protocol.ts`, `src/workers.ts`, `src/terminal-events.ts`, `src/broker.ts`, `src/store.ts`, `src/cli.ts`, `migrations/001-control.sql`, `scripts/run-live.ps1`, `test/store.test.ts`, `test/broker.test.ts`, `test/workers.test.ts`。Modify CC-00Rのnative/補助拡張とpackage/lock。Evidence `CC-01.*`。

**Interfaces:** `Store.prepareOperation(ref, payloadHash): PreparedOperation`、`Store.appendEvent(event): EventRef`、`Broker.dispatch(context, command): Promise<ControlResult>`、`WorkerRuntime.start(assignment): Promise<WorkerRef>`、`WorkerRuntime.stop(worker, reason): Promise<StopResult>`、`WorkerRuntime.releaseCompleted(worker): Promise<StopResult>`。最後の操作は正常完了の後始末でありrun停止ではない。

- [x] `deduplicates_operations_and_rejects_changed_payload`、`ack_loss_is_unknown_without_resend`、`stale_epoch_or_reused_pid_cannot_control_worker`、`late_stop_does_not_kill_new_attempt`、`completed_release_does_not_stop_run`を失敗させる。
- [x] runs/tasks/actors/assignments/attempts/operations/events/requests/wake_deliveriesを単一SQLite writerで保存する。unknown schema・二重writerを拒否する。revisionと操作をtransactionで確定し、その後外部I/Oへ進む。`build/typecheck/test/verify`を定義し、verifyへnativeと補助拡張の必須検証も含める。
- [x] owner/job/プロセス作成identity/terminal binding/root thread/cwd/repoを登録する。nativeでpipe接続元PIDと作成identity・job所属を確認し、実metadataとの照合に渡す。別window・過去attempt・内部threadの自動登録をしない。
- [x] `child_cannot_read_control_state`、`auth_payload_is_not_persisted_or_rendered`、`forged_worker_peer_cannot_control_parent`を追加する。管理領域とdiscovery/credentialをworktree外の保護領域へ置き、実permission profileからの拒否を確認する。同一ユーザーACLだけでsandbox隔離済みとは扱わない。
- [x] `manual_child_close_blocks_dispatch_and_wake_but_spares_peer_turn`、`parent_ui_stop_and_stop_run_stop_all_owned_workers`、`stopped_run_ignores_late_reports`、`unknown_cleanup_blocks_worktree_reuse`を失敗させ、停止世代を先に永続化する。タブ閉鎖と停止CLIを同じ処理へ接続し、停止状態と各子の終了確認を分ける。
- [x] terminal閉鎖の停止通知とlease切断を使い分ける。補助拡張全体の接続喪失はrun停止→全worker後始末へつなぐ。broker突然死・native EOFでもjob終了を確認し、次回起動で`needs_reconcile`にする。VS Codeのdeactivate callbackだけに後始末を依存させない。
- [x] `node dist/src/cli.js stop --run <id>`と`status --run <id>`を用意する。モデル停止中でも人が全体停止と終了確認を見られるようにする。認証切れ・上限・通常失敗・人の停止・不明結果を同一状態へ潰さない。
- [x] `npm run verify`とstore/broker/workers testsを実行する。実機はDB再起動・二重起動拒否・切断・停止後マーカーなしを確認し、uncommitted workを残してGit破棄がないことを確認する。

**Done:** terminalやprocessがなくなっても事実と停止状態が残る。未確認の終了・配送を自動再送せず、管理障害後も親の通常UIを使える。

**実施状況:** 既存33件・CC-01 31件・terminal 12件、型検査とbuildをPASS。Windows native管理接続、DB再起動、子／孫停止、親通信継続をfixtureで確認し、本物のCodexではモデル呼出し0回で管理領域read拒否・実root thread/profile・停止を確認した。実モデルが起動するshellと実VS Code GUIでの新managed経路は今回未実施。CC-01のdispatchは管理内部だけに限定し、実metadata由来のCallContextと公開変更ツールはCC-02で接続する。[結果](../../validation/chat-control/CC-01.md)、[証拠](../../validation/chat-control/CC-01.evidence.json)。CC-02以降へは進めていない。

## CC-02: 親・子MCPとterminalの接続

**Files:** Create `src/mcp.ts`, `src/actors.ts`, `test/mcp.test.ts`, `test/actors.test.ts`, `test/fixtures/mcp-client.ts`。Modify workers/protocol/broker/terminal-eventsと補助拡張。Evidence `CC-02.*`。

**Interfaces:** `resolveCallerIdentity(metadata, verifiedPeer, ownerBinding): CallerIdentity`、`resolveCallContext(identity, runBinding): CallContext`、上記MCP公開面。terminalイベントはbrokerの読み取り専用projection、停止は人のbindingに限定する。

- [x] `requires_actual_metadata_and_owned_peer`、`worker_cannot_control_peer_or_accept_result`、`worker_cannot_bootstrap_parent`、`run_permit_is_single_use_and_scope_bound`、`cross_repo_or_cross_window_is_rejected`を失敗させる。引数のcaller/roleで回避できないことを確認する。
- [x] 正式なelicitationまたは`node dist/src/cli.js authorize --binding <id>`から、人が実親ID・計画hash・repo・branch範囲を確認する。CC-05前はfixture scopeだけを受け付ける。permitがない状態で子作成・指示・Git変更を行わない。
- [x] `create_worker`、`send_instruction`、`get_status`、`report`、停止／再開を型付きbroker commandへ接続する。未実装の計画parser・Git受入・質問配送は成功として公開しない。SDKのstdoutをプロトコル専用とする。
- [x] `rejects_invalid_model_effort_before_send`、`completed_worker_history_can_resume_in_new_owned_attempt`、`unknown_attempt_is_not_replayed`、`subagent_report_is_not_main_worker_report`を失敗させる。catalogを実送信直前に照合し、provider変更や別cwdを拒否する。再利用では前attemptの後始末とidle/cleanを確認し、新しいWorkerRefを返す。
- [x] terminalへactor・attempt・状態・要求設定・安全な進行イベントを投影する。現在の状態と古いログを区別し、closeの重複・programmatic dispose・自然終了で同じstopを二重実行しない。遅い描画と入力非転送の回帰を確認する。
- [x] `npm run verify`とmcp/actors/terminal testsを実行する。実親Pから子A/Bを使い、同じAの修正・新attemptでの履歴再開・宛先混同なし・設定照合・報告取得を実機で確認する。

**Done:** 親から登録した子CLIだけを操作でき、ターミナルは表示と人の停止に限定される。同じ履歴を使っても身元・attempt・Git状態の確認を省かない。

**2026-11-15の初回結果（当時未完）:** 実親PからA/Bの作成・指示までは成立したが、子の`report`前に正式承認待ちとなった。未実装の承認配送を成功stub・暗黙許可で通さず停止したため、最後の実機受入とDoneは未達。CC-04に置いた正式承認配送の最小入口を先行させる等、依存の再調整が必要。今回CC-03／04へ自動着手していない。

**同日のレビュー・再受入（acceptance-03時点）:** 利用者が最小承認入口の先行実装を明示承認した。ローカルmeristemのreport/get_statusに対する人の一回限りの回答、元RPC/hash/世代照合と停止時失効を追加した。nativeのjob内helperによる身元偽装も、実App Server直下・固定Node/MCP入口・argvの照合で修正した。全fixture検証104件が成功。実A/Bの作成・指示・managed terminal表示まで再確認したが、connector専用metadataを誤って必須にした判定で子承認を未対応扱いにした。公式実装に合わせた修正と回帰試験を追加し、旧試験を停止・設定復元済み。修正版の報告と履歴再開の実証までは最後の受入を未完とする。CC-04全体、wake、Git受入へは進めない。

**同日の最終受入（acceptance-06）:** 専用fixtureの範囲でCC-02を受入完了。121件の検証と最終コードの無推論接続が成功し、実親PからA/Bへの指示、人のMCP承認、Bと再開Aの2報告、Aの同thread・新owner/epoch/attemptでの想起、3attemptの正常終了・job empty、親による最終読取を確認した。初回A報告はrevision競合で拒否され保存なし。実terminalの入力非転送は完了後に確認し、実行中はfixture検証。過去04/05の切断・起動失敗原因は未特定で、安定性や通常導入は保証しない。承認済みの累計21回を使用し、試験用設定を復元した。[結果と制約](../../validation/chat-control/CC-02.md)、[最終実機証拠](../../validation/chat-control/CC-02.acceptance.evidence.json)を参照。CC-03以降には進めない。

## CC-03: 報告時だけ親を再開する

**Files:** Create `src/wake.ts`, `test/wake.test.ts`, `test/live/two-stages.ts`。Modify broker/store/mcp/親relay。Evidence `CC-03.*`。

**Interfaces:** `enqueueWake(runId, sourceEventSeq): WakeRef`、`deliverWakeIfIdle(runId): Promise<WakeResult>`。一つの親/runへ集約し、既読seq・送信operation・停止世代を保存する。

- [x] `report_at_parent_finish_is_not_lost`、`duplicate_reports_coalesce`、`human_input_blocks_stale_idle_wake`、`active_turn_is_not_steered`、`wake_unknown_is_not_retried`、`stopped_run_never_wakes`、`idle_monitor_has_zero_model_requests`を失敗させる。
- [x] delta/terminal描画/heartbeatではモデルを呼ばず、完了・失敗・親への質問・人の承認待ちだけをwake候補とする。早いreportだけでworker完了にせず、正常turnと後始末を照合する。
- [x] 親relayの単一送信箇所で、人の入力・queue・pending startを先に登録し、owner/epochと状態seqで新ターン枠を予約する。run停止・不明delivery・別writerがあれば保留／非対応とする。標準queueと二重に送らない。
- [x] 親にはrun/event ID・短い集約・参照先を渡し、子本文を管理命令として扱わない。親再開12回・工程修正2回の上限を実装し、超過時に停止理由を残す。
- [x] 実機でPがAへ依頼して応答終了→A完了/後始末→Pが成果を確認→新しいBへ依頼→B確認を人手なしで通す。A失敗時はBを起動しない。親active/idle/非表示/パネル閉鎖と、VS Code終了を分けて記録する。
- [x] `npm run verify`とwake testsを実行し、監視区間のモデル要求0、実際の親turn開始、次の子開始を別々に記録する。新ターンの履歴入力まで0と主張しない。

**実施記録:** [CC-03](../../validation/chat-control/CC-03.md)、[表示状態別の実機証拠](../../validation/chat-control/CC-03.ui.evidence.json)。12で親非表示のまま連続2工程と最終確認、08でactive中の保留と親タブ閉鎖後の最終確認、11で生存する指示待ちAを残したVS Codeウィンドウ終了、04で失敗AからB未起動を記録した。正式な人の承認・表示／終了操作は含むが、A完了からB最終確認までの工程指示の追加入力はない。145件の最終検証が成功。過去試行の原因未特定の保留／起動失敗、終了後のDB要照合を保持し、通常運用の安定性やモデル生成中のGUI終了の保証には広げない。

**Done:** 親を推論ループで待たせず、実際の子結果から次工程へ進める。terminalに報告が見えたことだけでは合格にしない。

## CC-04: 質問と正式な人の承認

**Files:** Create `src/requests.ts`, `extension/src/approval.ts`, `test/requests.test.ts`, `test/live/approval-roundtrip.ts`。Modify mcp/wake/store/補助拡張。Evidence `CC-04.*`。

**Interfaces:** `RequestKey = ownerId + ownerEpoch + JSON-RPC requestId`、`PendingRequest = { key, actor, turnId: string|null, kind, payloadHash, state, formGeneration }`。質問、command/file/permissions、connector/app、MCP elicitation、認証、unknownを分類する。

- [x] `answers_original_question_id`、`model_cannot_supply_human_approval`、`approval_is_bound_to_request_hash`、`stale_or_duplicate_form_cannot_resolve_request`、`connector_consent_is_not_plain_question`、`mcp_timeout_keeps_source_pending`を失敗させる。
- [x] 普通の質問は親へ送り、元RPCに回答する。自然文でturnが終了した質問は次ターンとして扱う。`turnId=null`や相関不明を捨てて成功にしない。
- [x] 子に通常パネルがない前提で、親側の正式elicitationを主経路、補助拡張の承認専用modalを対応APIに限る人の代替経路にする。要求内容・cwd・権限・対象IDを表示し、フォーム回答を元hashと世代へ結び付ける。これはCLIへの直接入力機能にしない。
- [x] 元の公式reviewerやconnectorがその配送経路を認めない要求は、正式な元サービスのUIが使える場合だけ誘導し、なければ`waiting_approval/unsupported`で止める。「子Codexパネルへ戻す」前提を置かない。OS承認・ログイン・auto-reviewを代理／置換しない。
- [x] timeout/取消、期限切れ、元要求の解決、turn中断、重複フォームの競合を処理する。古い許可や`acceptForSession`の範囲を別attemptへ持ち越さない。人の新しい判断がなければ許可／拒否を作らない。
- [x] `npm run verify`とrequests testsを実行する。実Codexで質問・承認・拒否・取消・回答前停止を試し、`serverRequest/resolved`と実コマンド／成果物まで確認する。API別の対応表を作り、未対応を完了へ数えない。

**実施記録:** [CC-04](../../validation/chat-control/CC-04.md)、[実機証跡](../../validation/chat-control/CC-04.acceptance.evidence.json)。全162件とrequests単独15件が成功。専用fixtureで自然文質問から同履歴の次turnと成果ファイル、親側正式フォームのAccept/Deny/Cancel、回答前停止とjob emptyを確認した。対応APIに限定した受入であり、command/file/permissions・connector・認証等の未対応要求は完了に数えない。

**Done:** terminalが読取専用でも、質問と対応する正式な承認が正しい要求へ一度だけ届く。未対応の承認は停止したまま明記し、権限を要する後続工程を実行しない。

## CC-05: 工程表・報告と直列Git

**Files:** Create `src/plan.ts`, `src/git-evidence.ts`, `test/plan.test.ts`, `test/git-evidence.test.ts`, `test/live/serial-git.ts`。Modify broker/mcp/store。Evidence `CC-05.*`。

**Interfaces:** `readPlan(path): PlanSnapshot`、`eligibleTasks(snapshot, state): TaskId[]`、`verifyCandidate(taskId, report): Promise<CandidateEvidence>`、`writeProgress(planPath, expectedFileHash, projection): Promise<void>`。ここで計画受付とGit受入を有効化する。

工程表は`<!-- chat-control:plan:start -->`〜`<!-- chat-control:plan:end -->`の一つのYAML。`schema_version: 1`、runの`repository/worktrees_root/integration_branch/max_parallel`、taskの`id/depends_on/scope/conflicts_with/agent/continuation/completion`を必須とする。`continuation`は`{mode:'new'}`を既定、`{mode:'same',after:taskId}`、`{mode:'parent_decides'}`を明示指定とする。

- [x] `rejects_duplicate_ids_missing_dependencies_and_cycles`、`rejects_conflicting_parallel_resources`、`history_reuse_requires_cleanup_current_cwd_and_git_head`、`candidate_acceptance_does_not_release_dependencies`、`dependent_base_contains_all_integrations`、`plan_edit_freezes_new_dispatch`、`projection_preserves_user_prose`を失敗させる。
- [x] YAMLの型・schema・path・alias上限を検証し、custom tagを拒否する。全file hashと計画領域hashを分け、生成欄更新で計画版を変えない。改訂時は実行snapshotを保持し、親の照合前に次工程を始めない。
- [x] repo identity/origin/統合branchと作業範囲を固定し、引数配列と明示cwdでGitを呼ぶ。新規割当で無関係な既存branchやdirty worktreeを流用しない。同担当の継続だけは管理済み同repoのclean worktreeを検証して使える。子の完了やタブ閉鎖でworktreeや未コミット変更を消さない。
- [x] 報告schemaは`task_id/worker_id/attempt_id/actor_id/status/base_sha/candidate_sha/branch/push_result/summary/checks/remaining`。statusは`completed/failed/needs_input`、checksは検証名・command・結果・exit code・証拠参照を持つ。metadataと照合した主担当だけが報告できる。GitからSHA・clean・remote到達を別途確認し、push失敗を成功へ変換しない。
- [x] 報告＋対応する正常turn終了＋未解決要求なし＋worker後始末完了＋候補Git一致で`candidate_ready`にする。報告後の追加変更、正常turnでも残るプロセス、不明な終了は受入を保留する。
- [x] 親の`record_decision`に`retry_same / continue_same / handoff_new / accept_candidate / accept_integration / pause / finish`を保存する。同履歴の修正でも新attemptと更新WorkerRefを作り、前attemptの操作を再送しない。工程の意味判断schedulerや汎用build実行器を追加しない。
- [x] `accept_candidate`は候補固定だけ。検証した`integrationSha`を`accept_integration`で保存して初めて依存を解放する。次の`baseSha`が全先行integrationの子孫であることを`git merge-base --is-ancestor`で検査する。同履歴でもcleanとfast-forward/通常merge後の実HEADを確認する。
- [x] `<!-- chat-control:progress:start -->`〜`<!-- chat-control:progress:end -->`の生成欄だけをexpected file hash付きのtemp＋原子的置換で更新する。ローカルbare remoteで、新子A→親受入→同履歴の修正attempt→新子Bの引継ぎを通す。元workspaceをdirtyにした対照を保持する。
- [x] `npm run verify`とplan/git-evidence testsを実行する。実GitHubは明示した試験repoだけで別試験とし、ローカルbareの成功をGitHub成功にしない。

**実施記録:** [CC-05](../../validation/chat-control/CC-05.md)、[最終直列Git証跡](../../validation/chat-control/CC-05.serial-git.final.evidence.json)、[検証記録](../../validation/chat-control/CC-05.validation.json)。全191件のverifyと実Git＋ローカルbare remoteの直列fixtureが成功。新A→候補承認→同履歴の修正attempt→統合承認→新Bへの引継ぎとdirtyな元workspaceの保持を確認した。独立レビューで見つけた累積scope／worktree固有remoteの問題を修正済み。実Codex／VS Code／GitHubの新規受入ではなく、並列配送・通常導入は対象外。

**Done:** 新しい子を既定にしながら必要な履歴継続もでき、報告・後始末・Git・親判断に結び付けた直列工程を受け入れられる。

## CC-06: 子2件の並列とGit統合

**Files:** Create `test/parallel.test.ts`, `test/live/parallel-merge.ts`。必要な変更だけをplan/broker/workers/git-evidenceへ追加。Evidence `CC-06.*`。

**Interfaces:** `reserveAssignment(runId, taskId, actor): Assignment`は枠・依存・資源をtransactionで検査する。`IntegrationEvidence = { inputCandidateShas: string[], resultSha: string, checks: CheckResult[], acceptedByParentTurnId: string }`。

- [x] `limits_workers_to_two_and_blocks_dependencies`、`workers_have_separate_jobs_worktrees_branches_and_terminals`、`candidate_is_fixed_during_review`、`merge_requires_clean_integration_worktree`、`conflict_resolution_requires_new_sha_checks`、`closing_A_spares_B_but_blocks_new_dispatch`を失敗させる。
- [x] scopeと共有資源が重ならない2工程だけを親が並列開始できるようにする。同じ担当の同時turnや、内部サブエージェントを追加の主担当として数える処理を禁止する。
- [x] 子は各自branchへcommit/pushし、親は専用integration worktreeで候補SHAを固定して順次統合する。base変更・候補更新・dirty状態を検出したら保留する。
- [x] 実モデルfixtureで競合なしと実装上の前提が変わる競合を通し、親が意図を読んで解消し、両工程の受入条件と統合テストを実行する。マーカー削除だけで合格にしない。人しか判断できない仕様矛盾は質問へ戻す。
- [x] Aタブを閉じる試験でAの追加書込みなし、Bの現在turnと報告保存、runの後続/wake禁止を同時に確認する。停止で未コミット変更やbranchを破棄しない。
- [x] `npm run verify`とparallel tests、ローカルremoteの実モデル並列試験を実行する。GitHub統合pushは指定した非保護の試験branchだけで別確認する。

**Done:** 分離した子の成果を親が順次統合・競合解消・再検証できる。並列起動とterminal表示だけを成功条件にしない。

**実装補足:** `prepare_integration` でbaseと1〜2件の候補を固定し、並列受入の各checkを `checked_sha` で最終SHAへ結び付ける。`cancel_integration` はGitを変更せず準備の予約を解除する。機械的な割当は確認済み親のMCPから `PlanControl.reserveAssignment` に入り、単一writer transactionで検査・保存する。実モデル／UI／GitHubの未観測項目をfixtureの成功で置き換えない。

**実施記録:** [CC-06](../../validation/chat-control/CC-06.md)、[実機証拠](../../validation/chat-control/CC-06.live.evidence.json)、[検証記録](../../validation/chat-control/CC-06.validation.json)。全222件のverifyが成功。実親・実子でA/Bの統合、C/Dの意味上の競合解消と最終SHAでの再検証を完了。停止試験の担当名はE/Fとし、Eタブ閉鎖後の書込み停止とFの同じturnでの報告保存、未コミット成果の保持を確認した。Fのファイル追記は閉鎖前に終了しており、閉鎖後の追記継続はnative fixtureで別検証した。正式Git承認、人が読める承認表示、動的モデルcatalog照合も追加。過去のB再試行の応答元は未特定で、原因解決とは扱わず、新試行で表示・回答・要求経路を照合した。GitHub統合pushと通常導入は未実施。

## CC-07: スキル・導入・総合受入

**Files:** Create `skills/codex-chat-coordination/SKILL.md`, `skills/codex-chat-coordination/references/plan-and-report.md`, `scripts/install.ps1`, `scripts/uninstall.ps1`, `test/install.test.ts`, `test/live/acceptance.ts`。Modify `README.md`と補助拡張package。Evidence `CC-07.*`。

**Interfaces:** installは実装root・実exe・Node・補助拡張を検証し、設定の変更キーと前値だけを保存する。uninstallは現在値が導入値と同じ時だけ復元し、利用者の後の変更を残す。

- [x] 親の依存無視・成功自己申告の受入・別worker誤送信・停止後の再実行・未解決承認・統合後検証漏れを含むシナリオで不足を確認し、機械的な拒否をMCP側に置く。
- [x] 実装済みツールだけに対応するスキルを書く。親/子の役割、新しい子を既定とする割当、修正時の履歴継続、短い報告、親の休止、terminal状態、正式承認、候補/統合受入を記す。直接CLI入力を必要とする手順を書かない。
- [x] `install_preserves_unrelated_settings`、`uninstall_preserves_new_user_value`、`unverified_codex_upgrade_disables_management`、`vscode_restart_does_not_resurrect_stopped_worker`を失敗させ、profileの複製／復元から実装する。通常導入は実証結果を示した後の明示操作とする。
- [x] 補助拡張をローカル配布できる形でbuild/packageし、READMEへNode/Windows/VS Code条件、正式ログイン、親用中継、試験profile、開始・状態・子停止・全体停止・照合再開・戻す方法を記す。terminalは読取専用であり、タブ非表示と停止、表示終了とprocess停止を区別する。
- [x] 実工程表で直列新担当、同履歴の修正、新担当への引継ぎ、並列統合、失敗、親再開、質問/対応する承認、停止後の遅延報告、broker再起動、補助拡張再読込みを確認する。子の通常スキルと内部サブエージェントも一例確認する。
- [x] `npm run verify`、スキルfrontmatter/参照、実VS Code受入、指定試験repoのGitHub readbackを行う。秘密除去、差分、設定復元、通常親の送信/停止/モデル選択を自己レビューする。

**Done:** 普段の親拡張から使い、統合ターミナルで進行と停止を把握できる。未対応の承認・終了条件・直接入力を明記する。公開配布・本番repo導入・自動起動登録はこの工程の完了だけで実行しない。

2026-11-16: スキル、設定保持installer/uninstaller、VSIX、総合fixtureを実装した。初回233件と並列／内部subagent／遅延報告／再読込みの結果は[CC-07初回記録](../../validation/chat-control/CC-07.md)に保持する。[追加受入](../../validation/chat-control/CC-07-continuation.md)では直列の同履歴報告修正、新担当への引継ぎ、質問応答、通常親UI、非公開GitHub試験branchのreadback、設定復元を確認した。最終234件・型検査・build・スキル参照検査が成功し、専用環境の総合受入を完了した。異なる試行の証拠を一回の連続成功とは扱わない。通常profileへの導入・公開配布・自動起動登録は実施しない。

## 4. 証拠と全体受入

新しい各evidenceは`planRevision/testId/capturedAt/versions/route/actorAliases/workerAttemptIds/terminalBindings/operationIds/eventSeqs/requestedAgent/observedSettings/processIdentities/stopEvidence/artifactHashes/result/limitations`を持つ。公開に実thread IDが不要なら仮名とし、秘密・環境全量・実利用チャット本文を残さない。

`result`は`passed / failed / not_run / unsupported / unknown`、`evidence_kind`は`static / fixture / real_codex / real_vscode / real_github`。新方式のrouteは`extension_parent_cli_workers`とし、旧A/B/Cと別に保存する。親旧Aの実証は参考であり、子の新routeの合格ではない。

全体受入は、通常拡張の親、専用CLIの子、統合ターミナルの表示・閉鎖停止、実コマンド停止、設定照合、必要時だけの親再開、質問と対応する正式承認、停止/復旧、直列/並列Gitが成立すること。CLI直接入力やTUIは合格条件に含めない。プロセス・タブを破棄してもGit成果と記録が残ることを確認する。

## 5. この計画改訂の検証

- [x] 設計revision 2と全工程・契約・ファイル名を照合し、旧「子パネル」の必須条件や承認fallbackが残っていないか自己レビューする。
- [x] CC-00Rの前提とCC-01以降の依存、停止・後始末・正常完了の違い、使い捨てとデータ保持の境界を照合する。
- [x] Review Focusごとに対応する失敗テストと実機の出口があることを確認する。実装・型定義・API存在と実機成功を混同しない。
- [x] 相対リンク・コードフェンス・Mermaid source・差分を確認する。今回は文書だけのためruntime testsを実行していないことを記録する。

検証記録は[planning-cli-2026-11-15.json](../../validation/chat-control/planning-cli-2026-11-15.json)。旧[planning記録](../../validation/chat-control/planning-2026-11-15.json)と旧CC-00証拠は履歴として保持する。この節は設計改訂時点の検証記録。後続のCC-00R／CC-01／CC-02／CC-03／CC-04の実装・受入結果は上の当該工程に記録した。CC-05は実装・ローカルbare remote fixture検証を完了。CC-06は実装・全222件の自動検証・専用ローカルremoteでの実モデル受入を完了。CC-07で専用環境の総合受入とGitHub試験repo readbackを追加確認した。通常profileへの導入は未実施。
