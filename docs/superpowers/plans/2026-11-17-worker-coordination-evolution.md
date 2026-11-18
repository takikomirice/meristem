# ワーカー運用とコーディネーター制御の改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 今回の依頼はこの計画書の作成のみ。プロダクトコード、設定、DB、実行環境の変更や実モデル試験は開始しない。後日の実装ではユーザーが指定した工程を実装・検証・自己レビューまで完了し、対象範囲を越える仕様判断だけを相談する。

**Goal:** 通常2人から提案・承認により増員できるワーカー運用、タスク単位の権限調整、作業を続けながらの相談、内容が分かるターミナルを、既存のGit検証と停止確認を維持して実現する。

**Architecture:** コーディネーターが作業判断を担い、既存の単一writerであるbrokerが依存関係・許可範囲・配送・永続状態を検査する。ワーカーの実行状態、タスクの進捗、相談の状態を分離し、承認待ちは影響する作業だけに適用する。選択式質問、自動レビュー、会話履歴・再開は公式Codexの仕組みを優先し、独自の会話エンジンや常駐復旧サービスは作らない。

**Tech Stack:** 現行のWindows x64、Node.js 24.22.1以上、TypeScript、Node組込みSQLite、C#／.NET Framework、VS Code Terminal/Pseudoterminal、MCP SDK 1.32.2、yaml 2.8.2、zod 4.6.7、`node:test`、PowerShellを継続する。新規依存関係を前提にしない。

**Spec:** 本書「1. 合意した仕様」が今回の会話を自己完結する形で記録した仕様。既存の[設計書](../specs/2026-11-15-codex-chat-control-design.md)、[実装計画](2026-11-15-codex-chat-control-implementation.md)、[運用リファレンス](../../chat-control-reference.ja.md)を基礎とし、衝突する既定値・相談運用は本書を優先する。2026-11-17、日本時間。調査時点のHEADは `f8c214c`。

## Global Constraints

- 通常の同時稼働上限は2人。3人以上は人数・分担・必要性を提案して人間の回答を待つ。「4人承認済み」なら同じrunの4人以内の交代や再割当で再確認しない。
- Meristem独自の親再開・タスク修正の回数上限はデフォルト無制限。開発・試験時などは任意の正整数で指定できる。OpenAI側の利用制限を解除する意味ではない。
- タスクごとにモデル・推論強度・権限を選ぶ。会話履歴を継続しても前のタスクの追加権限を無条件に引き継がない。
- ワーカーの追加承認は基本的にCodexの「代わりに承認」を利用する。自動レビューの明示的拒否、人間専用同意、OS・組織の制限を親の判断で上書きしない。
- 仕様・骨子・制御ルールを親が自由編集する権限は付けない。既定範囲で解決できない問題は、代替案と影響を整理してチャットで相談する。
- 相談・承認待ちは全体停止と同一視しない。未承認の変更に依存する部分だけを保留し、独立した作業を継続する。回答がないことを許可として扱わない。
- 終了したワーカーのプロセスは後始末するが、ログタブを自動で閉じない。表示名、タスクID、WorkerRef、Gitブランチを混同しない。
- 標準Codexの会話保存・履歴閲覧・`thread/resume`を優先する。独自の全文会話保存、ターミナル画面の完全復元、VS Code終了中の継続・無条件自動再開は追加しない。
- owner/epoch/attemptとnativeの作成identity、operation ID・revisionによる重複配送防止、単一writer、candidate/integration SHAと最終SHAでの検証、停止確認を維持する。
- 未コミット変更・worktree・ブランチ・報告・既存証拠を勝手に削除しない。main/protected branchへの直接push、force-push、履歴書換えを行わない。
- 通常監視・描画でモデルを呼ばない。秘密・raw RPC・認証応答・内部思考をターミナルや計画へ流さない。
- 過去の実証結果はそのまま保持する。新しい仕様での成功へ読み替えない。未実施・未観測は `not_run` と記録する。
- 承認済み範囲の調査・実装・ビルド・設定操作・VS Code操作・MCP停止・検証・復元・自己レビューは、利用可能な正規のAPI／CLI／UI操作ツールで可能な限りエージェントが完遂する。システムを触ること、Full Accessでの開発であること、過去の手動試験手順だけを理由に人へ作業を戻さない。人に依頼できる条件と必要な根拠は1.7節に従う。

## Review Focus

| 条件 | 期待する挙動 | 担当工程 |
|---|---|---|
| 複数相談の回答中に計画や提案人数が変わる／回答が二重配送される | 相談ID・提案内容・計画版を照合し、古い回答を適用せず、一度だけ確定する | MC-01〜03 |
| 回答待ちが2件、別の独立タスクが実行可能 | 保留を全体停止にせず、安全に解放できる実行枠だけを再利用する。同じworktreeの編集権は保持する | MC-04 |
| 3人以上の成果を固定後、統合中に別候補や計画が変わる | 固定入力と最終SHAを検査し、受入前に全入力を再確認する | MC-06 |
| 同じ履歴でモデル・権限を変更／自動レビュー拒否／管理領域へのアクセス | 利用可能性と実際の適用を確認し、古いgrantを再利用せず、管理領域を保護する | MC-07 |
| タブを閉じる・再起動する・ログに制御文字が入る／親が応答しない | 表示と停止を区別し、終了未確認を隠さず、標準履歴を使い、独立した停止経路を残す | MC-05、08〜10 |

## 1. 合意した仕様

### 1.1 並列実行と増員

通常は最大2ワーカーを同時に稼働させる。独立した3件以上のタスクを実行できると親が判断した場合、希望する最大人数、各担当、選択モデル・推論強度、増員理由を人間に提案する。回答待ちの間も既存の独立作業は続ける。人間が人数を変更して承認した場合は、その値を使う。

承認はrun単位の同時稼働上限として保存する。例えば最大4人を承認したrunでは、4人以内の起動・交代に再承認を要求しない。5人を希望するときは改めて提案する。減員は親が判断できるが、未完了成果の破棄やworktree削除を含まない。別runへ承認を流用しない。

同時人数はログタブ数・累積attempt数ではない。親自身はワーカー枠に含めない。保留タスクのworktree予約と稼働プロセス数は別に管理する。実際に活動できるプロセスを残したまま、人数計上だけを外して上限を超えない。

4人・8人などの固定推奨値、PCスペック別の保証人数は仕様にしない。ビルド等の同時数は計測後に調整できるようにし、既定の重い処理枠を勝手に合意済み扱いしない。

### 1.2 ワーカーの名前と次タスクの設定

表示名は `Worker A`、`API実装`、`テスト担当`、`feature/auth-api` などを使用できる。親が担当から付与し、人間の指示で変更できる。未指定なら既存表示にフォールバックする。同名表示でも操作先はWorkerRefで識別する。ブランチを表示名にしてもGitブランチ自体を改名しない。

新しいタスクへの割当時にモデル・推論強度を変更できる。同じ会話履歴を使う場合も公式 `thread/resume` と新しいattemptを使い、古いWorkerRefへ送らない。タスク途中の強制モデル変更や、実行中turnのポリシー差替えは初期実装に含めない。

### 1.3 権限と相談の役割

人間が許可した権限上限の中から、親がタスクに必要なアクセス範囲と承認設定を選ぶ。都度の追加操作をすべて親の承認待ちにせず、通常作業に必要な範囲を先に設定する。親自身のFull Accessが子への承認権限になると解釈しない。

ワーカーは通常自律作業を行い、全体設計への影響、他担当との競合、追加依存、仕様不足、繰り返す失敗などを親へ相談できる。親が既定範囲で解決できる場合は回答し、骨子変更や人間の意向が必要なら人へ相談する。

相談は「情報共有」「回答待ちでも指定範囲を続行できる相談」「回答まで該当作業を保留する相談」を区別する。タスクを細分化しないと独立範囲を機械的に区別できない場合は、明示的なサブタスクへ分ける。自然文だけから安全な範囲を推測して自動配送しない。

人間との相談には標準Codexの選択式＋自由記述を優先し、複雑な話は通常チャットで詰める。仕様判断と正式な実行権限の承認は別の要求種別として保存する。

### 1.4 工程表と人間との合意

工程表は実行ハーネスでもあるため、ファイル全体への自由編集権限は渡さない。元の承認済み仕様、制御条件、実績と、段取りの改訂を区別する。表示用Markdownは一つでもよい。

目的・必須機能・互換性・外部送信や課金の制約・必須検証を削除または緩和する変更は、人間に具体的な差分を示して相談する。実現方法の誤りが分かっても、調査・代替案の試行・影響しない作業は進められる。未承認の代替仕様を正式な成果として採用しない。

仕様変更が必要なら、親は理由、代替案、維持できる条件、変わる条件、推奨案を提示する。合意を相談ID・対象版・差分に結び付け、改訂した指示を該当担当へ配送してから再開する。古い計画の実行中turnへ無通知で新しい意味を適用しない。

すべての自然文について意味の不変性を機械判定する仕組みは作らない。人の判断が必要な境界は相談へ戻す。Full Accessの親が制御DB・本体まで変更できる構成で、絶対的な改ざん防止を保証しない。厳密な強制が必要なら親の実行環境にも制御領域への書込禁止を設け、適用可能性を実機確認する。

### 1.5 ターミナルと履歴

通常表示は担当名、タスク、モデル・推論強度、適用権限の要約、具体的な現在作業、相談先と理由、続行可能／保留範囲、最終活動、直近結果を示す。長いidentity・フルパス・照合用hashは詳細表示へ移す。作業状態と相談状態を一つの `state` に押し込めない。

