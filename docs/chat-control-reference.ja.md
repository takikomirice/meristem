# 導入・運用・検証リファレンス

[日本語の概要](../README.md) | [English overview](../README.en.md)

旧READMEの詳細手順と工程別の説明を保持しています。本文の「親／親チャット」はコーディネーター、「子／子チャット／子CLI」はワーカーを指します。ワーカーは独立したCodex CLIチャットで、内部サブエージェントとは区別します。以下のコマンドはリポジトリのルートから実行します。工程ごとの記述はその時点の確認範囲を示します。最新の総合受入は [CC-07継続受入記録](validation/chat-control/CC-07-continuation.md)を参照してください。

Windows版VS Codeの通常Codex拡張を親に残し、専用子CLIを統合ターミナルで表示・停止する接続実証です。CC-02で明示した試験用Git範囲に限る親／子MCPを接続し、CC-03で報告から親を再開して次の子へ進む主要経路を確認しました。CC-05の工程表と直列Git受入に加え、CC-06で2担当の並列配送と候補を固定したGit統合を追加しています。CC-07の導入・復元・ローカル配布手順は下記を参照してください。通常profileへの導入は実証結果の確認後、別途明示操作で行います。

**CC-02は専用fixtureの範囲で実機受入を完了しました。** 実親PからA/Bへ指示し、人のMCP承認後の報告保存、正常完了Aの同履歴・新attemptでの再開と想起、親による最終確認を実証しました。その受入ではCC-04の限定承認入口を先行実装しました。現在の質問・承認経路は下記CC-04の説明を参照してください。過去の起動・切断失敗の原因は未特定で、安定性保証や通常導入の完了を意味しません。[CC-02の結果・範囲・制約](validation/chat-control/CC-02.md)を参照してください。

**CC-00Rの受入を完了しました。** 子ごとのJob Objectで、実Codexが公式sandbox内に起動したshellと孫プロセスを停止できました。タブ閉鎖、明示停止、broker EOF、host強制終了、VS Code終了を別々に確認しています。[CC-00Rの結果・範囲・制約](validation/chat-control/CC-00R.md)を保持しています。CC-01の新しい管理経路の確認範囲は[CC-01結果](validation/chat-control/CC-01.md)を参照してください。

2026-11-15の[実装計画](superpowers/plans/2026-11-15-codex-chat-control-implementation.md)・[設計](superpowers/specs/2026-11-15-codex-chat-control-design.md)に沿う、専用profileだけの実装です。子への直接入力と対話型TUIはありません。旧方式ではUI停止後もコマンドが続いた[CC-00の結果](validation/chat-control/CC-00.md)を履歴として残しています。

必要環境はWindows x64、Node.js 24.22.1以上、Windows標準の.NET Framework x64コンパイラです。

## v0.1.0のビルド済み本体パッケージ

