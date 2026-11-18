# 導入・運用・検証リファレンス

[日本語の概要](../README.md) | [English overview](../README.en.md)

旧READMEの詳細手順と工程別の説明を保持しています。本文の「親／親チャット」はコーディネーター、「子／子チャット／子CLI」はワーカーを指します。ワーカーは独立したCodex CLIチャットで、内部サブエージェントとは区別します。以下のコマンドはリポジトリのルートから実行します。工程ごとの記述はその時点の確認範囲を示します。最新の総合受入は [CC-07継続受入記録](validation/chat-control/CC-07-continuation.md)を参照してください。

Windows版VS Codeの通常Codex拡張を親に残し、専用子CLIを統合ターミナルで表示・停止する接続実証です。CC-02で明示した試験用Git範囲に限る親／子MCPを接続し、CC-03で報告から親を再開して次の子へ進む主要経路を確認しました。CC-05の工程表と直列Git受入に加え、CC-06で2担当の並列配送と候補を固定したGit統合を追加しています。CC-07の導入・復元・ローカル配布手順は下記を参照してください。通常profileへの導入は実証結果の確認後、別途明示操作で行います。

**CC-02は専用fixtureの範囲で実機受入を完了しました。** 実親PからA/Bへ指示し、人のMCP承認後の報告保存、正常完了Aの同履歴・新attemptでの再開と想起、親による最終確認を実証しました。その受入ではCC-04の限定承認入口を先行実装しました。現在の質問・承認経路は下記CC-04の説明を参照してください。過去の起動・切断失敗の原因は未特定で、安定性保証や通常導入の完了を意味しません。[CC-02の結果・範囲・制約](validation/chat-control/CC-02.md)を参照してください。

**CC-00Rの受入を完了しました。** 子ごとのJob Objectで、実Codexが公式sandbox内に起動したshellと孫プロセスを停止できました。タブ閉鎖、明示停止、broker EOF、host強制終了、VS Code終了を別々に確認しています。[CC-00Rの結果・範囲・制約](validation/chat-control/CC-00R.md)を保持しています。CC-01の新しい管理経路の確認範囲は[CC-01結果](validation/chat-control/CC-01.md)を参照してください。

2026-11-15の[実装計画](superpowers/plans/2026-11-15-codex-chat-control-implementation.md)・[設計](superpowers/specs/2026-11-15-codex-chat-control-design.md)に沿う、専用profileだけの実装です。子への直接入力と対話型TUIはありません。旧方式ではUI停止後もコマンドが続いた[CC-00の結果](validation/chat-control/CC-00.md)を履歴として残しています。

必要環境はWindows x64、Node.js 24.22.1以上、Windows標準の.NET Framework x64コンパイラです。

## v0.1.0のビルド済み本体パッケージ

