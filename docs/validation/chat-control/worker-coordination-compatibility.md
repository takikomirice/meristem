# MC-02: Codexの質問・自動レビュー・履歴の適合確認

2026-11-17（日本時間）。[工程表 MC-02](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md#mc-02-標準codexの質問自動レビュー履歴経路の適合確認)の検証コードと対応表。プロダクトの承認経路・権限・APIは変更していない。

**状態: MC-02完了（互換性確認の範囲）。** [再開記録](#現在pcでのmc-02再開)で、明示評価APIによる実allow/denyと人による実UI回答を確認した。以下の先行PCの対応表・中断記録は当時の観測として保持する。fixture、明示評価、実行承認ゲート、実UIの観測を混同しない。

## 対象と証拠の区別

| 対象 | 値 |
|---|---|
| OS / Node | Windows x64 / v24.22.1 |
| VS Code Codex拡張 | `openai.chatgpt-26.1111.21308-win32-x64` |
| 同梱Codex | `codex-cli 0.169.0-alpha.11.1` |
| 同梱exe SHA-256 | `a473edef0d52c4ffa067060ddd48a3d85720a3256cbd0510aab71d406f3af744` |
| SDK | 既存 `@modelcontextprotocol/sdk` 1.32.2 |
| schema | 対象exeの `app-server generate-ts --experimental` で生成 |

PATH上のCodexは別版 `0.169.0` だったため採用していない。生成物の型名は対象版での事実であり、別版への保証ではない。過去のCC-04/CC-07の結果を今回の成功には算入しない。

- `schema`: 生成型に存在する。実行・表示されたことは意味しない。
- `fixture`: MockCodex＋実WorkerRuntime／WorkerRequests／MCP SDK／native hostで再現。人が回答した証拠にはならない。
- `observed`: 実Codexから対象ID・設定を照合できる応答を得た。profileのACKだけで実OSのアクセス制御までは証明しない。
- `rejected` / `unconfirmed`: 明示的RPC拒否／応答や照合の未確認。承認・適用・未配送と読み替えない。
- `not_run`: 試験していない。fixtureの成功で置き換えない。

## 対応表

| 経路 | 対象版のschema | 現行MeristemとMC-02の確認 | 後続工程への条件 |
|---|---|---|---|
| 構造化質問 | `item/tool/requestUserInput`; `ToolRequestUserInputParams` は `threadId`, `turnId`, `itemId`, `questions`, `isBlocking`, nullable `autoResolutionMs` | 1〜3問を受理。各問の `id`, `header`, `question`, `isOther`, `isSecret`, nullable `options` をfixtureに反映。選択ラベルと日本語自由記述を元のRPC IDへ返す。欠落・重複配送・解決後の遅延回答を拒否 | `answer_request` から親が回答できるため、人間専用adapterとして流用しない |
| 質問の回答 | `ToolRequestUserInputResponse`: `answers: { [questionId]: { answers: string[] } }` | 問ごとの回答を保持。質問への回答と正式権限承認を分離 | 文面が「承認」でも権限grantにしない |
| 非blocking質問 | `isBlocking`; `autoResolutionMs` はdeprecated | 現行WorkerRequestsは保守的にblocking扱い。解決通知後の回答は送らない | 新しい非同期APIが使えるとは仮定しない。相談とpermission RPCの分離はMC-03/04 |
| MCPフォーム | `mcpServer/elicitation/request` の `mode: form`; `requestedSchema` のobject propertiesに文字列enumと自由文字列を指定可能 | 既存 `createMcpServer` は空schemaの承認確認のみ。構造化schema、`openai/form`, `openaiForm`, `url`, `openai/userVerification` はWorkerRequestsで未対応のまま保留 | 相談用フォームschemaと回答検証をMC-03で追加。未対応を空の成功応答で通さない |
| MCP回答 | `McpServerElicitationRequestResponse`: `action: accept/decline/cancel`, nullable `content`, nullable `_meta` | 実MCP SDKのcallbackでcancel/declineを元要求に配送。切断はpending、旧formGenerationへの遅延acceptは送信しない | `accept`時の構造化content検証はMC-03。取消・無回答を同意にしない |
| 人間専用の配送 | MCP `server.elicitInput` → callback → native `mcp_human_response` → `McpController.humanResponse` | モデル向けtool一覧に回答用のhuman endpointを公開しない既存構成。owner/turn・requestKey・payloadHash・formGeneration・現在状態を照合。既存mcp試験も実行対象 | callbackの到着だけで実UIのクリックを証明しない。実UI由来の回答は今回 `not_run` |
| 自動レビュー選択 | `ApprovalsReviewer = user / auto_review / guardian_subagent`; `thread/start`, `thread/resume`, `turn/start` に `approvalsReviewer` | probeは明示指定し、`ThreadStartResponse.approvalsReviewer` と `activePermissionProfile.id` を検査。不一致・RPC拒否をfixtureで区別。実 `auto_review` の設定ACKも観測 | schema対応だけでは有効化しない。実行時の接続はMC-07 |
| 自動レビューの結果 | `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`; `review.status = inProgress/approved/denied/timedOut/aborted`。completedには `reviewId`, `threadId`, `turnId`, `targetItemId`, `decisionSource`, `action` 等 | 実際のレビュー判断は `not_run`。probeの文字列応答ターンからレビュー成功を推測しない。rationaleやraw通知を保存しない | reviewer選択・設定のACK・個々の承認／拒否を別の証拠として確認する。拒否を親のFull Accessで上書きしない |
| permission profile | `permissions` と `sandbox` は併用不可。`activePermissionProfile: { id, extends }` | 既存 `permissionOverrides` を再利用して `meristem-managed`、`:workspace`継承、管理stateへのdenyを指定。実 `user`指定でprofile IDのACKを観測 | OS・組織制限、人間限定同意は別境界。実OSアクセス検証やタスク単位の権限選択はMC-07 |
| 履歴閲覧 | `thread/read { threadId, includeTurns }`; 本文のページングは `thread/turns/list` / `thread/items/list` を推奨する生成コメントあり | `includeTurns:false` の実応答を観測。新規の未実行threadに対する `true` は拒否。1ターン完了後は `true` で1件取得を観測。probeは本文を保存せず件数だけ記録 | 表示だけで新turnを開始しない。Meristemに全文会話保存を追加しない |
| 履歴再開 | `thread/resume { threadId, ...settings }`; 設定は再指定可能。`history` / `path` の優先規則があるためprobeは使わない | ID・cwd・reviewer・profileを再照合。未実行threadでは拒否、1ターン完了後は実RPC応答を観測。既存WorkerRuntimeの新attempt・ownerEpoch、旧WorkerRef拒否、clean Git条件は回帰試験で確認 | 今回のlive resumeは同じapp-server内。別プロセスでの再開はfixtureのみ。再開後の追加turnは送っていない |

生成型の照合用SHA-256:

| ファイル（生成先の `v2/`） | SHA-256 |
|---|---|
| `ToolRequestUserInputParams.ts` | `0e3063b70a99b815e170b3c157416924315308a1c8af201dcc2f3fb459e4144a` |
| `McpServerElicitationRequestParams.ts` | `16ab3fb70ebd4b68522432f718cc49a6e43cd78e03ee7734e2bdb7c2a101df4c` |
| `ApprovalsReviewer.ts` | `0ba0d2403a6987128af58e825fb0d0e05d61891ce5a35e7ba1f94afe51a57630` |
| `ThreadStartResponse.ts` | `62762558532dab6b3113a8e9385e282b05a7a1e68b9a31bb508a5d9acff45f26` |
| `ThreadReadParams.ts` | `c24743cb5655b4c71a853a2a290412d78e1a27e0278f2a0cde9bd9d9b78118a8` |
| `ThreadResumeParams.ts` | `6ea6561448792277f9b52ac9d920d71ef8c9be6e43621ee6329fb948329e8ff7` |

## 親のフォーム待機と独立作業

`waiting_parent_elicitation_keeps_dispatched_worker_running_and_inbox_durable` は、先にBへ作業を送り、Aの要求をStoreへ保存した後、親側のMCP elicitationを未回答のまま保つ。Bのturn終了・nativeの終了確認まで進んでも、親toolは未完了でAの要求はDB上pendingのまま。最後にfixtureのcancelを元RPCへ送り、解決通知を待つ。

これは既に配送した独立作業の継続の証拠である。実Codexの親turnがフォーム待機中に新たなモデル判断・追加配送を行える証拠ではない。初期運用では独立作業を先に配送し、相談inboxを永続化する。待機中の追加判断が必要なら、回答後に既存wake cursorで通知を集約する。自然文から継続可能範囲を推定する新しいサービスや独自TUIは追加しない。

## 実機で観測した制約

実機probeは既存の正式認証済み専用CODEX_HOMEと、新規のprobe専用work/stateを使用した。通常設定や拡張キャッシュは編集していない。標準sandboxで初期化を確認できなかったため正規の権限昇格で再試行し、`account/read` の認証状態を確認した。認証応答・ユーザー情報は記録していない。

`auto_review`指定は15秒、続いて60秒の `thread/start` 待機で応答を確認できなかった。比較用の `user`指定ではprofileとmetadata readの成功を観測したが、明示モデル付きの1ターン試験でもthread開始がタイムアウトした。その後、明示モデルの `auto_review`試験でreviewer/profileのACKを観測し、別の1ターン限定試験では完了・履歴取得・再開まで成功した。断続的な開始タイムアウトの根本原因は未特定で、自動レビュー固有の非対応とは断定できない。結果不明の要求を同じthreadへ再送せず、試行ごとに新しいrootを使った。実モデルturnは全試行合計1回。nativeのjob閉鎖・子プロセス終了とhost終了を記録した。

専用VS Codeの起動補助はComputer Useからの実行が拒否され、ユーザーがexeを直接実行した後に専用ウィンドウへ接続できた。通常のCodex画面で試験プロンプトを入力したが、送信前に作業終了の指示を受けた。UIモデル送信は0回、フォーム表示・人からの回答は未観測。Computer UseはユーザーのEscape操作で停止したため、専用ウィンドウの閉鎖は未確認。一時的に追加した専用CODEX_HOMEのMCP設定は除去し、元のconfig SHA-256との一致を確認した。専用ウィンドウに未送信の試験文が残り得るため、再開時にそのまま送らない。取消・閉鎖等の成功はfixtureの範囲に限る。

追加の `guardian-probe` は記録したtool callを実行せず、明示的な `thread/guardianReview` で最大2件の判定を要求する試験。通常のauto-review承認ゲート通過とは区別する。初回は履歴投入 `thread/inject_items` の15秒待機で失敗し、レビュー送信は0件。失敗段階・protocol code・時間の記録と失敗後の停止を追加し、投入待機を120秒にした再試行は `thread/start` の60秒待機で失敗、レビュー送信は0件。両試行ともnative停止・host終了を確認し、実際の承認／拒否は観測できていない。[MC-02実機証拠](evidence/MC-02-compatibility.json)を参照。

## 再実行

```powershell
npm run build:native
npm run build
node --test dist/test/requests.test.js dist/test/workers.test.js dist/test/mcp.test.js
npm run verify

# 対象の同梱exeを明示する。PATH上の別版で代用しない。
& $codexExe app-server generate-ts --experimental --out '.local/mc02/schema'

# $probeRoot は新規の専用ディレクトリ、$authHome は正式認証済み専用home。
# コマンドは証拠を収集する。exit 0だけでは各機能の成功を意味しない。
New-Item -ItemType Directory -Path $probeRoot
node dist/test/live/approval-roundtrip.js compatibility --live --root $probeRoot --real-exe $codexExe --auth-home $authHome --max-turns 0
```

結果は `$probeRoot/compatibility.json`。`source`, `requestedReviewer`, executable hash、各checkの状態、送信数、終了確認を読む。`--reviewer user` で比較試験ができる。既存rootは再利用できず、初期化／配送不明は自動再送しない。probeは新しいthreadの状態を書き込むが、CODEX_HOMEの設定を書き換えない。

履歴の永続化確認には別の新規rootで `--max-turns 1 --model <catalogのmodel> --effort <対応effort>` を付ける。正式認証・実適用profile・reviewer・model catalogが確認できた場合だけ、固定の短い応答を1回依頼する。tool・command・network・subagent・ファイル変更は禁止するプロンプトであり、個々のツール実行を計測する試験ではない。未指定は0回、0/1以外は拒否し、送信前に回数を予約する。実レビュー判断やUI回答を観測する機能はこのprobeにないため、常に独立した `not_run` として残す。

`ui-probe --live --root <専用root>` はstdio MCPサーバーで、`mc02_questions` の引数は空。enumと自由記述の標準フォームを表示し、回答をスキーマ検証する。最大3要求、各10分、送信前の予約、formGeneration・schema hash・回答hashを記録し、自由記述本文は保存しない。fixtureのcallback成功を人の実回答として扱わない。再開時は正式な専用MCP設定を再準備し、画面表示・人の回答・元要求への対応をMC-02で確認する。

## 終了時の検証記録

- native build、TypeScript build/typecheck成功。制御系199件、端末UI系14件成功。後から追加したguardian試験2件も成功（投入拒否・レビュー拒否の段階区別、再送なし、停止を含む）。追加後の全体再実行は終了指示により未実施。
- `npm run verify` はrelease ZIP試験の180秒timeoutで失敗。全体成功とは扱わない。パッケージ生成コードは今回未変更。
- `ui-probe` の標準MCP callback試験、複数質問、pending中の独立worker、互換性probeの拒否・不一致・モデルページングを個別検証済み。
- 一時ファイルと詳細ログはgit管理外の `.local/mc02/` に保持。認証情報、自由記述本文、レビューrationale、履歴本文は公開証拠へ保存しない。

## 現在PCでのMC-02再開

同じ2026-11-17、日本時間。先行PCとは異なる環境であるため、新しいrootと[専用証拠](evidence/MC-02-current-pc.json)を作成した。現在PCで準備済みの正式認証済み専用home、同じ拡張版・Codex版・exe hashを照合し、ChatGPT認証を確認した。別の認証経路へ切り替えていない。

### 実レビューの判定

`guardian-01` は最大2評価・実行turn 0回。reviewer=`auto_review`とprofile=`meristem-managed`のACKを得たが、許可を期待した読取り先が管理profileのdeny領域に含まれており、両評価ともdenyだった。この事実を保持し、拒否を上書き・再送しなかった。

許可ケースを既存の作業領域にある別の試験ファイルへ修正し、fixtureのRED→GREENを確認した後、新しい `guardian-02` を実施した。

| 対象 | 実評価 | 照合 |
|---|---|---|
| 許可された作業領域の試験ファイル読取り | `allow` | thread `fixture-id-02`、call `mc02-allow-review` |
| 明示的に禁止した管理領域のバックアップ削除案 | `deny` | thread `fixture-id-03`、call `mc02-deny-review` |

これは実Codexの `thread/guardianReview` が返した評価であり、fixtureの判定ではない。最大2評価、実行turn 0回、試験ファイルのhash不変、native job閉鎖・子プロセス終了・host終了を確認した。レビュー対象のコマンド文字列を実行APIへ渡していない。通常の実行承認ゲートの `item/autoApprovalReview/completed` を観測した証拠にはしない。そのためprobeの `autoReviewDecision` は引き続き `not_run` で、明示評価の `reviewAllow` / `reviewDeny` と分けている。

### 人による実UI回答

専用MCP設定、試験文、専用VS Codeの起動をエージェントが準備した。現在のComputer Use guidanceは `Do not automate ... Codex CLI or Codex extensions within Windows apps.` と禁止しているため、Codexへの試験文の送信とフォーム回答だけ本人へ依頼した。本人の「おくった」という返信と、以下の公式MCP callbackを照合した。本人の代わりにフォームへ入力していない。

| 観測 | 結果 |
|---|---|
| Codex client | `codex-mcp-client` / `0.169.0-alpha.11.1` |
| 会話・turn | `fixture-id-05` / `fixture-id-06` |
| モデル・推論強度・送信数 | `gpt-6-luna` / `low`、公式履歴で1ターン完了、対象MCP呼出し1回 |
| 元tools/call ID | `2`。elicitation自体のJSON-RPC IDとは区別する |
| formGeneration | `fixture-id-04` |
| 回答 | `accept`、選択肢`JSON`、指定の自由記述との一致を確認 |
| 版・内容の照合 | exe hash、client版、requestedSchema hash、formGeneration、answer hashを記録 |

公式履歴の対象tool呼出しは `functions.exec` が待機cellを返し、そのcellを指定した `functions.wait` の応答に同じformGenerationが含まれる経路だった。呼出しIDとwaitのIDを同一と仮定せず、cell IDを結んで確認した。公開証拠にはcellの内部値、認証応答、会話本文、自由記述本文、レビューrationaleを保存していない。

この試験はMCP SDKの人向けcallbackを確認したもので、モデルから渡された `humanApproved` のような値を人の同意にしたものではない。MC-03ではこのcallback内で保存済みのdecision ID・plan/proposal hash・formGenerationを照合する必要がある。MC-02の試験用endpointをそのまま正式な権限grantに使わない。

### 後始末と留保

専用ウィンドウへ通常終了を要求し、捕捉したプロセスhandleの終了を確認した。共通の厳格な停止runnerは、並行テスト中に新しいグローバルプロセスを検出して `unknown` を返したため、成功へ読み替えていない。追加のOS照合で記録したroot PIDの不在と専用profileのidleを確認した。設定は同時変更がないことをhashで確認してから開始前のバイト列へ復元し、元のhash一致を確認した。通常の作業ウィンドウは保持した。

実UIの取消・閉鎖・遅延回答は今回追加観測しておらず、対応するfixtureの成功と区別する。別プロセスでのlive resume、通常の実行承認ゲート、タスク単位の権限適用は未実施。先行PCの履歴閲覧・同一app-server内resumeの証拠はその範囲で保持する。MC-03以降のプロダクト経路へは進んでいない。READMEの利用方法は変わらないため更新していない。

### 再開時の最終検証

- native build、型検査、TypeScript／拡張build成功。着手時のrequests/workers対象52件成功。追加した照合情報と許可ケースの修正は、対象2件のRED→GREENを確認した。
- `npm run verify` は4回試行した。1・3回目は別テストが使用中のnative exeへの書込みがCS0016で拒否された。2回目は通常42件中、既存の `broker_eof_during_initialize_closes_the_owned_job` の終了直後のPID確認1件が失敗。4回目は通常42件中、既存の `malformed_or_disconnected_display_client_does_not_stop_worker` の一時ディレクトリ削除がEPERMで失敗した。いずれも全体成功とは扱わない。
- 失敗した2テストは単独で再実行して成功。最後に `node --test --test-concurrency=1 test/*.test.mjs` 42/42、`npm run test:control` 244/244、`npm run test:terminal` 14/14、合計300件成功。通常テストを直列にした検証結果であり、標準 `verify` がそのまま成功したという記録ではない。テスト条件やnativeの停止確認は緩和していない。
- 独立した読取りレビューでCritical／Important／Minorの修正指摘なし。実評価・UI callback・生成schemaの公開証拠がローカルの観測と一致することを照合した。自己レビューでも今回の6ファイル以外の変更、権限や公開APIの変更、認証情報の混入がないことを確認した。
- 元ログ・RED／GREEN・実行結果は `.local/mc02-current/` に保持。並行作業のDE-05／DE-06や工程分割の文書変更は今回のコミットに含めない。