実コマンド・編集・テストのイベントと、ワーカー自身の進捗説明を区別する。内部思考や全文会話を表示しない。更新が古い、接続が不明、出力省略がある場合も表示する。進捗がないことだけで暴走と断定しない。

タブはプロセス終了後も残す。終了済みタブの閉鎖は表示だけ、稼働中タブの明示削除は停止操作という既存の意味を維持する。パネル非表示・画面クリアは停止にしない。「担当を外して他工程を続ける」は別の管理操作として追加する。

会話履歴はCodex側のthread IDを参照して読む・再開する。Meristemはタスク・相談・Git・配送・停止の事実だけを保持する。履歴の再表示と、実作業を再開してモデルを呼ぶ操作を分ける。履歴や工程表の記載だけでテスト成功・プロセス終了を推定しない。

### 1.6 回数、停止、導入

親再開と修正の回数制限は未指定または `null` を無制限とし、正整数指定時だけ適用する。0・負数・小数・非数は拒否する。有限の試験枠、回数の計上、結果不明を含む配送記録は維持する。

親は繰り返す失敗や手詰まりを説明して人へ相談する。コーディネーターが判断不能でも使える全体停止と、nativeによる終了確認を維持する。所有者喪失、配送不明、終了不明の安全停止まで無制限設定で無効化しない。

導入は専用VS Codeデータ・拡張ディレクトリと専用 `CODEX_HOME` に分離する。既存Node同梱を活かし、実行ファイル検出・版/hash照合・設定生成・診断を自動化する。正式ログインやOSのsandbox初期設定は公式経路を使い、承認済みの準備・起動・診断はエージェントが担当する。本人に限定された認証入力や正式同意だけを利用者に依頼する。通常設定・PATH・レジストリ・実行ポリシー・ファイアウォールを暗黙に変更しない。

### 1.7 開発・レビュー・実機検証を可能な限り自律で完遂する

この計画を実装・レビューするエージェントは、ユーザーが承認した対象・範囲・影響の中で、調査から実装、環境準備、検証、終了確認、設定復元、自己レビューまで進める。実装可能な状態で設計の再承認待ちに止まったり、コマンドやクリック手順だけを示して残りをユーザーへ渡したりしない。Full Accessは実行環境の権限であり、作業範囲外への変更や人間専用同意の代行を意味しない。

**エージェントが担当する操作:** 実行ファイル・パス・hashの確認、専用設定の生成と承認済み変更、ビルド、試験起動、VS Codeのウィンドウ／タブ／コマンド操作、MCPの状態確認・停止・許可済み設定切替、ワーカー終了確認、ログ収集、設定復元を含む。用途に合うAPI／CLIを優先し、UIが必要なら利用可能なComputer Use等の正規ツールと該当スキルを確認して実行する。「VS Codeは人しか操作できない」「MCPはユーザーしか止められない」と、手段を調べずに判断しない。

自身が使うMCP・管理プロセスの停止やVS Code再起動が必要な場合は、対象を限定し、必要な記録と復帰手順を先に保存する。停止で失う接続以外の正規CLI・管理経路から終了を確認できるよう準備し、順序を組んで実行する。別ユーザーのセッション、無関係のVS Codeウィンドウや全MCPを一括停止しない。単に現在の接続が切れることだけを理由にユーザーへ停止操作を渡さない。

**人へ依頼できる条件:** 次のいずれかが実際に確認でき、既存の指示・承認・利用可能な正規手段では解決できない場合に限る。

- ログイン、MFA、本人確認、人間に限定された正式同意など、本人の入力・判断が必要である。
- 未承認の仕様変更・対象拡大・権限拡大、破壊的操作、課金・公開などに新しい重大な影響があり、人の判断が必要である。
- 必要な入力・認証情報・接続先がない、UI操作ツールが対象に接続できない、OS／組織／実行環境が操作を拒否するなど、技術的制約を確認した。

依頼する際は、対象と残作業、試したAPI／CLI／UI操作、観測した結果、制約の出典（ツール仕様・設定・エラー、または適用される文書のパスと該当指示）、必要な人の操作を簡潔に示す。実行権限・ネットワーク・自動承認レビューの制限は正規の手続きで扱い、回避・安全性低下・人の承認の偽装で通さない。自動承認レビューに拒否された場合は、その事実・対象操作・理由も示す。

確認が必要でも、先に対象確認、変更案、検証準備、停止・復帰手順など依頼を具体的にする作業を終える。同じ範囲の承認は繰り返し求めず、回答に依存しない工程は続ける。未接続UIや拒否された操作を実行済みと報告しない。

**レビューの基準:** 「人の承認が必要」と「人の手で操作する必要がある」を区別する。レビューで手動作業を要求する場合も上記の制約・根拠を示し、実行可能な操作の委譲を形式的な受入条件にしない。既存資料の「画面操作と正式承認は人が行う」は過去の試験条件として保持し、今後の通常UI操作まで人間専用である根拠にはしない。将来の運用文書はこの区別へ更新する。過去の証拠、スキル配布キャッシュ、認可境界自体は書き換えない。

## 2. 現在の実装との差分

| 対象 | 現状 | この計画で変える点 |
|---|---|---|
| `src/plan.ts`, `src/mcp.ts` | plan・起動で最大2人、待ち状態も実行枠に含む | 人の増員判断と安全な保留を反映 |
| `src/mcp.ts`, `src/broker.ts` | 統合入力が最大2件、並列判定が `=== 2` | N件の入力固定と `> 1` の並列受入 |
| `src/requests.ts`, `src/workers.ts` | 質問・承認の未解決要求は実行をブロック | 通常の相談と公式approval RPCを分離 |
| `src/mcp.ts` | 質問への構造化回答はあるが、人向けフォームは空schemaの許可確認 | 相談用の選択肢・自由記述を追加 |
| `src/broker.ts` | 子停止でrunの配送・親wakeも禁止 | 既存停止を維持し、保留・退役を別操作にする |
| `src/plan.ts`, `src/broker.ts` | ハッシュ変更で凍結、割当済み編集やタスク追加を制限 | 人の合意と改訂の適用手続きを追加 |
| `src/workers.ts` | 管理領域denyの固定profile、モデル/effortの送信・検査は既存 | task単位の設定選択とauto-review適用確認 |
| `src/wake.ts`, `src/store.ts` | 親wakeは最大12、修正は2回固定 | デフォルト無制限、試験時は明示設定 |
| `extension/src/terminal.ts` | identity中心の追記表示、一時terminal、完了時poll終了 | 作業・相談・詳細を分離し、完了ログは保持 |
| `src/contracts.ts` | 名前はworkerIdに依存 | displayNameを内部identityから分離 |
| `src/install.ts` | 指定設定2箇所の編集、絶対パス・固定hash・親bindingの手動準備 | 専用環境の診断・生成を追加し、復元処理は再利用 |

## 3. ファイルと責任

既存クラスを再利用し、汎用ワークフローエンジンや別のメッセージ基盤を作らない。次の新規ファイル名・interfaceは実装用の提案であり、Codex公式API名ではない。

| ファイル | 担当 |
|---|---|
| `src/contracts.ts` | 型・入力制約・displayName・相談・割当設定・任意上限 |
| `src/store.ts`, `migrations/006-coordination.sql` | additive migration、相談・人の判断・改訂参照・実行事実 |
| `src/decisions.ts`（新規） | 相談、増員、人の判断の対象照合と状態遷移 |
| `src/plan.ts`, `src/broker.ts` | 依存、保留、実行枠、改訂、退役、N件統合 |
| `src/mcp.ts`, `src/cli.ts`, `src/requests.ts` | 親子の操作、human-only回答経路、通知、ローカル停止 |
| `src/workers.ts`, `src/permissions.ts`（新規） | 公式モデルcatalog、task設定、権限選択・適用確認 |
| `src/wake.ts`, `native/StdioRelay.cs` | 人入力との競合防止、通知の集約、任意の親wake予算 |
| `src/terminal-events.ts`, `extension/src/control-client.ts`, `extension/src/managed-client.ts`, `extension/src/terminal.ts` | 構造化した表示イベントと現在状態、名前と詳細表示 |
| `extension/src/approval.ts`, `extension/src/extension.ts`, `extension/package.json` | 質問・正式承認の区別、名称変更・詳細・全体確認の操作 |
| `src/install.ts`, `scripts/install.ps1` | 診断、専用環境生成、既存receiptによる復元 |
| `native/WorkerHost.cs`, `native/ControlProgram.cs` | 必要なイベントの限定転送と所有者・プロセス確認。全面改造しない |
| `test/`, `extension/test/`, `test/live/`, `skills/codex-chat-coordination/`, `docs/` | 自動テスト、専用実機受入、運用契約・導入案内 |

## 4. 共通の内部契約

既存の `OperationRef {runId, operationId, expectedRevision}` とWorkerRefを再利用する。新しい状態を `Attempt.state` の文字列だけで表現せず、以下を分離する。

```ts
type ExecutionLimits = { maxWakeTurns: number | null; maxCorrectionsPerTask: number | null };
type TaskAgent = { model: string; effort: string; permissionProfileId: string };
type DecisionState = 'pending' | 'resolved' | 'cancelled' | 'superseded';
type DecisionKind = 'consultation' | 'plan_change' | 'parallelism';
type Decision = {
  id: string; runId: string; taskIds: string[]; kind: DecisionKind;
  recipient: 'coordinator' | 'human'; blockingTaskIds: string[];
  planHash: string; proposalHash: string; state: DecisionState;
  question: string; options: Array<{ id: string; label: string; description: string }>;
  allowFreeText: boolean;
};
type HumanDecisionRef = { decisionId: string; planHash: string; proposalHash: string; formGeneration: string };
type TaskHold = { taskId: string; decisionId: string; releasedExecutionSlot: boolean };
type WorkerPresentation = {
  displayName: string; taskId: string; activity: string; activitySource: 'tool' | 'worker';
  lastActivityAt: string | null; decisionIds: string[];
};
```