[Release](https://github.com/takikomirice/meristem/releases/tag/v0.1.0)のWindows x64用ZIPには、本体JavaScript・DB初期化SQL・3つのnative実行ファイル・補助拡張VSIX・Node.js・固定したnpm依存とライセンスを含めます。利用者側のコンパイルやNode.jsの別途導入は不要です。[配布版の案内](releases/INSTALL.ja.md)に従い、専用環境の認証・設定・実行許可を別途行います。

開発者が同じ形式を再作成する場合は、下記の必須検証後に、選択したNodeの版に対応する公式 `SHASUMS256.txt` とNodeソースの `LICENSE` 全文を準備して実行します。Nodeの `win-x64/node.exe` hashを照合し、出力先は未使用のディレクトリにします。

```powershell
npm run package:release -- -OutputDirectory '<新規の出力先>' -NodeExe '<検証したnode.exeの絶対パス>' -NodeLicensePath '<同じ版のNode LICENSEの絶対パス>' -NodeChecksumsPath '<公式SHASUMS256.txtの絶対パス>'
```

出力する公開資産はZIP、補助拡張VSIX、`SHA256SUMS.txt`です。作業用の展開ディレクトリ、Git bundle、認証・設定・管理状態はアップロードしません。`release-manifest.json`にはsource commit/tree、dirty状態、Nodeの版・hashと各同梱ファイルのhashが入ります。公開資産はcleanなタグ対象から作成します。

## CC-07: スキル・導入・復元

[検証結果と未確認項目](validation/chat-control/CC-07.md)、[親／子の運用スキル](../skills/codex-chat-coordination/SKILL.md)、[工程表・報告形式](../skills/codex-chat-coordination/references/plan-and-report.md)を用意しています。スキルの入口を親への依頼で明示し、子にも報告契約を渡してください。利用者のグローバルskillsや配布キャッシュには自動コピーしません。

VS Code 1.90以上、Windows x64、Node 24.22.1以上を必要とします。`npm ci`で固定した依存を導入し、`npm run verify`でnative・TypeScript・補助拡張・fixtureを検証します。installerは導入済みTypeScriptのJSONCパーサーを利用するため、devDependenciesも必要です。正式なChatGPTログイン済みの専用Codex homeを指定し、APIキーや別の課金方式へ切り替えません。実Codex/Nodeの絶対パス・版・hash、親thread、計画とGit範囲を固定します。

```powershell
npm run verify
npm run package:extension
# 再packageは既存成果を上書きせず新しい出力先へ
powershell.exe -NoProfile -File scripts/package-extension.ps1 -OutputPath '<新規VSIXパス>'
# 指定profile専用の拡張ディレクトリへインストール
& '<VS Codeのbin/code.cmd>' --user-data-dir '<試験profile>' --extensions-dir '<試験extensions>' --install-extension '<VSIXパス>'
```

VSIXは標準ZIPと.NET APIで作り、manifest・実行用JavaScript・MITライセンス本文・第三者ライセンスの案内を含めます。`node_modules`や個人の設定・ログ・検証用状態は含めません。Marketplaceへ公開しません。ローカルVSIX導入は[VS Codeの公式CLI手順](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)に従います。補助拡張IDは互換性のため `meristem-local.meristem-chat-control-fixture` のままです。

`scripts/install.ps1 -NodeExe '<固定node.exe>' -ConfigPath '<install-request.json>'` は、次のJSONを読みます。全パスは絶対パスです。まず専用profileで実証し、通常profileの `settings.json` を指定する操作は、その結果を示した後の明示操作に限定します。

```json
{
  "implementationRoot": "C:/work/meristem",
  "realExe": "C:/pinned/codex.exe",
  "nodeExe": "C:/Program Files/nodejs/node.exe",
  "helperExtension": "C:/test/extensions/meristem-local.meristem-chat-control-fixture-0.1.0",
  "settings": "C:/test/profile/User/settings.json",
  "sourceSettings": "C:/existing/profile/User/settings.json",
  "codexConfig": "C:/test/codex-home/config.toml",
  "controlConfig": "C:/test/prepared/control.json",
  "installDirectory": "C:/Users/USER/AppData/Local/Meristem/install-unique",
  "parentCwd": "C:/test/parent-work"
}
```

`sourceSettings` は任意で、指定時は存在しないsettingsへ内容を複製します。既存settingsを使う場合は省略します。profile全体や認証情報を複製する機能ではありません。`installDirectory` は未使用かつrepo/worktrees外、runの `stateDirectory` とは別ディレクトリにします。準備済み `control.json` はCC-06と同じ契約で、`mcp.scope.plan: true`、空のassignments、明示した `mcp.parentRelay.threadId`、計画のrepo/branch、runtimeの実exe/hash/authHome、Nodeと各entrypointのhashを含めます。具体例は `test/live/cc02-prepare.ts` のCC-07経路を参照してください。親threadを最新活動や名前から自動選択しません。

installerは `chatgpt.cliExecutable` と追加する `[mcp_servers.meristem]` だけを変更し、変更キーの前値・導入値・artifact hashを `installation.json` に保存します。既存MCP namespace、root/dotted/inline形式のMCP設定、重複JSONCキーは曖昧な編集を避けるため書込み前に拒否します。普通の `[mcp_servers.other]` 設定と無関係なJSONCコメントは保持します。handshake・権限・sandbox・ログイン設定は変更しません。インストールだけでVS Codeやworkerは起動しません。

開始時は指定した `CODEX_HOME` とprofileでVS Codeを開き、bindingした親から `start_run` を呼びます。人がローカル `node dist/src/cli.js authorize --run <runId> --state <stateDirectory> --binding <bindingId>` で対象を確認し、親が同じ `start_run` を再度呼んでbindingを消費します。`Meristem: Open Managed Worker Terminals` でそのrunのdiscoveryファイルを明示して接続します。tokenはモデルへ貼り付けません。

| 操作 | 入口と意味 |
|---|---|
| 状態 | 親 `get_status`／ローカル `node dist/src/cli.js status --run <id> --state <dir>`。切断時は読取専用 `needs_reconcile`、停止結果はunknown |
| 子停止 | 対象terminalを選び `Meristem: Stop Current Worker`、実行中タブ閉鎖、または親 `stop_worker`。新規配送とwakeを先に禁止 |
| 全体停止 | 親 `stop_run`、親の通常UI停止、または `node dist/src/cli.js stop --run <id> --state <dir>` |
| 承認 | 親 `answer_request` が正式elicitationを提示、または `Meristem: Review Worker MCP Request`。人だけが回答 |
| 復旧 | 状態・operation・プロセス・Gitを照合し、再起動なら新ownerの人binding後に親 `resume_run`。不明な配送を自動再送しない |
| 計画編集 | 親 `reconcile_plan` にstatusのfileHash/observedPlanHashを指定。生成進捗だけ `write_progress` |
| 戻す | 全体停止と専用window終了を確認後、下記uninstall |

terminalは読取専用です。貼付けや文字入力で子は動きません。パネル非表示・タブ切替は停止せず、完了タブの閉鎖もrunを止めません。表示終了、turn中断、process停止は別で、`stopped` は停止確認後だけです。VS Code終了・拡張再読込みでworkerを自動復元しません。broker再起動は照合と明示再開を要求します。Codexのhashが変わった場合、親の通常通信だけを残して管理口・brokerを無効にします。新しい版を検証するまでhashだけ書き換えて有効化しないでください。

```powershell
powershell.exe -NoProfile -File scripts/uninstall.ps1 -NodeExe '<固定node.exe>' -ConfigPath '<installDirectory/installation.json>'
```

uninstallは現在値が導入値と一致する部分だけ復元します。利用者が値・MCP項目を変更していれば残し、結果の `retained` で知らせます。repo・branch・未コミット変更・SQLite・証拠・VSIX・導入receiptを削除しません。VS Codeの拡張削除は必要時に指定profileで別途行ってください。実行中にnative/distを再buildしたり設定を復元したりしないでください。

CC-07の再現入口は `node dist/test/live/acceptance.js` です。`fixture --evidence <新規絶対JSONパス>` は実ローカルGitと偽runtimeで直列修正・引継ぎ・並列競合解消・MCP拒否・再起動を確認します。`prepare --live --previous <復元済みCC-06/session.json> --root <未使用の.local/chat-control/CC-07配下> --helper-extension <導入済み補助拡張> --extension-dir <公式Codex拡張> --max-turns 20` は既存fixtureの接続条件を再利用し、モデルを呼ばず専用工程表とinstall-requestを作ります。レビュー後に `install --live --session <session.json>`、`launch --live --session <session.json>`、`parent --live --session <session.json> --prompt <指示ファイル>` の順で進めます。上限は親14＋子6。状態は `status`、閉鎖後の復元は `cleanup --window-closed` で、どちらも `--session` を指定します。

実VS Code、正式承認、通常スキル／内部subagent、GitHub readbackはfixture結果から推定せず別々に記録します。既存CC-06のremoteはローカルbareです。GitHub統合受入には指定された非保護の試験repo/branchが必要です。未対応承認、直接CLI入力、TUI、VS Code終了後の継続実行、公開配布、自動起動登録は初期版の保証外です。

直列受入は `prepare` に `--scenario serial` を追加します。A→Bの依存工程表と `node checks.mjs A` / `node checks.mjs A B` を用意し、Aの失敗報告、`retry_same` による同履歴修正、`handoff_new` による新担当への引継ぎ、統合受入後のBと質問応答を実機で確認できます。通常の並列シナリオは既定のままです。復元済みの過去sessionから実行パスを再利用する場合も版/hashを照合し、Windows sandboxを明示する必要がある場合は `--windows-sandbox mxc|elevated` を指定します。試験ごとのターン枠は維持し、追加試験の承認と送信記録を分けて残します。追加の実機確認とGitHub readbackは[CC-07継続受入記録](validation/chat-control/CC-07-continuation.md)を参照してください。

CC-03では、親を推論で待機させずに報告後に再開するbroker処理を追加しました。専用fixtureの実モデル受入の状況は[CC-03検証記録](validation/chat-control/CC-03.md)を参照してください。

CC-04では構造化質問を親の`get_status`で確認し、`answer_request({ runId, operationId, expectedRevision, requestKey, answer: { 質問ID: { answers: [回答] } } })`で元RPCへ回答できます。子が`report`の`question`に自然文の質問を記録してturnを終了した場合は、質問ID `reply`への回答を同履歴の次ターンへ送ります。質問を含む報告は最終成果に数えません。人の承認を`answer`で代用することはできません。対応するローカルMCP承認には、`answer`を省略した`answer_request`から親の正式elicitationを表示し、未対応のクライアントでは補助拡張modalを使います。[対応表と受入状況](validation/chat-control/CC-04.md)を参照してください。

```powershell
npm ci --ignore-scripts
powershell.exe -NoProfile -File scripts/build-native.ps1 -OutputDirectory .local/chat-control-build -WithFixtures
npm test
npm run typecheck:extension
npm run build:extension
npm run test:terminal
# 上記にCC-01の型検査・DB・native管理接続・worker試験を加えた必須検証
npm run verify
```

通常テストは偽Codexと公式SDKの偽MCPクライアントだけを使い、実モデルやGitHubに接続しません。環境の実行ポリシーでPowerShellが拒否された場合は、ポリシーを変更せず、実行を許可された通常のPowerShell環境を使用してください。

## CC-01の管理記録と停止

表示場所はVS Code下部の「ターミナル」です。`Meristem: Open Managed Worker Terminals`で、明示した管理領域の`discovery.json`を選ぶと、担当ごとの読取専用タブを開きます。入力・貼付けは子へ届きません。実行中タブの閉鎖はrunの新規指示とwakeを禁止して対象担当だけを停止し、ウィンドウの管理接続喪失は全担当の停止処理に入ります。正常完了後のタブ閉鎖は表示だけを閉じます。普段のVS Codeへ拡張を自動導入する処理はCC-07です。

管理DB・discovery・credentialはworktree外の専用ディレクトリに置きます。native hostが利用者とSYSTEMだけのACLを設定し、実Codexには`:workspace`を継承して管理領域を明示的に`deny`する`meristem-managed` permission profileを渡します。実行前の無推論sandbox検査で「作業場所は読める／管理領域は読めない」を確認できなければ起動しません。認証ファイル・通常プロファイルの設定・OS承認は書き換えません。

```powershell
node dist/src/cli.js status --run <run-id> --state '<専用管理ディレクトリ>'
node dist/src/cli.js stop --run <run-id> --state '<専用管理ディレクトリ>'
# --state省略時: %LOCALAPPDATA%\Meristem\chat-control\<run-id>
```

brokerが応答しない場合、CLIはDBを読取専用で確認し、`needs_reconcile`と停止確認不能を返します（終了コード2）。過去PIDを推測してkillしたり、結果不明の指示を再送したりしません。再起動後も自動でworkerを再作成せず、終了未確認の作業場所を再利用しません。CC-02では安全に照合できる場合だけ親の`resume_run`で明示再開できます。作業ファイル・Git成果は削除しません。

通信の異常終了では、取得できた失敗カテゴリとhost終了コードを停止証拠へ残します。元の会話やstderrは保存しません。後からプロセス不在を確認できても、開始ACKのない指示は`sent_unknown`のまま扱います。

現在の起動は専用fixture／明示binding用です。`MeristemControl.exe --config <絶対パス>`を、所有元からリダイレクトしたstdin付きで起動します。configは`stateDirectory, repository, runId, pipeName, nodeExecutable, nodeSha256, entryPoint, entrySha256, runtime, assignments`を指定します。Nodeの入口は`dist/src/cli.js`、runtimeはworker hostと本物のexeの絶対パス・SHA-256・認証homeを固定します。設定例を生成して実際に起動する試験は`test/control.test.ts`、モデルを呼ばない実CLI試験は次のコマンドです。

```powershell
powershell.exe -NoProfile -File scripts/run-live.ps1 -Case CC-01 -Live -RealExe '<本物のcodex.exe>' -AuthHome '<認証・sandbox設定済みの専用home>' -Evidence '<未使用の絶対JSONパス>'
```

親relayへ接続する場合は、その専用sidecarに`controlHost: { executable, sha256, configPath, configSha256, parentThreadId }`を明示します。指定した親threadのUI停止だけを管理run停止へつなぎます。broker障害で親の通常App Serverを終了しません。CC-01はこのローカル管理境界までです。

## CC-02の親／子MCP（専用fixture限定）

結果と実機の確認範囲は[CC-02](validation/chat-control/CC-02.md)に記録します。MCP入口は`node dist/src/mcp.js --pipe <明示したcontrol pipe>`です。stdoutはSDKのプロトコル専用です。モデルにcredentialや役割を渡さず、nativeが得た接続元PID・作成identity・所有jobと、実metadataの`x-codex-turn-metadata.thread_id / turn_id`を照合します。登録外root、内部サブエージェント、古いowner／epochの変更操作は拒否します。

job内にいるだけではMCPの身元として認めません。実App Serverの直接の子であること、Node実行ファイルとMCP入口のhash、起動引数、PID／作成identityも照合します。通常のhelperや同じ引数で起動した孫プロセスによる親／子のなりすましを拒否します。

起動configの`mcp`へ`parentRelay: { pipeName, threadId }`、MCPの`entryPoint, entrySha256`、`scope`を明示します。scopeは`fixture: true, planPath, repositoryId, repositoryPath, branchScope, assignments`です。割当はCC-01と同じ形ですが、MCP有効時は起動だけで子を作りません。実Gitのcommon-dir・worktreeルート・branch、実計画hashを確認します。最大2担当、main／masterは対象外です。実機用の生成例は`test/live/cc02-prepare.ts`を参照してください。通常導入用installerではありません。

親の`start_run`で許可待ちbindingを作った後、利用者が次を実行し、表示された実親・計画hash・repo・branch・作業場所を確認してbinding IDを入力します。親／子の所有jobからこの確認を代行することはできません。

```powershell
node dist/src/cli.js authorize --run <run-id> --state '<専用管理ディレクトリ>' --binding <binding-id>
```

親が同じ`start_run`を呼ぶと一回限りのpermitを消費します。`create_worker`、`send_instruction`、`get_status`、子の`report`、停止／再開を利用できます。CC-02互換scopeの`record_decision`は`new_worker`と`continue_history`に対応します。工程表を有効にしたscopeでは、下記CC-05の判断・Git受入を使います。結果不明の操作は同じIDで結果照会し、再送しません。fixtureの`maxInstructions`を指定すると配送前の永続予約で指示回数を制限します。

正常完了した子はプロセスを解放します。同じ履歴の修正には親が`continue_history`を記録してから`create_worker`を呼びます。前attemptの正常完了・終了確認・cleanなGitを確認し、同じthreadを新owner／epoch／attemptでresumeします。別cwd・providerへの変更は拒否します。要求model／effortは送信直前のcatalogと照合し、表示値を実行telemetryと混同しません。

`get_status`の履歴は`attemptOffset`／`nextAttemptOffset`、報告は`reportOffset`／`nextReportOffset`で続きを取得します。報告はUTF-8で60,000 bytesまで、summaryは8,192文字、evidenceRefsは32件・各512文字です。大きな報告も応答bytesでページを区切り、raw会話・認証payloadは記録しません。ターミナルには現在の担当・actor・attempt・状態・要求設定と限定イベントを表示し、入力を転送しません。

再起動後は、新owner／windowに対する新しい人のbindingが必要です。元scopeを変えず、全attemptの終了が確認でき、配送不明の操作がない場合だけ再binding・明示再開できます。元permitは履歴に残します。unknownを人の確認だけで成功扱いにはしません。

`Meristem: Review Worker MCP Request`は、接続済みの管理ウィンドウで承認要求を扱う代替経路です。ローカル`meristem`の`report`／`get_status`の空フォームと、CC-06で追加した固定Gitパスに限るcommand／permissions要求に対応します。対象・作業場所・元要求の内容を表示し、人が一回限り（permissionsはそのターン限り）の許可・拒否・取消を選びます。閉じるだけでは回答せず、元request ID・payload hash・フォーム世代を照合して一度だけ元RPCへ返します。回答送信と元要求の解決は別に確認し、停止後や古いフォームからの回答は拒否します。任意パス、ネットワーク、sandbox全体の解除、file change、認証、connector要求は未対応のまま保留します。要求の監査記録は識別子・hash・世代・状態と提示／回答経路・選択値を保存し、本文や資格情報は追加保存しません。経路の履歴は管理領域の `human-requests.jsonl` に残します。フォーム準備や応答受信だけで実表示・人のクリックを証明したとは扱わず、再起動時に古いフォームを復元しません。

CC-04専用実機試験の入口は`node dist/test/live/approval-roundtrip.js`です。`prepare --live --root <絶対パス> --real-exe <Codex.exe> --auth-home <専用home> --code-exe <Code.exe> --extension-dir <Codex拡張> --max-turns 8`でfixtureを作り、`launch --live --session <session.json>`、`parent --live --session <session.json> --prompt <指示ファイル>`で実行します。`status --summary --session <session.json>`と`evidence --session <session.json> --output <新規JSON>`はモデルを呼びません。人の判断は実UIだけで行い、専用ウィンドウを閉じた後の`cleanup --window-closed --session <session.json>`で設定を復元します。実行中にnative/distを再buildしないでください。証跡JSONだけでは人の判断や実機合格を推定しません。

実Codexの無推論preflightは次です。モデル送信・親PのMCP操作・GUI受入とは別の確認です。

```powershell
powershell.exe -NoProfile -File scripts/run-live.ps1 -Case CC-02 -Live -RealExe '<codex.exe>' -AuthHome '<認証済み専用home>' -Evidence '<未使用の絶対JSONパス>'
```

親P／子A/Bの実モデル受入は別途承認した回数だけ行います。`cc02-prepare.js --live`で専用fixtureを準備し、`cc02-session.js launch|parent|status|reconcile|cleanup --session <session.json>`で進めます。`--max-turns`で合計上限を5〜8回に指定でき、既定は8回です。子はscopeの`maxInstructions: 3`、親は合計上限から3を引いた回数に制限します。送信予約はACK喪失やtimeoutでも戻しません。完了を記録から照合し、専用ウィンドウを閉じた後の`cleanup --window-closed`で追加したMCP namespace（正式UIが保存したそのツールの承認設定を含む）と専用settingsキーだけを復元します。人のRunPermit確認・ログイン・正式な承認はこのrunnerで自動許可しません。

## CC-03の自動再開

専用configの`mcp.wake: { model, effort, maxTurns }`で有効にします。`maxTurns`は1〜12、指定model/effortは観測済みcatalogで検証します。管理ターミナルの接続と消費済みRunPermitがある間だけ、500 msごとに保存済みイベントを確認します。通常監視はモデル要求を送りません。正常な報告だけでは完了とせず、turn完了・未解決要求なし・所有プロセス後始末を確認してから再開候補にします。失敗・質問・人の承認待ちも候補です。

SQLiteにイベント走査位置・親の既読位置・配送位置、送信操作と停止世代を保存します。親がactiveなら蓄積し、idle時だけnativeのowner/epoch・状態seqを照合して新ターンを開始します。子の本文は再開指示へ連結せず、親が`get_status`でデータとして読みます。標準queue／steerを観測した親では自動再開を未対応として抑止します。配送結果不明は停止して再送せず、単なる`resume_run`でも解消しません。

親再開は最大12回、同一taskの再作成は初回＋修正2回までです。新しい履歴を選んでも修正上限はリセットしません。停止後の古いイベントは明示再開で再配送しません。工程依存のGit受入は下記CC-05の明示scopeで有効にします。通常導入はCC-07です。

`node dist/test/live/two-stages.js prepare --live --root <未使用のCC-03配下絶対パス> --max-turns <5〜8> --real-exe <絶対パス> --auth-home <専用home> --code-exe <Code.exe> --extension-dir <公式拡張ディレクトリ>`で専用試験を準備します。`launch|parent|status|reconcile|cleanup`はCC-02と同じ引数、`evidence --session <絶対パス> --output <未使用の絶対JSONパス>`は読取専用の記録抽出です。初回親2回・子2回・自動wakeは合計上限から4を引いた回数を送信前に予約します。結果不明も消費し、別試行への予算流用は利用者の合計上限内だけに限定します。

実機試験中は実行ファイルを再buildせず、終了・設定復元を確認してから`npm run verify`を行います。人の正式承認はrunnerで代行しません。親active/idleのプロトコル確認、パネルの非表示・閉鎖、VS Code終了は別々の観測として記録します。

専用実機では、別ファイルの裏に親タブを残したままA→親確認→新しいB→親の最終確認を通し、親タブ閉鎖後の自動確認と、指示待ちの実子が生存する状態でのVS Code終了も別試行で記録しました。正式承認は人が操作しています。終了後のDBは最後のactive状態を残す場合があり、プロセスの不在と区別して`needs_reconcile`と扱います。過去試行の原因未特定の停止・保留も含む範囲と制約は[検証記録](validation/chat-control/CC-03.md)を参照してください。

実行中の観測には `node test/live/observe-parent.mjs <session.jsonの絶対パス>` を使います。親relayと管理側の状態取得APIを読み、変化した状態だけを専用fixtureの`observations.jsonl`へ保存します。`observer.stop`を同じフォルダーに作ると終了します。実行中のSQLiteを別プロセスから頻繁に読むとwriterと競合するため、DBからの証拠抽出は停止後に行います。専用親fixtureは`parent-view.jsonl`へ対象親タブの表示・非表示・閉鎖を記録します。画面操作と正式承認は人が行い、工程を進める追加入力とは区別します。

worker作成失敗時は、`sent_unknown`を維持したまま、固定の`creationFailure`診断ラベルをoperationへ残します。ラベルは再実行の許可ではなく、raw応答・秘密・任意のエラーメッセージを保存しません。

`relay/status`には再開判定用のpending入力・停止／未対応状態と、所有管理プロセスの生死・終了code、再開元の検証回数を含めます。診断で認可を代用しません。試験の`parent`操作は、モデル枠を予約する前にbrokerがactiveで応答することを確認します。

## CC-05の工程表と直列Git

`mcp.scope.plan: true` と `assignments: []` を明示すると、MarkdownのYAML工程表から新しいworktree／branchを割り当てます。候補承認と統合承認を分け、正常turn・後始末・Git事実・親の判断を確認してから依存工程を解放します。新しい担当が既定で、明示判断による同履歴の修正も新attemptになります。

工程表・報告schema、親の判断、改訂の照合、進捗更新、ローカルbare remoteの試験方法と制約は [CC-05](validation/chat-control/CC-05.md) を参照してください。CC-05の確認範囲は実Gitと偽runtimeによる直列fixtureです。実Codex／VS Code／GitHubの新規受入、並列配送、通常導入には広げません。

## CC-06の並列とGit統合

工程表の `max_parallel: 2` で、scope・共有資源・履歴元worktreeが競合しない2担当を開始できます。親は候補承認後に `prepare_integration` でbaseと候補SHAを固定し、専用integration worktreeで統合します。両工程と既存工程のcheck、および `integration` checkを最終SHAの `checked_sha` 付きで記録してから `accept_integration` します。準備を取り消す `cancel_integration` はGit成果を削除しません。

子のモデル／推論設定は工程表で指定し、起動・各送信前に公式catalogをページ送りして確認します。モデルの追加・削除に固定リストの更新は不要です。利用不能になった指定は送信前に拒否し、別モデルへ自動置換しません。

Git権限の承認画面には担当・目的・対象・有効期間を表示します。Windowsの実行方式は既存設定を継承し、必要な場合は専用runtimeの `windowsSandbox` で `elevated`／`mxc` を明示できます。方式を指定しても管理領域のdenyと人の承認は維持し、起動前の隔離確認に失敗した場合は開始しません。別方式への自動fallbackは行いません。

全222件の自動テストと、専用ローカルbare remoteでの実モデル受入（並列commit/push、親の統合・意味上の競合解消、片方のタブ停止後の兄弟の報告継続）を完了しました。契約、証拠、実モデル試験の手順と制約は [CC-06](validation/chat-control/CC-06.md) を参照してください。GitHub統合pushは別確認、通常導入はCC-07です。

## CC-00R以前の試験入口

実機試験は明示的な`--live --case`が必要です。本物のexeは現在インストールされているCodex拡張から確認し、絶対パスを渡します。PATHから自動選択しません。専用`CODEX_HOME`で利用者が正式にCLIログインとWindows sandbox setupを完了させます。グローバル認証ファイルをコピーしません。

```powershell
# CC-00R: モデルを送らない実CLI接続・catalog・Job・EOF確認
node spikes/chat-control/direct-probe.mjs --live --case preflight --real-exe '<codex.exe>' --root '<未使用の .local/chat-control/CC-00R 配下の絶対パス>' --auth-home '<同配下の認証済み専用home>' --evidence '<未使用のJSON出力先>'

# CC-00R: 承認済みの追加送信枠を使う、手動UI操作を伴う受入
node spikes/chat-control/direct-suite.mjs --live --case acceptance --real-exe '<codex.exe>' --root '<未使用の専用root>' --auth-home '<認証済み専用home>' --budget-root '<承認済み台帳root>' --code-exe '<Code.exe>' --extension-dir '<公式Codex拡張ディレクトリ>' --evidence '<未使用のJSON出力先>'
```

モデル試験は事前に明示承認した回数だけ実施します。`authorization.json`の`scope: "CC-00R continuation"`・`maxTurns: 12`はその承認を記録する試験台帳であり、ファイル作成自体が承認になるわけではありません。今回の12枠は使用済みです。`turn-N.json`は送信前に予約し、timeout等の結果不明でも戻しません。単独shell/EOF試験は`direct-probe.mjs --case shell --budget-root <同じ台帳>`を使います。

acceptanceは`session.json`にphaseと専用pipe/cwdを出します。親UIでprobe MCPを一度呼び、`CC00R_PARENT_TOKEN_86`を記憶して`CC00R_PARENT_DIRECT_READY`と返す試験を行います。runnerのphaseに従い、補助拡張の`Meristem: Open Fixture Worker Terminal`に対象pipeを指定し、Aのタブ閉鎖、Cの`Meristem: Stop Fixture Worker`、Eの専用ウィンドウ終了を行います。途中で認証・正式承認要求が出た場合は成功応答を捏造せず停止します。実行後はsettings/config復元と専用profileの所有プロセス不在を別々に確認します。runnerのsettings復元だけをウィンドウ不在の証拠にはしません。

terminalは読取専用です。貼付けや文字入力は子へ届きません。非表示やタブ切替では継続し、実行中タブの閉鎖と停止commandは対象workerを停止します。完了タブの閉鎖は表示だけを終了します。表示接続の一時切断は再試行し、所有brokerの切断は停止します。ログは限定イベントで、全文会話の表示ではありません。

以下は旧CC-00の親中継・通常UI試験入口です。

```powershell
# モデルを呼ばない、未認証の独立fixtureでの通信試験
node spikes/chat-control/relay-probe.mjs --live --case transport --real-exe '<本物のcodex.exeの絶対パス>'

# 通常画面を使う試験。終了までrunnerを起動したままにする
node spikes/chat-control/relay-probe.mjs --live --case prepare-ui --real-exe '<同上>' --code-exe '<Code.exeの絶対パス>'

# prepare-uiが表示したsession.jsonを指定する
node spikes/chat-control/relay-probe.mjs --live --case status --session '<session.json>'
node spikes/chat-control/relay-probe.mjs --live --case restore-ui --session '<session.json>'
```

`prepare-ui`は`.local/chat-control/CC-00/`内に専用`--user-data-dir`、試験cwd、exe sidecar、読取専用MCP設定を作ります。既存のログインを通常のCodex経路で使用し、認証情報はfixtureへコピーしません。既存チャットに試験指示を送らないでください。試験後は`restore-ui`で変更キーを復元し、専用ウィンドウだけを閉じ、所有プロセスの終了を確認します。fixtureと試験チャットは証拠として残します。

`rpc`ケースは同じsessionと`--request <JSONファイル>`を使うローカル実証用の入口です。native側の許可済みmethod・cwd・登録thread・catalog制約が常に適用されます。`last-rpc.json`は非公開fixture内の試験応答であり、公開証拠へ全量コピーしません。

中継はexe横の`.exe.json`から本物の絶対パスとSHA-256を検査します。管理を有効にするのは、検証した`app-server`起動と現拡張の完全一致する起動引数だけです。その他の呼出しは引数・stdio・終了コードを転送します。`chatgpt.cliExecutable`は開発用設定です。通常プロファイルへの常用導入や自動起動は行いません。