[Release](https://github.com/takikomirice/meristem/releases/tag/v0.2.0)のWindows x64用ZIPには、本体JavaScript・DB初期化SQL・3つのnative実行ファイル・補助拡張VSIX・Node.js・固定したnpm依存とライセンスを含めます。利用者側のコンパイルやNode.jsの別途導入は不要です。[配布版の案内](releases/INSTALL.ja.md)に従い、専用環境の認証・設定・実行許可を別途行います。

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
| 復旧 | 状態・operation・プロセス・Gitを照合し、新ownerの人binding後に親 `resume_run`。対象ワーカーの引継ぎは[履歴と再開準備](#ワーカーの履歴と再開準備)を参照 |
| 工程表改訂 | `propose_plan_change` → 人のフォーム回答 → `apply_plan_change`。承認済みの工程表を復元した後の凍結解除は `reconcile_plan`、生成進捗は `write_progress` |
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

## 反復開発用の専用環境

日常の改修には[開発環境の診断・設定生成・再利用](development-environment.ja.md)を使います。ビルド後の `npm.cmd run development -- <操作>` が入口です。`inspect` は読取り、`prepare` は固定環境・不変snapshot・新runの生成、`status` は対象確認です。`start`／`stop`／`restore` と実行を伴う `refresh` は明示した専用環境と `--live` を必要とし、送信枠は既定0です。

ロジックは通常テストだけ、拡張は必要なhostの開き直し、runtime／起動契約は所有runの停止・復元後の新snapshotと新runで確認します。停止unknownや切断では終了・復元を推定せず、receipt・lifecycle・所有プロセスを照合してleaseを保持します。本人限定のログイン・UAC等の正式同意を除く準備・停止・復元はエージェントが担当します。

この経路はCC-07のクリーン受入とは別です。`refresh --change acceptance` は既存runnerを案内するだけで、受入は独立した試験rootと有限枠で行います。[DE-06の回帰結果・MC-03引継ぎ](validation/chat-control/DE-06.md)と[DE-05の実機観測・window表示の留保](validation/chat-control/development-environment-first.md)を参照してください。通常profileへの導入やsandboxの初期準備を繰り返す手順ではありません。

## CC-01の管理記録と停止

表示場所はVS Code下部の「ターミナル」です。`Meristem: Open Managed Worker Terminals`で、明示した管理領域の`discovery.json`を選ぶと、担当ごとの読取専用タブを開きます。入力・貼付けは子へ届きません。実行中タブの閉鎖はrunの新規指示とwakeを禁止して対象担当だけを停止し、ウィンドウの管理接続喪失は全担当の停止処理に入ります。正常完了後のタブ閉鎖は表示だけを閉じます。普段のVS Codeへ拡張を自動導入する処理はCC-07です。

管理DB・discovery・credentialはworktree外の専用ディレクトリに置きます。native hostが利用者とSYSTEMだけのACLを設定し、実Codexには`:workspace`を継承して管理領域を明示的に`deny`する`meristem-managed` permission profileを渡します。実行前の無推論sandbox検査で「作業場所は読める／管理領域は読めない」を確認できなければ起動しません。認証ファイル・通常プロファイルの設定・OS承認は書き換えません。

### MC-07: 次タスクの設定と権限上限

版2では各タスクの `agent.permissionProfileId` に `workspace` または `read-only` を指定します。版1は `workspace` を使います。起動時に実catalogのmodel/effortと、profile、reviewer、approval policy、推論強度、作業rootの応答を照合します。不一致・RPC拒否・OS隔離失敗では起動を中止します。

専用configの `mcp.scope.permissionPermit` は、RunPermitの確認対象に含まれる権限上限です。実装と調査を同じrunで行う例は `{ allowedProfileIds: ["workspace", "read-only"], writableRoots: ["<既存のworktrees_root絶対パス>"], allowedReviewers: ["auto_review"] }` です。省略時は従来の `workspace`／`user` を使います。実装担当の書き込み先は割り当てたcwdに絞り、固定Gitパスへの追加権限は従来の人向け要求で扱います。読み取り専用の担当には書き込み先やGitへの追加の書き込み許可を渡しません。未知のプロファイル、管理領域と重なる書き込み先、上限外のcwdは拒否します。

対象版には永続化された権限grantのresetを確認できるAPIがありません。このため`continue_history`／`retry_same`でも、終了・未解決要求なし・clean Gitを照合した同じworktreeを使い、独立した新threadと新WorkerRefを作ります。元threadの参照と必要な作業指示・コミット済みファイルを引き継ぎ、会話本文と古いgrantは再生しません。不足する文脈はコーディネーターへ相談します。`get_status`のattemptに保存された`settings`で要求agent、応答照合済みpermissions、`fresh_handoff`と元thread参照を確認できます。旧attemptに`settings`がなければ適用を推定しません。

#### 読み取り専用の工程

読み取り専用の担当を使う専用環境では、Workerに公開するMCPサーバーをMeristemだけにします。書き込み権限の追加を要求する機能は無効にし、報告などのMCP操作に必要な承認は使えます。起動時と指示の配送前に、Workerのスレッドで使えるサーバーを照合します。

1. 親は工程表の `completion` に判断したい項目を記し、担当には対象コミットを指定します。たとえば「旧形式の工程表を読めること」と「既知の制約を列挙すること」は別々の項目です。
2. Workerは割当時の `base_sha` を調べ、結論、各項目で実行したコマンド、結果・終了コード、根拠を `report` で提出します。根拠には、そのコミットで参照できるファイルと行、検証ログなどを使います。完了報告は `candidate_sha: null`、`push_result.status: "not_attempted"`、`remaining: []` とし、各項目の `checked_sha` に調べたSHAを入れます。必須条件の不合格や未確認はそのまま報告します。
3. 親は報告本文と根拠を読んで採否を決めます。工程が `review_ready` になったら `record_decision` で `decision: "accept_review"`、`evidenceRefs: [reportRef]`、`integrationSha: <調べたSHA>` を渡します。報告の出所、全必須項目、担当の正常終了、作業ツリーと現在の統合SHAを照合して採用すると後続が解放されます。確認後に統合先が進んでいれば、その新しいSHAを調べ直します。

自動レビューの明示的拒否は同thread・turnに結び付けます。実MCPフォームにはitemIdがないため、そのturnの正式承認を親や人のacceptで上書きできない扱いにします。本人認証、connectorや人間専用同意の未対応要求は保留を維持します。通常の相談への回答は実行権限を追加しません。検証範囲と実機の留保は[MC-07記録](validation/chat-control/MC-07.md)を参照してください。

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

MC-03bでは、現行planを保存済みのrunに `propose_decision({runId, operationId, expectedRevision, proposal})`、`get_decisions({runId, afterId?, limit?})`、`answer_consultation({runId, operationId, expectedRevision, decisionId, answer?, close?})` を追加しました。proposalのtask・recipient・planHash・question・options・allowFreeText・blockingTaskIdsは[共通契約](superpowers/plans/2026-11-17-worker-coordination-evolution.md#4-共通の内部契約)に従います。ワーカーは本人taskの相談と読取り、親は親宛の回答・人へのフォーム提示・明示取消を行えます。一覧は1〜4件の走査と応答bytesでページを区切り、`nextAfterId` があれば続きを取得します。

人宛相談は `answer` を省略して標準フォームを表示します。親が人の代わりにanswerを指定することはできません。取消・無回答・切断は未承認を維持し、新しいoperationで改めて表示します。選択肢付きフォームの自由記述は修正案として新しい未承認proposalを作成し、再確認します。明示取消は `close: 'cancelled'`、旧案の破棄は `close: 'superseded'` です。正式な権限要求は従来の `answer_request` を使います。ワーカーの `propose_decision`／`get_decisions` に対するローカルMCP呼出しの承認も従来の空フォームで扱えますが、相談内容への同意ではありません。[MC-03bの結果と制約](validation/chat-control/MC-03b.md)はその時点の確認範囲を保持し、保留・再開の結合結果は[MC-04b記録](validation/chat-control/MC-04b.md)で追跡します。

### 相談とタスク保留

planを有効にしたrunでは、親専用の `hold_task({runId, operationId, expectedRevision, taskId, decisionId})` と `resume_task({runId, operationId, expectedRevision, taskId, resolvedDecisionId})` を使います。ワーカーからの実行、非plan run、対象外の相談は拒否します。

1. `propose_decision`で対象taskを`blockingTaskIds`に指定して相談を保存します。情報共有や非blocking相談は保留へ変換せず、独立作業を続けられます。
2. `hold_task`で対象だけを保留し、そのattemptのturn中断・native Job空・host終了を確認します。`releasedExecutionSlot: true`になった枠だけを再利用します。保留中のscope・競合資源・worktreeの予約、未コミット成果は保持します。停止がunknownなら全体停止と親wakeフェンスへ戻ります。
3. 現行計画のまま再開する選択肢は`id: 'resume'`として提示します。人宛は標準フォームから回答し、親宛だけ親が回答できます。全保留相談に対する、自由記述を伴わない`optionId: 'resume'`が必要です。否定・取消・superseded・修正案は再開許可になりません。相談の置換関係を扱う改訂は後続工程へ残します。
4. `resume_task`は回答・plan・Git・旧attemptの停止・別の未解決相談を再照合し、`resume_ready`にします。続く`create_worker`と`send_instruction`は明示的に行います。同じclean worktreeを新thread・新attemptで使い、古いWorkerRefへの指示と成果受入は拒否します。回答保存だけでは自動配送しません。

同一operationの再試行は記録済みの結果を照合し、停止・起動・指示を重複実行しません。再開後に古い`hold_task`を再送しても、新しいattemptを保留し直しません。応答はそのoperationの実行事実で、現在の状態は`get_status`で確認します。通常監視のためのモデル呼出しは追加しません。枠解放・再開は停止や回答の事実を満たす必要があり、タブ非表示・取消・無回答で代用しません。

結果と実機の確認範囲は[CC-02](validation/chat-control/CC-02.md)に記録します。MCP入口は`node dist/src/mcp.js --pipe <明示したcontrol pipe>`です。stdoutはSDKのプロトコル専用です。モデルにcredentialや役割を渡さず、nativeが得た接続元PID・作成identity・所有jobと、実metadataの`x-codex-turn-metadata.thread_id / turn_id`を照合します。登録外root、内部サブエージェント、古いowner／epochの変更操作は拒否します。

job内にいるだけではMCPの身元として認めません。実App Serverの直接の子であること、Node実行ファイルとMCP入口のhash、起動引数、PID／作成identityも照合します。通常のhelperや同じ引数で起動した孫プロセスによる親／子のなりすましを拒否します。

起動configの`mcp`へ`parentRelay: { pipeName, threadId }`、MCPの`entryPoint, entrySha256`、`scope`を明示します。scopeは`fixture: true, planPath, repositoryId, repositoryPath, branchScope, assignments`です。割当はCC-01と同じ形ですが、MCP有効時は起動だけで子を作りません。実Gitのcommon-dir・worktreeルート・branch、実計画hashを確認します。このCC-02固定割当fixtureは最大2担当です。版2工程表の増員はMC-06の手順を使います。main／masterは対象外です。実機用の生成例は`test/live/cc02-prepare.ts`を参照してください。通常導入用installerではありません。

親の`start_run`で許可待ちbindingを作った後、利用者が次を実行し、表示された実親・計画hash・repo・branch・作業場所を確認してbinding IDを入力します。親／子の所有jobからこの確認を代行することはできません。

```powershell
node dist/src/cli.js authorize --run <run-id> --state '<専用管理ディレクトリ>' --binding <binding-id>
```

親が同じ`start_run`を呼ぶと一回限りのpermitを消費します。`create_worker`、`send_instruction`、`get_status`、子の`report`、停止／再開を利用できます。CC-02互換scopeの`record_decision`は`new_worker`と`continue_history`に対応します。工程表を有効にしたscopeでは、下記CC-05の判断・Git受入を使います。結果不明の操作は同じIDで結果照会し、再送しません。fixtureの`maxInstructions`を指定すると配送前の永続予約で指示回数を制限します。

正常完了した子はプロセスを解放します。同じ履歴の修正には親が`continue_history`を記録してから`create_worker`を呼びます。前attemptの正常完了・終了確認・cleanなGitを確認し、同じthreadを新owner／epoch／attemptでresumeします。別cwd・providerへの変更は拒否します。要求model／effortは送信直前のcatalogと照合し、表示値を実行telemetryと混同しません。

`get_status`の履歴は`attemptOffset`／`nextAttemptOffset`、報告は`reportOffset`／`nextReportOffset`で続きを取得します。報告はUTF-8で60,000 bytesまで、summaryは8,192文字、evidenceRefsは32件・各512文字です。大きな報告も応答bytesでページを区切り、raw会話・認証payloadは記録しません。

#### 管理ターミナルの表示と操作

同じチャット内でモデルや推論強度の変更が確認できたときは、Workerのターミナルに変更前後を1行で表示します。推論強度だけなら `[設定変更]medium→high`、両方が変われば `[設定変更]gpt-6.2-sol→gpt-6-luna, medium→high` と表示します。権限はチャットの起動時に確認します。権限を変えて作業を引き継ぐ場合も、新しいチャットはその担当の初期設定を表示して始まります。

各タブは1回のワーカー起動に対応します。指示待ちの通常のタブは「担当・タスク・状態」「モデル」「権限」の3行で始まります。保留や切断、相談、既存の作業結果があれば初回から表示し、以降は変更点を追記します。起動確認時の登録記録は管理履歴に残ります。相談の作成・回答・取消、承認済みの工程表変更は別の文言で記録します。

- **Meristem: List Worker Terminals** は開いている管理タブの一覧を表示します。同じ表示名の担当はタスクIDとattempt末尾で見分けられます。
- **Meristem: Show Current Worker Details** は選択中のタブにactor・attempt・作業ディレクトリ・ブランチを表示します。
- **Meristem: Rename Current Worker** は選択中のattemptに表示名を保存します。前後の空白を除き1〜128文字で、同じ名前も使えます。初期値は版2の`display_name`、未指定時はworker IDです。

通常表示ではプロセス状態とタスクの保留・退役を別々に確認できます。相談ごとに相談先・理由・続行／保留範囲を表示し、回答済みや旧版の相談はその状態を示します。終了後のタブにも相談の更新が反映されます。活動はApp Serverが通知したコマンド・ファイル編集・テストの種類と成否（異常終了時は番号も併記）を表示し、ワーカー説明は発生を表示します。各タブのツール活動はその担当の実行分です。同時に取得した連続する同種の活動は件数を表示します。増員・工程表改訂の通知には種類を付け、担当の登録より前の通知はそのタブに再掲しません。最後の活動通知を受けた時刻を表示し、接続状態が不明な場合は別に示します。監視のためのモデル送信は発生しません。

再起動後は、新owner／windowに対する新しい人のbindingが必要です。元scopeを変えず、全attemptの終了が確認でき、配送不明の操作がない場合だけ再binding・明示再開できます。元permitは履歴に残します。unknownを人の確認だけで成功扱いにはしません。

`Meristem: Review Worker MCP Request`は、接続済みの管理ウィンドウで承認要求を扱う代替経路です。ローカル`meristem`の`report`／`get_status`の空フォームと、CC-06で追加した固定Gitパスに限るcommand／permissions要求に対応します。対象・作業場所・元要求の内容を表示し、人が一回限り（permissionsはそのターン限り）の許可・拒否・取消を選びます。閉じるだけでは回答せず、元request ID・payload hash・フォーム世代を照合して一度だけ元RPCへ返します。回答送信と元要求の解決は別に確認し、停止後や古いフォームからの回答は拒否します。任意パス、ネットワーク、sandbox全体の解除、file change、認証、connector要求は未対応のまま保留します。要求の監査記録は識別子・hash・世代・状態と提示／回答経路・選択値を保存し、本文や資格情報は追加保存しません。経路の履歴は管理領域の `human-requests.jsonl` に残します。フォーム準備や応答受信だけで実表示・人のクリックを証明したとは扱わず、再起動時に古いフォームを復元しません。

CC-04専用実機試験の入口は`node dist/test/live/approval-roundtrip.js`です。`prepare --live --root <絶対パス> --real-exe <Codex.exe> --auth-home <専用home> --code-exe <Code.exe> --extension-dir <Codex拡張> --max-turns 8`でfixtureを作り、`launch --live --session <session.json>`、`parent --live --session <session.json> --prompt <指示ファイル>`で実行します。`status --summary --session <session.json>`と`evidence --session <session.json> --output <新規JSON>`はモデルを呼びません。人の判断は実UIだけで行い、専用ウィンドウを閉じた後の`cleanup --window-closed --session <session.json>`で設定を復元します。実行中にnative/distを再buildしないでください。証跡JSONだけでは人の判断や実機合格を推定しません。

実Codexの無推論preflightは次です。モデル送信・親PのMCP操作・GUI受入とは別の確認です。

```powershell
powershell.exe -NoProfile -File scripts/run-live.ps1 -Case CC-02 -Live -RealExe '<codex.exe>' -AuthHome '<認証済み専用home>' -Evidence '<未使用の絶対JSONパス>'
```

親P／子A/Bの実モデル受入は別途承認した回数だけ行います。`cc02-prepare.js --live`で専用fixtureを準備し、`cc02-session.js launch|parent|status|reconcile|cleanup --session <session.json>`で進めます。`--max-turns`で合計上限を5〜8回に指定でき、既定は8回です。子はscopeの`maxInstructions: 3`、親は合計上限から3を引いた回数に制限します。送信予約はACK喪失やtimeoutでも戻しません。完了を記録から照合し、専用ウィンドウを閉じた後の`cleanup --window-closed`で追加したMCP namespace（正式UIが保存したそのツールの承認設定を含む）と専用settingsキーだけを復元します。人のRunPermit確認・ログイン・正式な承認はこのrunnerで自動許可しません。

## CC-03の自動再開

専用configの`mcp.wake: { model, effort, maxTurns? }`で有効にします。MC-05以降、`maxTurns`は未指定／nullが無制限、指定時は正整数です。指定model/effortは観測済みcatalogで検証します。管理ターミナルの接続と消費済みRunPermitがある間だけ、500 msごとに保存済みイベントを確認します。通常監視はモデル要求を送りません。正常な報告だけでは完了とせず、turn完了・未解決要求なし・所有プロセス後始末を確認してから再開候補にします。失敗・質問・人の承認待ちも候補です。

SQLiteにイベント走査位置・親の既読位置・配送位置、送信操作と停止世代を保存します。親がactiveなら蓄積し、idle時だけnativeのowner/epoch・状態seqを照合して新ターンを開始します。子の本文は再開指示へ連結せず、親が`get_status`でデータとして読みます。標準queue／steerを観測した親では自動再開を未対応として抑止します。配送結果不明は停止して再送せず、単なる`resume_run`でも解消しません。

MC-05以降、親再開と同一taskの修正回数は既定で無制限です。専用configの`executionLimits: { maxWakeTurns: 3, maxCorrectionsPerTask: 2 }`、または版2工程表の`run.execution_limits`で有限枠を指定できます。両方に有限値があれば小さい方を適用し、旧`mcp.wake.maxTurns`の有限枠も維持します。0・負数・小数は拒否します。修正枠は初回作成を除く同一taskの再作成ごとに送信前に予約し、履歴変更ではリセットしません。結果不明も消費し、同じoperationの照合では二重消費しません。wake枠も配送前に保存し、nativeが未配送を確定したdeferredだけ消費しません。明示枠を使い切ると停止し、無制限でもowner喪失・配送不明・終了不明の安全停止は維持します。CC-03当時の12回／修正2回という証拠や有限の実機試験予算は変更しません。停止後の古いイベントは明示再開で再配送しません。工程依存のGit受入は下記CC-05の明示scopeで有効にします。通常導入はCC-07です。

親専用MCPの`retire_worker { runId, operationId, expectedRevision, target: WorkerRef }`は、対象attemptだけを終了させ、確認後もrunをactiveに保ちます。終了確認までは人数に計上し、確認できなければ全体を安全停止します。退役はタスク完了や依存解放になりません。工程表では`retired`として残ります。再割当では`record_decision`の`handoff_new`または[履歴と再開準備](#ワーカーの履歴と再開準備)を使い、作成と指示配送を明示します。保留中の工程は相談・Gitの照合を経た`resume_task`で準備します。未コミット成果・worktree・ブランチ・ログを保持します。終了済みattemptへの退役や旧WorkerRefへの再照合で新attemptを停止しません。

#### ワーカーの履歴と再開準備

VS Codeを開き直した後は `Meristem: Open Managed Worker Terminals` で対象runの管理接続に入り、コマンドパレットの **Meristem: ワーカーの Codex 履歴を読む** でスレッドを選びます。公式Codexの履歴APIからページを読み、指示と応答の概要を読み取り専用エディターに表示します。添付やツール出力は概要の対象外です。閲覧してもrunの状態は変わらず、新しいターンや承認は発生しません。

CLIの `history --run <id> --state <directory>` で登録済みattemptを一覧できます。続きは `--offset <nextOffset>` で取得し、本文は `--attempt <id>` で選択します。応答に`nextCursor`があれば `--cursor <cursor>` で同じスレッドの以前の履歴を取得します。コーディネーターは `get_status` で完全な`WorkerRef`を選び、`get_worker_history { runId, target, cursor? }` を使えます。

再開時は実行・停止記録を確認し、brokerのownerが変わった場合は新しい人bindingを確認してから、コーディネーターが `resume_run` を実行します。回答待ちの相談は、VS Codeの **Meristem: 回答待ちの相談を読む**、CLIの `status --run <id> --state <directory> --pending-decisions`、またはbinding確認後にMCPの `get_decisions { runId, pendingOnly: true }` で確認できます。CLIで続きがある場合は `--after-id <nextAfterId>` を指定します。保留中の工程は相談の決定に沿って `resume_task` で再開を許可します。送信や停止の結果が不明なら照合が必要です。古いフォームは失効し、指示は自動再送しません。

対象の工程を引き継ぐには、稼働中のrunで **Meristem: 履歴を照合して再開を準備**、CLIの `resume-history --run <id> --state <directory> --attempt <id>`、または `resume_worker_history { runId, operationId, expectedRevision, target }` のいずれかを使います。最新の停止済みattempt、Codexのスレッドとプロバイダー、停止・配送記録、ブランチ、未完了のGit操作、作業ツリーを照合します。`history_handoff_ready` の後に、コーディネーターが `create_worker` と `send_instruction` を個別に実行します。作成時にも作業ツリーと割当を再照合します。試験や統合の実績は既存のGit証拠と検証結果で判定します。

対象Codex版で旧権限を安全に消去する手順を確認できていないため、照合済みの作業場所と元スレッドの参照を新しいattempt・スレッドに引き継ぎます。新しいワーカーには現行の工程設定とrunの権限上限を適用します。以前の記録にプロバイダー情報がない場合や元スレッドを照合できない場合は理由を表示します。コーディネーターは作業記録を確認して `handoff_new` を判断できます。相談の決定で既に再開を許可された工程は、その許可に従って新しいワーカーを作成できます。

拡張の**Meristem: Retire Current Worker (Keep Run Active)**は選択中の管理ターミナルだけを退役し、ログを閉じません。**Meristem: Stop All Workers**は親モデルを呼ばずnative管理経路から全体停止します。未接続時もローカルCLIの`stop`を使用できます。既存の`stop_worker`／稼働中タブ削除はrunの新規配送・wakeを禁止し、他担当の既存turnだけ続行できる意味を維持します。終了済みタブを閉じる操作は表示だけです。パネル非表示・画面クリアは停止操作ではありません。[MC-05の検証記録](validation/chat-control/MC-05.md)は実モデル・実UIの追加受入と区別します。

`node dist/test/live/two-stages.js prepare --live --root <未使用のCC-03配下絶対パス> --max-turns <5〜8> --real-exe <絶対パス> --auth-home <専用home> --code-exe <Code.exe> --extension-dir <公式拡張ディレクトリ>`で専用試験を準備します。`launch|parent|status|reconcile|cleanup`はCC-02と同じ引数、`evidence --session <絶対パス> --output <未使用の絶対JSONパス>`は読取専用の記録抽出です。初回親2回・子2回・自動wakeは合計上限から4を引いた回数を送信前に予約します。結果不明も消費し、別試行への予算流用は利用者の合計上限内だけに限定します。

実機試験中は実行ファイルを再buildせず、終了・設定復元を確認してから`npm run verify`を行います。人の正式承認はrunnerで代行しません。親active/idleのプロトコル確認、パネルの非表示・閉鎖、VS Code終了は別々の観測として記録します。

専用実機では、別ファイルの裏に親タブを残したままA→親確認→新しいB→親の最終確認を通し、親タブ閉鎖後の自動確認と、指示待ちの実子が生存する状態でのVS Code終了も別試行で記録しました。正式承認は人が操作しています。終了後のDBは最後のactive状態を残す場合があり、プロセスの不在と区別して`needs_reconcile`と扱います。過去試行の原因未特定の停止・保留も含む範囲と制約は[検証記録](validation/chat-control/CC-03.md)を参照してください。

実行中の観測には `node test/live/observe-parent.mjs <session.jsonの絶対パス>` を使います。親relayと管理側の状態取得APIを読み、変化した状態だけを専用fixtureの`observations.jsonl`へ保存します。`observer.stop`を同じフォルダーに作ると終了します。実行中のSQLiteを別プロセスから頻繁に読むとwriterと競合するため、DBからの証拠抽出は停止後に行います。専用親fixtureは`parent-view.jsonl`へ対象親タブの表示・非表示・閉鎖を記録します。専用環境の起動・状態照合・停止・設定復元は担当エージェントがCLIで実行し、画面観測には専用ウィンドウを使います。RunPermit、増員、計画改訂、正式な権限要求は、表示された対象について本人が判断します。

worker作成失敗時は、`sent_unknown`を維持したまま、固定の`creationFailure`診断ラベルをoperationへ残します。ラベルは再実行の許可ではなく、raw応答・秘密・任意のエラーメッセージを保存しません。

`relay/status`には再開判定用のpending入力・停止／未対応状態と、所有管理プロセスの生死・終了code、再開元の検証回数を含めます。診断で認可を代用しません。試験の`parent`操作は、モデル枠を予約する前にbrokerがactiveで応答することを確認します。

## CC-05の工程表と直列Git

`mcp.scope.plan: true` と `assignments: []` を明示すると、MarkdownのYAML工程表から新しいworktree／branchを割り当てます。候補承認と統合承認を分け、正常turn・後始末・Git事実・親の判断を確認してから依存工程を解放します。新しい担当が既定で、明示判断による同履歴の修正も新attemptになります。

工程表・報告schema、親の判断、改訂の照合、進捗更新、ローカルbare remoteの試験方法と制約は [CC-05](validation/chat-control/CC-05.md) を参照してください。CC-05の確認範囲は実Gitと偽runtimeによる直列fixtureです。実Codex／VS Code／GitHubの新規受入、並列配送、通常導入には広げません。

## MC-06: 人が承認する増員とN件統合

版1の`max_parallel`は従来どおり1〜2です。版2では1〜128の希望人数を指定でき、実際の枠は希望人数と`effectiveParallelLimit(runId)`の小さい方になります。未承認時の承認上限は2です。128はタスク契約の上限で、PCの推奨同時人数ではありません。起動中・停止待ち・終了不明を計上し、停止確認済みの保留や退役だけが枠を解放します。scope・共有lock・worktreeの予約は人数承認で解除されません。

増員は既存の`propose_decision`へ`kind: "parallelism"`、`recipient: "human"`、`requestedMaximum`、対象`taskIds`、現行`planHash`を渡します。`question`に増員理由と分担を記載し、フォームには人数と工程表のモデル・推論設定も表示されます。承認の選択IDは`approve`です。`answer_consultation`で提示し、信頼済みUI callbackの回答だけが上限を更新します。コーディネーターの自己回答、無回答、別run、古いフォーム、計画変更は許可になりません。新しい増員提案は同runの未回答の旧提案を無効にします。自由記述の修正案は新しい未承認の案であり、人数を推測して適用しません。構造化した人数を再提案して承認してください。同runの最大4人を承認した後は、4人以内の交代に再確認を要求しません。

`prepare_integration`の`inputCandidateShas`は1〜128件です。固定した全候補を確認し、最終SHAで既統合・追加のcompletionと`integration`を検証します。必須チェックが32件を超える場合は、同じ`taskId`の`record_decision`へ`decision: "record_integration_checks"`、`integrationSha`、最大32件の`checks`を繰り返し登録し、最後に`accept_integration`します。全チェックの`checked_sha`は同じ最終SHAを指定します。名前の重複、失敗、未実施、別SHAを拒否し、集約上限は128タスク×32項目＋integrationの4097件です。結果SHAを変更する場合は`cancel_integration`して明示的に準備し直します。Git成果は削除しません。

通信frameの上限は維持しています。MCPのattempt／reportページに加え、`get_status.requestOffset`／`nextRequestOffset`で公式要求を取得します。native statusは`attemptOffset`／`nextAttemptOffset`で最大4件ずつ取得でき、`attemptId`指定で個別状態を照合できます。拡張とCLIはページを読みます。詳細と未確認事項は[MC-06検証記録](validation/chat-control/MC-06.md)を参照してください。

## ワーカーのモデル実績

工程表の版2では、実績を記録するタスクに `model_routing` を指定できます。たとえば、`model_routing: { kind: implementation, complexity: bounded, comparison_key: review-tests, pin_initial: true }` と記載します。`kind` は `implementation`、`investigation`、`visual`、`routine` のいずれかで、`complexity` は `bounded` または `complex` です。`comparison_key` と `pin_initial` は任意です。`pin_initial: true` を指定したタスクの初回は、工程表の `agent` を使います。

コーディネーターはタスクを指定して `get_status({runId, taskId})` を呼び、`modelRouting` を読み取ります。必須検証の実行失敗を確認したら、既存の `handoff_new` または `retry_same` に `modelAssessment: { attemptId, reason: 'required_check_failed', checkName }` を添え、`evidenceRefs` に `assessmentEvidence.reportRef` を含めます。`investigation_stalled` でも同じ報告を参照し、`checkName` は省略します。指示不足、環境エラー、承認待ち、統合競合、原因不明の引継ぎは評価対象外として記録できます。未解決の配送・要求・停止がある間は評価を確定しません。

採用の計上には `accept_integration` の成立に加え、必須検証の各 `checked_sha` と最終 SHA の一致が必要です。直列統合の既存手順で `checked_sha` を省略しても Git の取り込みは成立し、モデル実績は未評価になります。初回の受入と引継ぎ後の受入は別々に集計し、起動応答でモデル設定の一致を確認できなかった試行も未評価にします。状態応答には対象の直近200試行以内から集計した結果を最大16行、個別結果を最大4件返します。同じ基準で比較できる計測値が得られるまでは、所要時間と利用量の比較は保留します。

### 承認済みの候補への切り替え

版2の `run` に次のような `worker_model_policy` を追加します。モデル ID と推論強度は利用環境の Codex カタログで取得した値に置き換えます。候補は順序付きの重複しない2〜4組です。`model_routing` を指定したタスクの `agent` は候補列に含めます。同じ run のほかのタスクは、それぞれの `agent` で実行します。

```yaml
worker_model_policy:
  mode: rules
  candidates:
    - {model: model-from-catalog, effort: medium}
    - {model: model-from-catalog, effort: high}
    - {model: alternative-from-catalog, effort: high}
```

1. `start_run` の `modelRouting` に対象タスク、候補の順序、計画と scope の hash、最大追加切り替え回数が表示されます。人は既存のローカル `authorize` コマンドで同じ内容と binding ID を確認します。候補列を変更するときは新しい run を承認します。MC-08 で対象タスクの設定を改訂する場合も候補列の内側で選びます。
2. 照合済みの試行について必須検証の不合格や原因調査の行き詰まりを確認した場合、Coordinator は報告を参照し、`modelAssessment` 付きの `handoff_new` を記録します。broker が現在の設定の次を準備します。修正枠や候補が尽きると `routingBlocked` が返ります。環境エラー・指示不足・承認待ちは原因に応じて対処します。
3. `get_status({runId, taskId})` の `modelRouting.nextAssignment` で設定、前の attempt、理由、根拠を確認します。既存の `create_worker` で新しい Worker を作成し、同じ状態応答に載る attempt と照合してから、その設定を `send_instruction` に指定します。元の worktree と報告を保ち、引継ぎに必要な確認結果を新しい指示に含めます。

停止や計画改訂をまたいだ切り替えは古い選択のまま進めず、現状を照合して改めて判断します。準備後に元の worktree の HEAD が変わったときも、切り替え先を起動する前に停止します。設定がカタログにないなど起動で失敗した場合は `modelRouting.creationFailure`、起動後にカタログから消えた場合は `send_instruction` の `deliveryFailure: agent_not_in_catalog` で確認できます。既存の停止・照合手順に進みます。

### 実績を次のrunで使う

1. 同じリポジトリで、仕事の種類・難しさ・必須チェック名の集合が同じ通常タスクを比較対象にします。共通の `comparison_key` と `pin_initial: true` を指定し、計画の設定と比較候補を着手前に割り当てます。Coordinator の設定をそろえ、モデルと推論強度を一度に変えないと、差の理由を追いやすくなります。
2. 停止確認済みの run の状態ディレクトリを指定して集計します。同じリポジトリの複数のディレクトリを指定できます。出力対象は確定した run から選ぶ重複のない直近200件で、同じ記録時刻は run ID、attempt ID の昇順です。モデル ID と推論強度ごとに初回の採用数・評価数、引継ぎ数を表示します。現在の記録では所要時間とトークン数の合計は `null` で、未計測件数を表示します。

   ```powershell
   node dist/src/cli.js routing-summary --state 'D:\Meristem\run-a' --state 'D:\Meristem\run-b' --out 'D:\Meristem\summaries\routing.json'
   ```

3. 出力は worktree と Codex 認証領域の外に置きます。コマンドが返す `path` と `sha256` を、導入時の信頼済み設定 `mcp.scope.modelRoutingSummary` に指定します。導入設定を生成する場合は、入力の `prepare.modelRoutingSummary` に同じ値を指定できます。起動時に512 KiBの上限、形式、ファイルの hash、リポジトリを照合します。`authorize` で集計 hash を含む scope を確認し、承認します。
4. `mode: rules` では、推奨がある場合も計画の設定で始めます。`mode: learned` では、`pin_initial` を外した通常タスクに推奨を適用します。設定ごとに有効な初回実績が5件以上あり、候補の初回採用率が計画の設定を20ポイント以上上回ることが条件です。同率候補は候補列の順で選びます。引継ぎ後の成功や評価対象外の実績はこの判定から外れます。少数の試行で使う運用上の境界値であり、優越や削減効果を示す統計検定ではありません。
5. 初回の `create_worker` 後に `get_status({runId, taskId})` を読み、同じ attempt の `modelRouting.initialRecommendation.selected` を `send_instruction` に指定します。集計の未指定・実績不足などでは計画の設定が選ばれ、`reason` に理由が出ます。推奨候補がカタログにないことが初回配送前に確定した場合も、計画の設定を照合して使います。配送直前に切り戻した試行は、実行設定の応答確認がないためモデル実績では未評価です。初回の自動選択を止めるには、新しい run を `rules` で承認します。

## MC-08 人の合意に基づく工程表改訂

1. `get_status`の`plan.planHash`を`expectedPlanHash`とし、`propose_plan_change`へ`tasks`、`reason`、`alternatives`（1〜4件）、`recommendation`を渡します。`tasks`は`{ id, depends_on?, completion?, agent? }`の配列です。変更するフィールドだけを指定し、`agent`は工程表の版に合う設定一式を渡します。フォームに収まる単位で提案します。
2. `answer_consultation {decisionId}`で、差分・影響タスク・提案理由を表示します。人の`approve`でその差分を承認します。自由記述を添えた回答は修正案として保存され、新しい構造化差分の提示が必要です。適用前に見送る場合は`answer_consultation {decisionId, close: "cancelled"}`で取り消せます。
3. 影響タスクで旧ワーカーが稼働中なら、`hold_task {taskId, decisionId}`で対象を終了確認まで保留します。承認の前後どちらでも実行できます。依存先の変更は後続タスクにも波及します。統合準備中は予約を解消してから適用します。
4. `apply_plan_change {decisionId, expectedPlanHash, proposedPlanHash}`で、承認されたYAML差分を保存します。ファイル更新後に保存結果が不明になった場合は、状態とoperationを照合し、同じ差分とoperation IDで結果を確認できます。手編集で内容がずれた場合は承認済みの内容を復元し、`reconcile_plan`へstatusの`fileHash`と`observedPlanHash`を渡します。
5. `resume_task {taskId, resolvedDecisionId: decisionId}`で保留を解除し、`create_worker`と`send_instruction`で新しい担当へ明示的に配送します。旧worktree・報告は保存され、改訂タスクは受入済みのGit基点から新しいworktreeを使います。配送時に改訂後の依存関係と必須検証が指示へ付きます。影響範囲外のワーカーは作業を続けられます。

リポジトリ、ブランチ、タスクID、作業範囲、共有資源、実行上限、統合済みの実績は開始時の制約で保護されます。権限プロファイルの選択範囲は既存のRunPermitに従います。表示進捗は`write_progress`、通常の担当交代は`record_decision: handoff_new`を使います。運用中のMarkdown本文は初回登録時に固定されます。本文ハッシュがない旧DBは既存のファイルハッシュと一致する版から移行します。進捗更新で旧ハッシュとずれている場合は、当時のファイルを復元して照合するか、停止と照合を済ませてから別runで実行します。

改訂前の相談フォームと未適用の承認は失効します。保留中または保留を指定した別の相談は、現行版で作り直し、`hold_task`の`replacesDecisionId`で古い保留理由を個別に置き換えます。人に確認した理由の置き換えも人の回答を使います。旧版で承認された増員枠は履歴に残り、改訂後に2人を超えて新規起動する場合は現行版で増員を承認します。

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