- `Decision` はMeristemの仕様相談。`HumanRequest` は公式の未解決approval/input RPC。双方に別IDと寿命を持たせる。公式RPCを自己生成の相談で解決しない。
- `DecisionService.propose(ref, input): Decision` は親／本人からの許可済み範囲で提案を保存し、`resolveCoordinator(ref, decisionId, answer)` は親宛相談だけを解決する。
- `DecisionService.resolveHuman(ref: HumanDecisionRef, answer, verifiedHumanContext)` は信頼済みUI応答経路からのみ呼ぶ。モデルに `humanApproved: true` を渡させるAPIは作らない。`verifiedHumanContext` の取得経路はMC-02で確認する。
- 回答は原子的に保存し、親の次の判断・配送・計画改訂から参照する。チャット本文の「いいよ」だけを複数候補へまとめて適用しない。
- DBに保存する文字列・配列数・UTF-8 bytesを制限し、既存のframe上限とページングを維持する。新規の大きな本文を各status応答へ無制限に付けない。
- 版1のplanを読めるままにし、版2で新規設定を明示する。元runの許可を新しい意味に自動変換しない。既存稼働runは停止・照合後に移行する。
- 既存configの明示的な `mcp.wake.maxTurns` は有限指定として引き続き尊重し、新しい `maxWakeTurns` と併記されて値が違う場合は拒否する。未指定の新規runだけを無制限の既定値へ変え、受入fixtureの有限枠を消さない。

## 5. 実装順序と工程

2026-11-17の並列化改訂では、MC-01〜12の番号・合意仕様・既存の検証項目を維持し、MC-03以降の実装順序と担当境界を以下へ置き換える。今回の変更は計画文書だけで、MC-03以降の実装開始や完了を意味しない。進行中のMC-02、開発環境計画のDE-06・項目5のチェックと、その実績・留保は各担当の記録をそのまま引き継ぐ。

各工程は既存fixtureでred→greenを確認し、実装・必要な検証・自己レビューまで行う。`MC-03a`等の枝番は元工程内の作業単位であり、新しい機能や受入条件ではない。枝番ごとに対象差分をcommitできるが、元工程の完了は全枝番の統合と元工程の検証項目がそろってから記録する。単独で依頼された作業の前提が未成立なら、非依存の調査・準備は進め、未確認機能を仮実装で成功扱いにしない。

### 5.1 開始条件とMC-03／04の接点

- [ ] 統合担当1人を決め、MC-02の最終結果・対応表・commitと、DE-06・項目5の結果、環境manifest・snapshot・終了／復元状態を確認する。最終確認中は読取り調査と分担準備だけを行い、稼働中の試験や未コミット差分を移動・上書きしない。MC-02の実行承認ゲート等の留保は後続でも維持し、必要な経路が未対応ならその接続部分だけを待つ。
- [ ] 同じ確定済みcommitを起点に、担当ごとのbranch／worktreeを用意する。担当、作業単位、変更可能ファイル、参照する契約、取り込み元SHAを引継ぎに記載する。MC-02・DE-06の作業中branchを複数担当の編集場所にしない。
- [ ] MC-03a／04aの着手前に、統合担当が下表を両担当の引継ぎへ固定する。既存型・Store APIを優先し、追加の型・schema変更が必要なら統合担当が先に最小変更と契約テストを取り込む。並列化のためだけに新しいサービス層や汎用interfaceを作らない。

| 接点 | 利用する既存契約・今回固定する意味 |
|---|---|
| 相談と回答 | `DecisionService.propose(ref, input)`、`resolveCoordinator(ref, decisionId, answer)`、`resolveHuman(form, answer, verifiedHumanContext)`、`close(ref, decisionId, state)`。`Decision`／`DecisionAnswer`／`HumanDecisionRef`を再利用し、相談と正式approval RPCを混ぜない |
| 保留の参照 | `Store.coordinationDecision(runId, decisionId)`、`saveTaskHold(runId, hold)`、`taskHolds(runId, taskId)`。MC-04は同run・現行plan・対象taskのblocking相談を照合する。MC-03がMC-04の実装を直接呼ばなくても相談の作成・回答を検証できる |
| 保留・再開 | `src/broker.ts`の`PlanControl.holdTask(ref, taskId, decisionId)`／`resumeTask(ref, taskId, resolvedDecisionId)`をMC-04が担当する。再開時は回答内容・現行plan・Git・owner／attemptと他の未解決相談を再照合し、回答保存だけでは自動配送しない |
| 回答・取消と実行枠 | 現在の`DecisionService`は回答・取消時に`releaseDecisionHolds`を呼ぶ。そのDB行の削除を、プロセス終了確認・実行枠解放・作業再開の許可とは見なさない。MC-04は保留された実行状態を別に照合し、取消・superseded・否定的回答から未承認作業を再開しない |
| 通知と表示 | 相談状態と実行状態を別々に読む。回答・取消で発生する通知とstatusの形は統合担当が固定し、既存の上限・ページング・wake cursorを維持する。未知の状態で配送や枠解放をしない |

### 5.2 並列作業と取り込み順

表は安全に並列化する既定の組合せであり、各工程を一括して同時開始する指示ではない。左列の前提を満たした行から進める。人数・端末数・重い検証の固定推奨値は追加しない。

| 前提 | 同時に進める作業A | 同時に進める作業B | 統合順・受入 |
|---|---|---|---|
| 5.1の引継ぎと契約固定 | MC-03a：相談・人の回答経路 | MC-04a：タスク保留・実行枠管理 | MC-03bで相談のMCP接続 → MC-04bで保留・再開接続 → 両者の結合確認。MC-03全体の完成を待たずMC-04aを進められる |
| MC-03／04の統合済み | MC-05：回数上限・退役・停止 | MC-07a：権限検証関数と単体テスト | MC-05とMC-07aを個別に取り込む。MC-07aの単体成功をruntimeへの適用完了とはしない |
| MC-05の統合済み、表示契約固定 | MC-06：増員承認・N件統合 | MC-09a：拡張側の表示・描画 | MC-06を取り込み、MC-09aは既存／固定入力で描画を確認。実イベントとの接続はMC-09bで確認 |
| MC-06とMC-07aの統合済み、DE-06の引継ぎ済み | MC-07b：次タスクへの設定適用 | MC-11a：診断・既存導入基盤の再利用 | MC-07を受入。MC-11aは現行設定の診断までとし、新設定生成の受入はMC-11bへ残す |
| MC-07の統合済み | MC-08：人の合意に基づく工程表改訂 | MC-10a：標準履歴の読取り | MC-08を受入。MC-10aでは再開・grant復元・新turnを実装せず、読取りと再開を分ける |
| MC-08／MC-09a／MC-10a／MC-11aの統合済み | MC-09b：実イベント・status・名称変更の接続 | MC-11b：版2・権限設定の生成と復元 | 共有ファイルの変更があれば統合担当がMC-09 → MC-11の順に取り込み、各工程の検証を行う |
| MC-07／08／09とMC-10aの統合済み | MC-10b：照合後の明示再開・履歴操作UI | MC-12の文書下書き・既存受入への対応付け | MC-10を受入。MC-12の機能説明・最終検証・実機結果は確定した統合成果を使う |
| MC-03〜11の受入済み | MC-12：全体回帰・有限の実機受入・文書確定 | 実機受入に干渉しない文書・差分レビュー | 全体検証は統合担当が対象commitを固定して実行。実機・設定・停止操作を複数担当で同時に行わない |

### 5.3 ファイルの担当と統合規則

以下は同じ行で並列作業する間の書込み分担。元工程の`Files`は工程全体の影響範囲を示す。統合担当は作業Aの実装を兼任してよく、並列化だけのために専任担当を増やす必要はない。割当外のファイルが必要になった場合は担当間で引継ぎを更新し、同じファイルを同時編集しない。分担変更だけなら人の再承認を求めず、仕様・許可範囲が変わる場合は1.7節へ戻す。

| 作業単位 | 並列作業中に担当する主なファイル | 後で統合担当が接続する部分 |
|---|---|---|
| MC-03a | `src/decisions.ts`、`src/requests.ts`、`native/StdioRelay.cs`、`extension/src/approval.ts`、`test/decisions.test.ts`、`test/requests.test.ts` | MC-03b：`src/mcp.ts`、`src/cli.ts`、`src/wake.ts`とMCP／wakeのテスト |
| MC-04a | `src/plan.ts`、`src/broker.ts`、`src/store.ts`、`src/workers.ts`とplan／plan-control／broker／parallel／workersのテスト | MC-04b：`src/mcp.ts`の保留・再開接続とMC-03との結合確認 |
| MC-05／MC-07a | MC-05は元工程のファイル。MC-07aは`src/permissions.ts`、`test/permissions.test.ts`のみ | MC-07b：model catalog照合、runtime適用、broker／plan／MCP／requestsとの接続。共通型の追加は統合担当が先に行う |
| MC-06／MC-09a | MC-06は元工程のファイル。MC-09aは`extension/src/terminal.ts`、`extension/src/control-client.ts`、`extension/src/managed-client.ts`、`extension/test/terminal.test.ts` | MC-09b：backend／nativeの実イベント、status、名称変更、拡張のコマンド登録と接続テスト |
| MC-07b／MC-11a | MC-07bは元工程の接続ファイル。MC-11aは`src/install.ts`、`test/install.test.ts`と専用導入案内。DEの診断・生成処理は読取り参照して再利用 | MC-11b：新しい権限・plan版2の設定生成、install／uninstallスクリプト、配布物の回帰確認 |
| MC-08／MC-10a | MC-08は元工程のファイル。MC-10aは`src/workers.ts`、`test/workers.test.ts`の履歴読取り部分 | MC-10b：再開時の照合、MCP／CLI／拡張の履歴操作、未解決相談の復帰 |
| MC-09b／MC-11b | MC-09bはMC-09a以外の元工程ファイル。MC-11bは導入関連ファイル。MC-09aの表示修正が必要なら同担当から引き継ぐ | 実イベントを使う表示の回帰と、生成設定を使う導入・復元の回帰をそれぞれ実施 |

- `src/contracts.ts`、DB migration、`test/fixtures/MockCodex.cs`等の共有fixture、`package.json`／lockfile、本工程表の進捗、日英READMEは統合担当が書込みを担当する。並列担当は必要な具体差分を渡し、各worktreeで競合する定義を増やさない。共有schema変更は関係担当へ同じcommitを渡してから実装を続ける。
- `src/mcp.ts`、`src/cli.ts`、`src/wake.ts`、`extension/src/extension.ts`、`extension/package.json`への接続は表の取り込み順で1人が行う。同一ファイルの別関数であっても、並行編集する前提にはしない。
- `src/broker.ts`／`src/store.ts`／`src/plan.ts`を扱うMC-04・05・06・08は直列に取り込む。`src/workers.ts`とそのテストの編集担当はMC-04a → MC-07b → MC-10a → MC-09b → MC-10bの順に引き継ぐ。待機中に調査・テスト観点の整理を進めてよいが、未統合の前提で接続部分を完成扱いにしない。
- 各担当の取り込みは1人が順番に行い、競合解消後は取り込み先のSHAで関連テストと自己レビューを行う。共有ファイルの最新版へ差分を合わせ、他担当の変更を丸ごと上書きしない。枝番の単体成功は、元工程の結合確認やMC-12の実機受入を代替しない。

### 5.4 並列化時の検証と完了判定

- 各担当は自分のworktreeで既存のbuild／typecheck／関連テストをPowerShellから一つずつ実行する。`dist`、`extension/dist`、native出力、fixture DB・Git repo・一時rootを別担当と共有しない。別worktreeでも外部の共通出力を指定する場合は直列化する。
- MC-03a／04aの単体確認には既存fixture・Storeを使ってよいが、成功stubで人の回答・停止確認・実機対応を代替しない。MC-03b／04bの統合時は下の3経路を既存テストへ追加または拡張し、元のMC-03／04の検証コマンドで成功を確認する。
  - [x] `consultation_answer_does_not_resume_before_safe_parking`：回答保存と停止確認が競合しても、活動中の旧attemptを人数から除外せず、新規配送をしない。必要な終了確認後に再照合して再開する。
  - [x] `cancelled_or_superseded_consultation_never_resumes_held_work`：hold行の解放後も取消・superseded・否定的回答を作業許可と解釈せず、別の未解決相談、古いplan、未コミット成果を保持する。
  - [x] `consultation_hold_answer_resume_keeps_independent_worker_running`：相談→対象だけ保留→独立担当の続行→有効回答→新attemptで再開を通し、古いWorkerRef・同一operationの二重配送を拒否する。
- MC-07bの受入後、MC-10bで履歴再開と権限非継承を合わせて検証する。MC-09bではMC-04の保留、MC-05の退役／停止、MC-08の古い相談を実際のstatusから表示し、描画fixtureだけの成功にしない。MC-11bでは生成した設定をinstallerが受理し、復元時に利用者の変更を保持することを確認する。
- 通常テストにモデル・実VS Code・外部Git接続を混ぜない。実機試験は各工程の既存条件と1.7節に従い、対象のenvRoot・authHome・profile・leaseを1人が管理する。モデル予算・許可・runを別担当へ暗黙に流用しない。稼働snapshotを再ビルドせず、共有環境の停止・復元を取り合わない。
- MC-12の全体`npm run verify`と実機受入は対象commitを固定し、通常テスト・実Codex・実UI・OS隔離の結果を区別する。途中工程でも各工程の必須検証を省略せず、未確認はそのまま引き継ぐ。検証後にコードを変えた場合は影響範囲を再検証し、文書だけの進捗更新で同じ全体検証を繰り返さない。

### MC-01: 状態・相談・設定の永続契約

**Files:** Modify `src/contracts.ts`, `src/store.ts`, `src/plan.ts`; Create `src/decisions.ts`, `migrations/006-coordination.sql`, `test/decisions.test.ts`; Test `test/store.test.ts`, `test/plan.test.ts`。

**Interfaces:** 4節の型、`DecisionService`、`ExecutionLimits` を定義する。`Store` に相談・保留・増員承認・改訂の読み書きを追加する。既存のoperation/revisionとtransactionを利用する。

- [x] `coordination_migration_preserves_v5_state`：旧DBの報告・候補SHA・停止結果が移行後も一致すること、二重migrationで破壊しないことをテストする。
- [x] `decision_resolution_is_current_and_once_only`：古いproposalHash・planHash・formGeneration、別runの回答を拒否し、同一操作の再読取では二重適用しないことをテストする。
- [x] `optional_limits_and_display_names_are_validated`：未指定/nullは無制限、正整数は有効、0/負数/小数は拒否。日本語・`/`を含む表示名を許し、空白のみ・制御文字・過大文字列は拒否する。提案値として表示名はtrim後1〜128文字とする。
- [x] `npm run build`、`node --test dist/test/store.test.js dist/test/plan.test.js dist/test/decisions.test.js` で新仕様テストが失敗することを確認後、additive migrationとschemaを実装して同コマンドを通す。
- [x] 差分・互換性を自己レビューし、工程単位でcommitする。次工程のinterfaceとして型と状態遷移を確定する。

実装記録（2026-11-17）: schema 6への追加移行、相談と回答の原子的保存、保留・増員承認・改訂の保存API、版2の設定契約を実装。版1と旧証拠の保全、旧フォーム拒否、同一操作の再読取を確認。人の回答検証は対象フォームと回答を受ける必須adapterを採用し、実UI接続はMC-02/03で実証する。設定の実行時適用は後続工程。README日英を更新。ブランチは `docs/worker-coordination-plan`。詳細なcommitとpush結果は実装完了報告を参照。 検証は `npm run build`、`npm run typecheck`、対象3ファイルの22テストが成功。`npm test` は42件中41件成功、release ZIP試験は180秒timeoutで失敗し、単独再試行でも再現した（パッケージ生成コードは未変更）。 `npm run test:control` は192件中189件成功。検証中に別作業で追加されたMC-02の `multiple_question_fixture_roundtrips_free_text_and_rejects_partial_or_stale_answers`、`waiting_parent_elicitation_keeps_dispatched_worker_running_and_inbox_durable`、`compatibility_probe_checks_applied_settings_history_and_never_claims_UI_or_review_decisions` が失敗。これらの作業差分は今回のcommitに含めない。

### MC-02: 標準Codexの質問・自動レビュー・履歴経路の適合確認

**Files:** Modify `test/fixtures/MockCodex.cs`, `test/requests.test.ts`, `test/workers.test.ts`, `test/live/approval-roundtrip.ts`; Create `docs/validation/chat-control/worker-coordination-compatibility.md`。

**Interfaces:** 対象版の `requestUserInput`／MCP elicitation、`approvalsReviewer`、permission profile、`thread/read`／`thread/resume` の対応表を作る。外部API名はその版の生成schemaで確定する。

- [x] 選択肢＋自由記述、複数質問、取消・閉鎖・遅延回答をfixtureで再現し、UI応答を人からの回答として照合できる経路を確認する。fixtureに加え、現在PCの正式なCodex UIで選択肢＋自由記述の実回答を受信。tools/call ID・対象版・schema hash・formGenerationと会話／turnを照合した。取消・閉鎖・遅延回答の実UI観測とは区別する。
- [x] 標準フォームが親turnを待機させる場合も、既に走る独立ワーカーが継続することを確認する。未確認の非同期質問APIを前提にせず、必要な独立作業を先に配送し、相談inboxを永続化する。親待機中の追加配送まで必要で既存APIで満たせない場合は、代替案と制約を報告する。MCP待機とDB上pendingを維持したまま独立workerの完了・終了確認をfixtureで検証。実親turn待機中の追加判断・配送は留保。
- [x] `auto_review` の選択・実適用・拒否、履歴の閲覧と再開を別々に観測する。親のFull Access、人間専用承認、組織制限を混同しない。現在PCではreviewer/profileのACKと、明示的な `thread/guardianReview` の実allow/denyを観測した。コマンドは実行せず、通常の実行承認ゲートの成功へ読み替えない。履歴閲覧・同一app-server内resumeは先行PCの実測を保持する。
- [x] まず `npm run build:native`、`npm run build`、`node --test dist/test/requests.test.js dist/test/workers.test.js` を実行する。専用実機試験は正式認証・対象・任意の有限回数枠を確認したうえで行い、画面・回答・適用結果を記録する。現在PCの対象52件成功後、実評価を最大2件ずつの2試行、UIを1ターン・1フォームで実施。本人のUI回答と公式callback、設定復元を記録した。
- [x] 未対応は成功stubや拡張キャッシュ編集で通さず、未確認機能だけを留保する。新しいサービスや独自TUIを増やさず、影響しない工程は続けられるよう対応表をcommitする。

中断記録（2026-11-17）: ユーザーの作業終了・commit/push指示によりMC-02は未完了のまま保存。[互換性確認記録](../../validation/chat-control/worker-coordination-compatibility.md)と[実機証拠](../../validation/chat-control/evidence/MC-02-compatibility.json)を参照。fixtureと実機を区別するbounded probeを実装し、実 `auto_review`／profileの設定ACK、1ターン完了、履歴閲覧・同一app-server内のresume、native停止を観測した。個々の自動レビューの承認／拒否と人の実UI回答は未観測。専用UIの一時MCP設定は元のhashへ復元済み。Computer Useはユーザー操作で停止し、専用ウィンドウの閉鎖は未確認。MC-03/07のプロダクト経路は未変更。

再開時の残件: MC-02として実レビューの承認／拒否と実UI回答の観測を完了し、対象ID・版・formGenerationの照合を記録する。これらをMC-03/07へ移してMC-02を完了扱いにしない。別プロセスのlive resumeは今回未検証であり、今回の成功は同一app-server内に限る。

再開記録（2026-11-17、現在PC）: 上記中断時の残件に対し、明示評価APIの実allow/denyと人による実UI回答を観測し、MC-02の互換性確認を完了した。[現在PCの証拠](../../validation/chat-control/evidence/MC-02-current-pc.json)と[対応表の追記](../../validation/chat-control/worker-coordination-compatibility.md#現在pcでのmc-02再開)を参照。native build・型検査・build成功、通常42件（直列）・制御244件・端末14件の計300件成功、独立レビューの修正指摘なし。標準verifyで発生した既存停止テストの一時失敗とnative exe使用中の失敗は対応表に保持し、標準verify全体成功とは記録しない。先行試行・先行PCの証拠は変更していない。実行承認ゲート、別プロセスのlive resume、MC-03/07のプロダクト実装は未実施のまま区別する。

### MC-03: 相談inboxと人への選択式質問

**着手・分担:** 5.1の引継ぎと契約固定後、MC-03aをMC-04aと並列に進める。MC-03aは相談・回答の処理と既存fixtureでの単体確認、MC-03bはMCP／CLI／wakeへの接続を担当する。下記の検証項目は分割後もすべて実施し、MC-04bとの結合確認まで含めて受け入れる。

**Files:** Modify `src/decisions.ts`, `src/mcp.ts`, `src/requests.ts`, `src/cli.ts`, `src/wake.ts`, `native/StdioRelay.cs`, `extension/src/approval.ts`; Test `test/decisions.test.ts`, `test/mcp.test.ts`, `test/requests.test.ts`, `test/wake.test.ts`。

**Interfaces:** `propose_decision`、`answer_consultation`、`get_decisions` を既存MCPへ追加する。人宛の確定はMC-02で確認したhuman-only callbackを使用し、既存 `answer_request` の正式承認経路を弱めない。

- [x] `consultation_does_not_resolve_permission_rpc`、`coordinator_cannot_answer_human_decision`、`multiple_decisions_keep_answers_separate` を追加する。親の判断対象と人の判断対象を混ぜない。
- [x] `cancelled_or_silent_form_remains_unapproved`、`stale_answer_after_plan_change_is_not_applied` を追加する。自由記述による案の修正は新proposalとして保存し、古い案を承認した扱いにしない。
- [x] 進捗は通常イベントとして保存し、相談・失敗・完了のみ親への再開候補にする。親の人入力中は強制steerせず、既存wake cursorで通知を集約する。
- [x] `npm run build`、`node --test dist/test/decisions.test.js dist/test/mcp.test.js dist/test/requests.test.js dist/test/wake.test.js` のred/greenを確認する。native変更時は先に `npm run build:native` と関連native試験も行う。
- [x] 親への相談、人のフォーム、正式権限承認それぞれの配送・取消・再起動時の未解決状態を自己レビューしてcommitする。

MC-03aの記録（2026-11-17）: 相談処理と標準MCPフォームの単体実装・検証は[MC-03a記録](../../validation/chat-control/MC-03a.md)にまとめる。対象は `src/decisions.ts`／`src/requests.ts` と対応テスト。MCP／CLI／wakeの実配線はMC-03b、保留・再開との結合はMC-04へ残し、上記MC-03全体のチェックはそれらの受入まで完了扱いにしない。

MC-03bの記録（2026-11-17）: MCP・既存CLI callback・wakeへの接続を実装・検証した。[MC-03b記録](../../validation/chat-control/MC-03b.md)を参照。独立レビューで見つかった実plan変更時のcallback検査不足をred→greenで修正し、`npm run verify` は通常42・制御269・端末14の計325件成功。MC-04aの別担当差分は取り込まず、MC-04bの結合確認と実機受入を未実施として区別する。

MC-03統合受入（2026-11-17）: MC-04bでMC-03bとMC-04aを統合し、相談・人用callback・保留・明示再開の結合を確認した。元の4ファイルは94/94、統合後の標準`npm run verify`は343/343成功。これにより上記MC-03の項目をチェックした。過去の枝番の留保は当時の記録として保持し、今回の確認と実機未確認の区別は[MC-04b記録](../../validation/chat-control/MC-04b.md)にまとめる。

### MC-04: タスク単位の保留と実行枠の再利用

**着手・分担:** MC-04aはMC-03aと並列に、固定済みの相談契約と実Storeを使って保留・枠管理を実装する。MC-03の実UI完成待ちにはしない。MC-04bはMC-03bの取り込み後にMCPへ接続し、5.4節の回答／取消／停止の競合を含む結合確認を行う。

**Files:** Modify `src/plan.ts`, `src/broker.ts`, `src/workers.ts`, `src/mcp.ts`, `src/store.ts`; Test `test/plan.test.ts`, `test/plan-control.test.ts`, `test/broker.test.ts`, `test/parallel.test.ts`, `test/workers.test.ts`。

**Interfaces:** `PlanControl.holdTask(ref, taskId, decisionId)` と `resumeTask(ref, taskId, resolvedDecisionId)`、`TaskHold` を使う。`eligibleTasks` は実行枠・相談依存・scope/conflictsをそれぞれ検査する。

- [x] `two_held_tasks_allow_independent_work_after_safe_parking`：2件を安全に保留したあと独立タスクを開始でき、同じworktreeや競合資源のタスクは開始しないことを確認する。
- [x] `nonblocking_consultation_keeps_worker_running`：情報共有・非blocking相談は公式未解決approval RPCを作らず、既定範囲の作業を継続できることを確認する。
- [x] 保留中プロセスが追加活動できる間は人数に計上する。枠解放はturnの終了／中断と必要なプロセス後始末を確認してから行う。未知の停止状態では解放しない。未コミット変更は保持し、再開にはGit・指示の照合を要求する。
- [x] `held_scope_and_stale_results_remain_fenced`：仕様変更後に古いturnの成果を受け入れず、未承認の依存工程へ進めないことを確認する。
- [x] `npm run build`、`node --test dist/test/plan.test.js dist/test/plan-control.test.js dist/test/broker.test.js dist/test/parallel.test.js dist/test/workers.test.js` のred/green、ロック解放と停止境界の自己レビュー後にcommitする。

MC-04a実装記録（2026-11-17）: `6c41c3f`を起点に専用branch／worktreeで保留・安全な枠解放・明示再開を実装した。相談のhold行が消えても実行保留を保持し、scope・競合資源・worktreeを予約する。停止unknownでは既存の全体フェンスへ戻す。再開は現行相談の明示的な`resume`回答を照合し、新thread・新attemptで同じclean worktreeを使う。独立タスクの統合後も、元タスクのscopeと最終SHA検証を保って再開できる。独立レビューのImportant 2件をRED→GREENで修正し、最終の型検査・build、通常42件（直列）・制御258件・端末14件の計314件が成功した。標準verifyの既存EPERMによる失敗は成功へ読み替えず記録した。[検証・契約引継ぎ](../../validation/chat-control/MC-04a.md)を参照。branchは`feat/mc-04a-task-holds`。MC-04bのMCP接続・結合受入、MC-10の中断thread履歴再開、実モデル・実UI・OS隔離の追加受入は未実施。上の工程全体のチェックはMC-04b統合後に確定する。

MC-04b統合受入（2026-11-17）: `e2d7a64`（MC-03a／03b）と`844c363`（MC-04a）を統合し、親専用の`hold_task`／`resume_task`を接続した。5.4節の3経路と、応答より先に再開が進む競合をred→greenで確認。実native Job・host終了と独立担当の続行もMCP経由で確認した。元の5ファイルは84/84成功。独立レビューは修正指摘なし、自己レビュー後の標準`npm run verify`はnative・型・build、通常42・制御287・端末14の計343件成功。上記MC-04と5.4節の該当項目をチェックした。実モデル・実UI・追加OS隔離の実機受入は`not_run`で、MC-08の保留原因の置換・MC-10の中断thread履歴再開・MC-12の実機受入を先取りしない。[最終検証・引継ぎ](../../validation/chat-control/MC-04b.md)を参照。

### MC-05: 任意回数上限と退役・停止の区別

**着手・分担:** MC-03／04の統合後に開始し、MC-07aと並列に進められる。MC-04と共有するbroker／Store、MC-03と共有するwakeの編集を引き継いでから実装する。MC-06の制御本体とは同時編集しない。

**Files:** Modify `src/wake.ts`, `src/store.ts`, `src/broker.ts`, `src/mcp.ts`, `src/cli.ts`, `extension/src/extension.ts`, `extension/package.json`; Test `test/wake.test.ts`, `test/broker.test.ts`, `test/control.test.ts`, `test/mcp.test.ts`, `extension/test/terminal.test.ts`。

**Interfaces:** `ExecutionLimits` をconfigからbrokerへ渡す。`retire_worker {target}` は親からの対象退役とし、既存 `stop_worker`／タブ削除／`stop_run` の意味を変更しない。退役でタスクを完了扱いにしない。

- [x] `unlimited_default_exceeds_twelve_wakes_and_two_corrections`：13回以上のwakeと3回以上の修正で固定上限停止しないことを確認する。
- [x] `explicit_budget_is_reserved_before_delivery`：例えばwake=3、correction=2の指定で上限を適用し、配送不明も枠を消費し、同operationの照合では二重消費しないことを確認する。
- [x] `retire_one_worker_keeps_run_active`、`manual_tab_close_keeps_existing_stop_semantics`、`stop_run_works_without_parent_model` を追加する。退役と全体停止の競合、二重停止でも対象を取り違えない。
- [x] 無制限設定でowner喪失・配送不明・終了不明の停止を無効化しない。数回失敗しただけの一律停止を、仕様相談と有限試験枠の停止に分ける。
- [x] `npm run build`、`node --test dist/test/wake.test.js dist/test/broker.test.js dist/test/control.test.js dist/test/mcp.test.js`、`npm run test:terminal` のred/greenを確認してcommitする。

MC-05実装記録（2026-11-17）: 既定のwake・修正回数を無制限にし、config／版2工程表／旧wake設定の有限枠は厳しい方を適用する。送信前予約・同operationの再照合・結果不明時の停止を維持した。親専用の対象退役と拡張の退役・全体停止を追加し、nativeの正規受付へ接続した。退役は終了確認まで枠を保持し、タスク・未コミット成果・ログを残す。既存タブ削除のrun配送・wake停止は維持した。RED→GREENと独立レビュー・自己レビュー後の標準`npm run verify`は通常42・制御296・端末15の計353件成功。実行開始後に追加した正常完了との競合は、再buildとbroker14/14の補足検証で成功した。README日英・運用文書も更新した。詳細は[MC-05検証記録](../../validation/chat-control/MC-05.md)を参照。ブランチは`docs/worker-coordination-plan`。実モデル・実UI・追加OS sandbox受入は`not_run`とし、MC-06以降は未着手のままとする。

### MC-06: 人が承認する増員とN件の統合

**着手・分担:** MC-05の統合後、MC-09aの拡張側描画と並列に進める。増員承認はMC-03の人の回答経路、枠計上はMC-04／05の保留・退役・停止を使う。N件化だけを先に接続し、承認前の起動を許す中間状態を受け入れない。

**Files:** Modify `src/plan.ts`, `src/broker.ts`, `src/mcp.ts`, `src/store.ts`, `src/git-evidence.ts`; Test `test/parallel.test.ts`, `test/plan-control.test.ts`, `test/mcp.test.ts`, `test/git-evidence.test.ts`; Modify `test/fixtures/parallel-git.ts`, `test/live/parallel-merge.ts`。

**Interfaces:** `Decision(kind='parallelism')` に正整数の `requestedMaximum` を持つ提案payloadを結び付け、proposalHashの対象にする。runのapproved maximumを保存し、`effectiveParallelLimit(runId: string): number` は承認がなければ2を返す。planの希望人数と承認された上限を分離する。

- [x] `third_worker_requires_current_human_grant`：3人目を承認前に起動できず、親の自己承認・無回答・別runのgrant・人数を変えた古い回答では増員しないことを確認する。
- [x] `grant_four_allows_replacement_but_not_five`：同runの最大4人承認後は交代を含め4人以内の再確認なし、5人目は新しい提案が必要であることを確認する。空席を同時予約する競合で上限を超えない。
- [x] plan validator、MCP fixtureの2件制限、実行登録数、入力候補数、`=== 2` 分岐をすべて追跡し、N件対応へ変更する。既存128タスク・frameサイズ・ページング制約は維持し、必要なら候補を複数batchで統合する。
- [x] `three_candidates_are_pinned_and_checked_at_final_sha`、`candidate_changed_during_integration_is_rejected` を追加する。scopeの競合・共有lockは人数承認でも解除せず、最終SHAで既存＋追加のcompletionとintegration検証を行う。
- [x] `npm run build`、`node --test dist/test/parallel.test.js dist/test/plan-control.test.js dist/test/mcp.test.js dist/test/git-evidence.test.js` を通し、3人以上のローカルbare remote試験後にcommitする。実モデル試験はMC-12で別記録する。

MC-06実装・受入記録（2026-11-18）: 人用callbackに結び付けた増員承認とrun単位の上限、起動前の枠予約、N候補の固定・最終SHA検証を接続した。未回答の旧人数提案は新提案で無効化し、終了不明・scope・共有lockの制約は維持した。32件ずつの検証結果登録と、既存通信上限内の状態ページ取得も追加した。独立レビューのImportant 3件と自己レビューの境界をRED→GREENで修正し、最終`npm run verify`は通常42・制御311・端末15の計368件成功。ローカルbare remoteで4担当、4候補＋後続候補、過去completionの再検証と終了を確認した。README日英・運用文書を更新し、詳細とMC-09aへのページ取得の引継ぎは[MC-06検証記録](../../validation/chat-control/MC-06.md)、観測値は[ローカル受入JSON](../../validation/chat-control/MC-06-local-bare.json)を参照。実モデル・実UI・追加OS隔離は`not_run`で、MC-07以降は今回の受入へ含めない。

### MC-07: 次タスクのモデル・推論強度・権限選択

**着手・分担:** MC-07aはMC-02で確認した列挙値とMC-01の型を使う`resolveTaskPermissions`の検証を担当し、MC-05と並列に進める。`npm run build`と`node --test dist/test/permissions.test.js`で単体確認する。MC-07bはMC-06とMC-07aの統合後、既存catalog検査とruntimeへ接続し、下記すべての回帰を実施する。MC-11aの診断と並列に進めてよい。

**Files:** Create `src/permissions.ts`, `test/permissions.test.ts`; Modify `src/workers.ts`, `src/broker.ts`, `src/plan.ts`, `src/mcp.ts`, `src/requests.ts`; Test `test/workers.test.ts`, `test/plan-control.test.ts`, `test/mcp.test.ts`。

**Interfaces:** `RunPermissionPermit = { allowedProfileIds: string[]; writableRoots: string[]; allowedReviewers: string[] }`、`ResolvedPermissions = { permissionProfileId: string; approvalsReviewer: string; writableRoots: string[] }` を `src/permissions.ts` に定義し、`resolveTaskPermissions(taskAgent: TaskAgent, runPermit: RunPermissionPermit): ResolvedPermissions` を追加する。reviewerの値はMC-02で生成schemaに合わせて列挙型へ絞る。任意のconfig文字列は受け付けず、内部でMC-02の対象版へ変換する。runPermitの委任上限を越える設定は新たな人の判断へ戻す。

- [x] `task_settings_are_validated_against_live_catalog_and_permit`：model/effortの既存catalog検査を再利用し、未知profile・上限外path・不正な権限の組合せを拒否する。
- [x] `same_history_uses_new_task_agent_and_no_old_grant`：履歴を再開した次タスクへ新model/effortを渡し、前タスクの拡張権限が残らず、要求値と実適用値を確認する。安全にresetできない対象版では、履歴継続を見送って新threadへ必要情報を引き継ぐ。
- [x] `auto_review_denial_is_not_parent_overridable`、`control_state_remains_denied`、`human_only_consent_stays_human_only` を追加する。OS・組織制限を検出し、Full Accessへ暗黙fallbackしない。
- [x] 委任profileは最初に実証した最小種類だけを用意し、任意のconfig/TOML注入を許す汎用権限エディタを作らない。実行中turnの変更は行わず、次の割当境界で適用する。
- [x] `npm run build`、`node --test dist/test/permissions.test.js dist/test/workers.test.js dist/test/plan-control.test.js dist/test/mcp.test.js` のred/greenと隔離回帰確認後にcommitする。

MC-07実装・受入記録（2026-11-18）: MC-07aをマージ後、MC-07bのcatalog・run権限上限・runtime適用・応答照合を接続した。旧grantのresetを対象版で確認できないため、計画内のfallbackとして履歴継続も検証済みworktreeから新threadへ引き継ぐ。自動レビュー拒否は同turnの正式承認で上書きせず、本人限定同意と管理領域denyを維持した。独立レビューのImportant 1件と、既存の並列fixtureに残っていた仮profile名を修正した。最終`npm run verify`は通常42・制御331・端末15の計388件成功。実Codexの0turn起動・設定ACK・sandbox canary・native終了も確認した。実モデル操作、自動レビューの通常実行ゲート、実UIは`not_run`。詳細は[MC-07検証記録](../../validation/chat-control/MC-07.md)と実機JSONを参照する。MC-08以降は含めない。

### MC-08: 人の合意に基づく工程表改訂

**着手・分担:** MC-07の統合後、MC-10aの履歴読取りと並列に進める。MC-03の対象照合・MC-04の保留／再開・MC-06の人数上限・MC-07の権限上限を使い、改訂で既存permitを拡張しない。broker／Store／planの書込みはこの担当へ引き継ぐ。

**Files:** Modify `src/plan.ts`, `src/broker.ts`, `src/decisions.ts`, `src/mcp.ts`, `src/store.ts`; Test `test/plan.test.ts`, `test/plan-control.test.ts`, `test/decisions.test.ts`, `test/mcp.test.ts`。

**Interfaces:** `propose_plan_change` と `apply_plan_change {decisionId, expectedPlanHash, proposedPlanHash}` を追加する。表示進捗、担当変更、仕様変更の対象を区別し、既存のsnapshot/revisionと操作記録を再利用する。

- [x] `plan_change_requires_matching_agreement`：承認済みの具体diffだけ適用し、別の変更の混入、必須検証の黙示削除、repository/branch/権限上限の変更を既存permitで通さないことを確認する。
- [x] `approved_change_updates_only_affected_tasks`：未影響の既存作業を継続し、影響するturnは保留・再指示して、古い成果を新仕様の成功として受け入れないことを確認する。
- [x] `chat_discussion_does_not_forge_authorization`：チャットで案を検討できても、モデルが提出した「人が同意した」という本文だけで制御上限を変えない。MC-02/03の信頼済み回答と対象版を使用する。
- [x] 未承認のファイル直接変更は既存の凍結・照合へ戻す。合意内容・元仕様・旧版・完了実績を保持する。全仕様の意味比較AIや複雑な不変条件DSLは作らない。
- [x] `npm run build`、`node --test dist/test/plan.test.js dist/test/plan-control.test.js dist/test/decisions.test.js dist/test/mcp.test.js` のred/green、変更前後の受入条件レビュー後にcommitする。

MC-08実装・受入記録（2026-11-18）: 人のフォーム回答で承認したタスク差分を適用し、影響タスクを終了確認後に再指示する。独立作業、統合済み実績、旧版・旧worktreeを保持する。独立レビューの重要指摘2件を修正し、最終`npm run verify`は通常42・制御338・端末15の計395件成功。実モデル・実VS Codeのフォーム・追加OS隔離は`not_run`。詳細は[MC-08検証記録](../../validation/chat-control/MC-08.md)を参照する。

### MC-09: 表示名と具体的な作業・相談が分かるターミナル

**着手・分担:** MC-09aはMC-05の統合と表示契約固定後、5.3節の拡張ファイルに限ってMC-06と並列に進める。`npm run build:extension`と`npm run test:terminal`で固定入力の表示を確認する。MC-09bはMC-08とMC-09aの統合後、実イベント・status・名称変更を接続し、MC-04／05／08の実状態を使って下記の表示・停止検証を完了する。MC-11bと並列に進められる。

**Files:** Modify `src/contracts.ts`, `src/terminal-events.ts`, `src/cli.ts`, `src/workers.ts`, `native/WorkerHost.cs`, `extension/src/control-client.ts`, `extension/src/managed-client.ts`, `extension/src/terminal.ts`, `extension/src/extension.ts`, `extension/package.json`; Test `test/control.test.ts`, `test/workers.test.ts`, `test/worker-host.test.mjs`, `extension/test/terminal.test.ts`。

**Interfaces:** `WorkerPresentation` と上限付き表示イベントをstatus/eventsへ追加する。`rename_worker {target, displayName}` は表示のみを変更する。完了後の相談決定はrunの記録として更新し、終了したプロセスへ指示を送らない。

- [x] `display_name_never_changes_identity_or_branch`：日本語・ブランチ風・同名表示で正しいattemptだけを操作し、名前を変えてもWorkerRefとGit branchが不変であることを確認する。
- [x] `running_with_pending_consultation_is_displayed_separately`：現在の作業、相談先・理由、続行／保留範囲、最終活動を表示し、tool由来とworker説明を区別する。
- [x] 詳細にはactor/attempt/full pathを残すが通常表示から分離する。既存terminalを再利用し、完了時の自動disposeをしない。低コストの全体一覧は既存拡張のコマンド／Quick Pickを先に使い、新dashboard基盤は追加しない。
- [x] `stale_activity_and_unknown_connection_are_visible`、`terminal_output_stays_sanitized_and_bounded` を追加する。秘密・ANSI/OSC・長文・低速描画・大量同時イベントでRPCと停止を詰まらせない。経過時間表示のためだけにモデルを起こさない。
- [x] `npm run build:native`、`npm run build`、`node --test dist/test/control.test.js dist/test/workers.test.js`、`node --test test/worker-host.test.mjs`、`npm run test:terminal` を実行し、表示／停止境界の自己レビュー後にcommitする。

MC-09b検証記録（2026-11-18）。実イベントの接続、保留・退役・旧版相談の表示、終了確認後のタブ保持と相談更新をfixtureで確認した。実Codexと実VS Code UIは `not_run`。[MC-09b検証記録](../../validation/chat-control/MC-09b.md)

MC-09a実装記録（2026-11-17）: MC-05の`f980879`から専用branch／worktreeで拡張側の表示契約と描画を実装した。固定入力で担当名・作業／相談の分離、続行／保留範囲、出力由来、古い活動／接続不明、詳細描画、ログ保持を確認した。独立レビューで見つかった大量ログによる状態消失と長文相談による後続情報の消失をred→greenで修正した。日本語の梱包内容検査で顕在化したPowerShellの出力encodingも検査子プロセスだけで修正し、最終`npm run verify`は通常42・制御297・端末25の計364件成功。実status／イベント・名称変更・詳細コマンド登録はMC-09bへ残し、上記MC-09全体のチェックは確定しない。[MC-09a検証・表示契約](../../validation/chat-control/MC-09a.md)を参照。ブランチは`feat/mc-09a-terminal-presentation`。実モデル・実UIの新規受入は`not_run`。

### MC-10: 標準Codex履歴への接続と再開前の照合

**着手・分担:** MC-10aはMC-07の統合後、`src/workers.ts`とそのテストの読取り経路を担当し、MC-08と並列に進める。`npm run build`と`node --test dist/test/workers.test.js`で、閲覧による新turn・権限復元がないことを確認する。MC-10bはMC-07／08／09とMC-10aの統合後に明示再開と操作UIを接続し、下記すべての照合・実機検証を行う。

**Files:** Modify `src/workers.ts`, `src/mcp.ts`, `src/cli.ts`, `extension/src/extension.ts`, `extension/package.json`; Test `test/workers.test.ts`, `test/control.test.ts`, `test/mcp.test.ts`。

**Interfaces:** 保存済みthread IDと現在のidentityを使い、MC-02で確認した公式履歴APIへ接続する。履歴閲覧は読取り操作、再開は別の明示操作として扱う。

- [x] `history_view_does_not_start_turn_or_restore_permissions`：履歴を開くだけではモデルturn・旧grant・停止済みrunを再開しないことを確認する。
- [x] `resume_checks_codex_history_git_and_execution_records`：provider、thread、worktree、branch、未完了操作、停止結果を照合し、工程表や会話の「完了」だけで統合・テスト済みにしないことを確認する。
- [x] `restart_keeps_pending_decisions_and_unknown_operations`：未解決相談を一覧へ戻し、旧フォームを自動再利用せず、未知の配送を再送しない。元threadが使えなければ理由と引継ぎ案を提示する。
- [x] 標準クライアントに履歴を開く公開経路があれば利用する。なければ対応済みの公式APIと明示的なthread選択を使い、非公開deep linkや独自の全文会話ミラーを作らない。
- [x] `npm run build`、`node --test dist/test/workers.test.js dist/test/control.test.js dist/test/mcp.test.js` を通し、VS Code再起動後の閲覧と明示再開を別試行で検証してcommitする。

MC-10bの実装記録（2026-11-18）: MC-09bが入った `14795ed` から、MCP・CLI・VS Codeの履歴操作と照合後の明示再開を実装した。旧grantを安全にリセットできることが未確認のため、確認済みのworktreeから新しいスレッドへ引き継ぐ。最終差分の指定テスト94件が成功し、専用VS Codeの再起動後に閲覧と再開準備を別試行で確認した。試験にはMockCodexを使い、実モデル送信は `not_run`。日英READMEと運用案内を更新した。[MC-10b検証記録](../../validation/chat-control/MC-10b.md)

### MC-11: 専用環境の導入診断と設定生成

**着手・分担:** MC-11aはDE-06の診断・snapshot・生成・復元基盤を読み、重複実装を避けて現行設定の診断と導入案内を整える。MC-07bと並列に、`npm run build`と`node --test dist/test/install.test.js`で確認する。MC-11bはMC-07／08の統合後、確定した版2・権限・上限設定の生成と復元を仕上げ、下記の生成・配布回帰を完了する。MC-09bと並列に進められる。

**Files:** Modify `src/install.ts`, `scripts/install.ps1`, `scripts/uninstall.ps1`; Test `test/install.test.ts`, `test/package.test.mjs`; Update `docs/releases/INSTALL.ja.md`, `docs/releases/INSTALL.en.md`。

**Interfaces:** `EnvironmentReport = { tools: Array<{ name: string; path: string | null; version: string | null; sha256: string | null }>; blockers: string[]; warnings: string[] }` を `src/install.ts` に定義する。`InstallationSpec` は同ファイルの既存 `Spec` schemaから推論する型を公開して使用する。`inspectEnvironment(input: Partial<InstallationSpec>): EnvironmentReport` は読取りのみ、`prepareInstallation(input: InstallationSpec, report: EnvironmentReport): InstallationSpec` は明示した専用配置先へ設定を生成する。既存 `install`／`uninstall` とreceiptを再利用する。

- [x] `diagnostics_do_not_edit_normal_profile`：exe、バージョン、hash、公式拡張、sandbox対応、認証の有無を診断し、通常settings、通常CODEX_HOME、PATH、registry、OSポリシーを変更しないことを確認する。
- [x] `generated_configuration_binds_explicit_parent_and_repository`：親thread・repo・計画・Git範囲を提示し、最新チャットの推測や認証ファイルコピーで結び付けないことを確認する。
- [x] `codex_update_requires_compatibility_validation`、`uninstall_preserves_later_user_changes` を追加する。hashだけを自動更新せず、正式な再検証へ誘導する。専用ファイルと実成果を区別する。
- [x] Nodeの既存同梱を使い、未導入のVS Code/Git/CodexやOS setupは正規経路を調べる。承認済み範囲の導入準備・実行・検証はエージェントが行い、新しい影響の承認や本人限定入力が必要な箇所だけを依頼する。管理者権限やネットワーク制限を回避する自動設定は行わない。
- [x] `npm run build`、`node --test dist/test/install.test.js`、`node --test test/package.test.mjs` を通し、専用環境の生成・復元を確認してcommitする。通常profileへの移行や公開配布は別の明示依頼で行う。

MC-11aの実装記録（2026-11-18）: DE-06の既存診断を再利用した読取り専用の導入診断と、日英の専用導入案内を追加した。`InstallationSpec` は既存schemaの型を公開し、公式拡張・VS Code・版metadataは任意の第2引数として既存DE入力を明示する。schema・installer・receiptは変更しない。現在PCで判明したsnapshot配置の誤判定と、独立レビューで判明したPowerShell 5.1の引用符の問題をRED→GREENで修正した。型・build、installer16/16、端末15/15が成功。通常テストは42件中41成功、既存native表示切断テストのtimeout1件は単独再実行で成功した。現在PCの読取り診断はblocker 0、参照ファイルは診断前後で一致。詳細と全体回帰の区別は[MC-11a検証記録](../../validation/chat-control/MC-11a.md)を参照。版2・新権限・上限設定の生成、スクリプト・配布物の受入はMC-11bへ残し、MC-11全体や実モデル・実UI・OS隔離の受入は完了扱いにしない。

MC-11bの実装記録（2026-11-18）: 版2工程表・親thread・repo・Git範囲を明示して、MC-07の権限上限と回数設定を持つ専用設定を生成する。導入時に対象パスとhashを照合し、復元時は利用者による後の編集と成果を保持する。installer 17/17、配布物 3/3 で、展開したZIPの同梱Nodeから設定生成・導入・復元を確認した。全体の `npm run verify` は通常42・制御347・端末25の計414件成功。詳細は [MC-11b検証記録](../../validation/chat-control/MC-11b.md) を参照。実モデル・実UI・追加のOS隔離・公開は `not_run`。

### MC-12: 統合受入と運用文書

**着手・分担:** 文書の下書き・既存受入との対応付けはMC-10bと並列に進めてよい。機能説明の確定、全体回帰と実機受入はMC-03〜11の受入後に行う。統合担当が固定したcommit・専用環境・有限送信枠を使い、枝番の成功や他担当の別commitでの検証結果を最終受入へ読み替えない。

**Files:** Modify `test/acceptance.test.ts`, `test/live/acceptance.ts`, `test/live/parallel-merge.ts`, `skills/codex-chat-coordination/SKILL.md`, `skills/codex-chat-coordination/references/plan-and-report.md`, `README.md`, `README.en.md`, `docs/chat-control-reference.ja.md`; Create `docs/validation/chat-control/worker-coordination-acceptance.md`。

**Interfaces:** 新ツール、plan版2、任意回数枠、増員承認、保留・退役、名前・表示、公式履歴、導入診断を利用者向け契約として記載する。旧版との差と設定移行を明示する。

- [x] `npm run verify` を一度通し、失敗した検証だけを原因修正後に再実行する。通常テストへ実モデル・GitHub接続を混ぜない。
- [x] 実機A：2人から3人以上への提案・選択式回答・承認後の起動・N件統合・最終SHAの検証を確認する。承認前の追加起動と別runへのgrant流用を拒否する。
- [x] 実機B：仕様不足を相談しつつ別ワーカーが継続、人との相談・改訂・再指示・該当工程の再開を確認する。取消・人の入力中・遅延回答・複数相談も扱う。
- [x] 実機C：次タスクのmodel/effort/profile切替、auto-reviewの適用、管理領域保護、前ターンのGit grant非継承、読み取り専用報告の採用を実機で確認する。
  - 拒否時の扱いは、OSによる書き込み拒否を実機で、自動レビュー拒否を同じターンで上書きしない処理を回帰テストで確認した。Workerの実行時に自動レビュー自身が拒否した例は未観測。追加の実機試行は今回の受入範囲外とした。
- [x] 実機D：役割名表示、具体活動、相談状態、終了後タブ保持、退役、実行中タブ削除、親停止、broker切断、VS Code終了、標準履歴閲覧と明示再開を別々に確認する。
- [x] 実機準備・VS Code操作・MCP停止・終了確認・復元を1.7節に従ってエージェント自身で進める。人へ依頼した操作は必要性・制約の根拠を記録し、正式同意と通常の画面操作を一括して「人が担当」としない。操作ツールが使えない場合はその部分の未確認を明示する。
- [x] 実機の送信回数はこの試験に対して有限値を明示する。通常運用のデフォルト無制限と混同せず、正式認証・許可範囲・ネットワークがなければ該当項目だけ `not_run` として報告する。
- [x] README・運用スキルの「最大2」「12回／2回固定」「停止」「履歴」「権限」の説明を実装済み仕様に合わせる。未実証の標準機能・PC性能・無停止保証を記載しない。差分、互換性、秘密混入、未解放lockを自己レビューしてcommitする。
- [x] 運用リファレンス・導入案内・レビュー手順の手動操作指定を点検し、本人限定の同意以外はエージェントが実行できるAPI／CLI／UI経路と終了確認へ更新する。手動の代替手順は残してよいが、それだけを理由に自律実行を打ち切らない。

2026-11-18の[MC-12・モデル調整の総合受入記録](../../validation/chat-control/worker-coordination-acceptance.md)に、実フォームでの3人への増員、Git障害からの引継ぎと最終SHAでの統合採用、実機で見つかった表示修正を記録した。実機Aは新しいrunで前回の増員許可を引き継がず、3人目の承認前拒否から3候補の最終SHA検証まで確認した。再起動後に実機Bは改訂後の再配送・取消・フォーム再表示・親の未送信入力の保持、実機Dは履歴再開・実行中タブ削除・親からの停止・独立したbroker切断を確認した。11月19日の追試では、実機Cで書き込み可の担当から読み取り専用の別モデルへ引き継ぎ、実際の書き込み拒否まで確認した。専用VS Codeで前ターンの追加Git権限の非継承を実測し、親が読み取り専用報告を対象SHAで採用して後続工程が開くことを確認した。自動レビュー拒否についての確認範囲は総合受入記録を参照。

## 6. 実装時の判断と範囲の境界

| 項目 | この計画での扱い |
|---|---|
| 2人超の提案UI、自由記述、human-originの照合 | MC-02で対象版を実証。標準経路を優先し、見た目だけのmockを受入にしない |
| 同じ履歴への権限縮小 | 実適用を確認できなければ新threadへ引継ぐ。権限継承を黙認して履歴再利用を優先しない |
| コーディネーターのFull Accessとハーネス保護 | ソフトウェア上のルールとOS上の強制を区別。絶対保証が必要な環境だけ実権限制限を設計する |
| 重いビルド・テストの同時数 | 固定値は未合意。MC-06の実測から最小の資源予約を追加し、必要な値を提示する |
| 全体一覧 | 既存拡張の簡易一覧から開始。独立Webダッシュボードは別案件 |
| 自動暴走判定 | 同じ失敗・進捗なしを通知できる事実から扱う。一般的な暴走判定AIや完全無人完走保証は作らない |
| macOS/Linux、独立アプリ、VS Code終了後の実行 | 今回の範囲外 |
| API課金移行、外部公開、Marketplace、自動更新 | 今回の範囲外。暗黙に実施しない |

## 7. 完了条件と検証記録

- [x] 通常2人、3人以上は人への提案とrun単位の承認、承認内の交代は再確認不要である。
- [x] 表示名を役割・ブランチ風の名前へ変えられ、内部identity・配送先・Git branchを変えない。
- [x] 次タスクでmodel/effortと委任範囲内の権限を選べ、適用を確認し、古いgrantを引き継がない。
- [x] 親宛相談、人宛相談、正式権限承認を区別し、標準の選択式＋自由記述で回答できる。
- [x] 未承認の依存作業を止め、独立作業は続ける。待ちによる見かけ上の枠解放で人数・資源制約を破らない。
- [x] 仕様不足から代替案を調べ、人と合意した改訂だけを対象版へ反映して再開できる。
- [x] 回数上限は未指定/nullで無制限、試験用の有限指定は有効で、安全停止は常時残る。
- [x] ターミナルに作業・相談・待ち理由・活動時刻が表示され、プロセス終了後もタブが残る。
- [x] 履歴と再開は標準Codexを使用し、実状態はDB・Git・停止結果と照合する。
- [x] 既存の直列・2人並列・Git受入・停止・質問・正式承認・設定復元が回帰しない。
- [x] 導入診断と専用設定生成で通常環境への暗黙変更をしない。
- [x] 承認済みの準備・システム操作・VS Code操作・MCP停止・検証・復元を可能な限りエージェントが完遂し、人へ残した操作には実際の制約と根拠を示す。レビューでも同じ基準を適用する。

文書作成時の検証は、合意仕様との照合、既存ファイル・参照先・コマンドの存在確認、Markdown構造と差分の確認までとする。この計画を保存しただけで、上記機能・テスト・実機受入を完了扱いにしない。

実装時の結果は工程ごとに、変更、検証コマンドと結果、未確認事項、README更新、branch・commit・push結果を記録する。実装順序やinterfaceの軽微な調整は既存規約と最小変更で決め、合意した仕様の変更が必要な場合だけ人に相談する。
