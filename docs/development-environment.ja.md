# 開発環境の診断・設定生成・再利用（DE-01〜06）

[日本語の概要](../README.md) | [導入・運用リファレンス](chat-control-reference.ja.md) | [DE-06回帰・引継ぎ記録](validation/chat-control/DE-06.md)

## 反復開発の入口

通常のロジック修正は `npm.cmd run verify` または型検査・ビルドと関連テストで確認します。通常テストはfixtureとローカルGitを使い、実モデル・実VS Code・外部Gitには接続しません。稼働runがcheckoutのdist/nativeを直接参照していないことを、session・snapshot・所有プロセスの実体から先に確認してください。参照中ならその対象の停止・復元を確認してからビルドします。別工程のrunは終了しません。

専用環境での反復は、下記の順に進めます。Windows PowerShellでnpmのスクリプト実行ポリシーに抵触する場合は `npm.cmd` を使用し、ポリシーを変更しません。

1. 明示したinputで `inspect`。選定済みexe・hash・版・authHomeと、既存runの状態を照合する。blockerは新hashの自動採用で解消しない。
2. `prepare --input` で固定環境を準備する。既存の環境は同じmanifestを再利用する。認証・sandbox setup・親thread作成はこの操作に含まれない。
3. 成功・終了を確認した専用ビルド出力からsnapshotを作り、scenarioとともに新runを生成する。runのDB・identity・許可・送信数は引き継がない。
4. 明示したlive対象だけを `start` → `status`。ロジックだけならlive操作をせず `refresh --change logic --test ...` を使う。
5. `stop` の `stopped` と `restore` の `restored` を確認する。設定の `retained` とleaseも確認してから次のrunを準備する。

通常終了・異常終了・本人限定同意の判断は末尾の表を参照してください。API／CLI／公式UIで可能な準備・操作・停止・復元はエージェントが担当し、利用者への作業依頼は本人限定の認証・正式同意などに限ります。

## 診断の入力

`src/development.ts` の関数で、読取り診断、専用環境の準備、不変なビルドsnapshot、run用設定生成、leaseによる専用環境の再利用を行います。生成だけではインストール、認証、sandbox setup、VS Code起動、モデル送信は行いません。起動・停止・復元は明示したlive操作です。

ビルド後の `dist/src/development.js` から関数をimportして利用します。入力は以下の明示パスです。

| 入力 | 用途 |
|---|---|
| `implementationRoot` | 実装ディレクトリ |
| `envRoot` | 実装・認証領域と分離した専用環境ディレクトリ。未作成ならwarning |
| `authHome` | 正式認証済みとして引き継がれた専用CODEX_HOME。自動探索・複製しない |
| `codexExe`, `nodeExe`, `codeExe` | 選定済み実行ファイルの絶対パス |
| `extensionDirectory` | 選定済み公式Codex拡張のディレクトリ |
| `selectedTools` | `codex` / `node` / `code` ごとの `{ sha256, version }`。引継ぎ済みのSHA-256と版を指定。欠落・不正hash・hash不一致はblocker |
| `settingsFile`（任意） | 確認対象のVS Code JSONC設定。未指定なら未確認 |
| `controlConfig`（任意） | 既存control設定の実行ファイル・hash・authHome参照を照合 |
| `sessionFiles`（任意） | 既存試験sessionの絶対パス。記録されたPIDの存在を読取り確認 |
| `failures`（任意） | `{ kind: 'logon' \| 'setup' \| 'timeout', errorCode?: number }[]`。既に観測した失敗事実だけを入力 |

返り値は `tools` と `diagnostics`。診断は固定の `code`、`severity`（`info` / `warning` / `blocker`）、説明と次の操作を含みます。例外全文、設定全文、資格情報、ログ本文は返しません。選択したパスとSHA-256は返すため、レポートを公開する前にパスを匿名化してください。

実行ファイルは読み取ってhashを照合します。`--version`も実行しません。版は一致したhashに対応する引継ぎmetadata、現在のNode自身の版、公式拡張のpackage metadataから取得し、確認できなければ `null` とwarningを返します。PATH上のCodexが異なっても選定は変更しません。実際の互換性や署名を保証する診断ではありません。

認証は `auth.json` の存在だけを確認し、本文は読みません。sandboxは既存runnerの単純な `[windows]` の `sandbox = "elevated"` / `"mxc"` だけを静的に認識し、重複やその他の表記は未確認です。MXCの起動適合を保証せず、切替・fallbackは行いません。

VS Code設定がrelayを参照する場合は、sidecarの公式Codexパス・hashを照合します。一致してもrelay本体のhash・receiptによる許可は未確認のwarningです。既存のインストール済みrelayを公式exeへ自動置換しません。

`logon_1909`、`setup_failed`、`operation_timeout` は独立したblockerです。setup、再試行、UAC、ログイン、モデルturn、VS Code起動、設定更新は行いません。PIDの存在は所有者の証明ではなく、PIDがなくても終了・復元成功にはしません。`run_state_unknown` を維持し、必要なら既存runの正規statusとreceiptを別途照合してください。

検証は `npm run build` と `node --test dist/test/development.test.js`。MC-02からの留保と実行記録は [DE-01の検証記録](validation/chat-control/DE-01.md)を参照してください。

## 設定生成とsnapshot（DE-02）

ビルド済み `dist/src/development.js` から以下をimportします。入力パスと `selectedTools` は前節の引継ぎ値を明示し、PATHや最新版から補完しません。

| 関数 | 動作 |
|---|---|
| `prepareEnvironment(input, report)` | reportを再照合し、専用 `envRoot` に環境manifestと空の専用profile・extensions領域を作成。選定済み実体と公式拡張metadataを固定。既存manifestが同じなら再利用し、profileの利用者変更は保持 |
| `recordBuildCompletion(buildRoot)` | 成功して終了したビルドの出力を2回読み、固定レイアウト・必須入口・依存の版とhashを記録。コンパイラは実行しない |
| `snapshotBuild(environment, completed, id?)` | 完了記録と入力hashを照合し、新しいbuild IDの領域へcopyして再照合。ID省略時はUUID。snapshot manifestを最後に保存 |
| `prepareRun(environment, snapshot, scenario)` | snapshotを再検証し、新runのplanコピー、control設定、installer Spec、sessionを生成。DB・許可・実行ownerは作らず、起動時の既存処理へ委ねる |

`recordBuildCompletion` は、呼出元が `npm run build` と `scripts/build-native.ps1 -OutputDirectory <専用出力>` の成功と終了を確認した後で呼びます。記録は出力bytesの同一性を示し、ソースの新しさやビルドコマンドの成功を推測するものではありません。隔離したbuildRootも指定できますが、snapshot／認証領域と重ならず、必要なpackage、lockfile、依存、migrationを含む以下の配置が必要です。実行中の旧runが参照するdist/nativeへ再ビルドしないでください。

```text
envRoot/
  environment.json
  profile/User/settings.json
  extensions/
  snapshots/<build ID>/
    package.json, package-lock.json, snapshot.json
    dist/src/*.js
    extension/package.json, extension/dist/src/*.js
    migrations/
    node_modules/   # lockfileの実行依存とinstaller用TypeScript
    .local/chat-control-build/{CodexRelay,CodexWorkerHost,MeristemControl}.exe
  runs/<run ID>/
    plan.md, control.json, install.json, session.json
    state/          # 後続の起動処理で新規作成
    installation/   # installerのreceipt・run用relay等。生成時は未作成
```

snapshotは専用出力だけを対象とし、`.local` 全体、テスト、認証情報、公式Codex・Nodeのexe、公式拡張本体を複製しません。Node・Codexは選定済みの絶対パスとhashを参照します。依存をsnapshot内に含めるため、checkout外でもモジュール解決とDB migrationが可能です。

scenarioには既存のplan版1を使い、`kind: 'serial' | 'parallel'`、`planPath`、`repositoryPath`、`repositoryId`、`parentCwd`、`parentThreadId`、`branchScope`、`agent: { model, effort }` を明示します。serialは `max_parallel: 1`、parallelは2です。試験repo・worktrees・親cwdは実装・環境・認証領域と分離し、試験Git領域の作成は既存fixture等で先に行います。既存repoを自動複製・初期化・変更しません。

`approvedMaxTurns` とWorker送信枠の `maxInstructions` は省略時ともに0です。明示する場合は整数0〜20、`maxInstructions <= approvedMaxTurns`、差分（自動wake枠）は既存runtimeの上限12以内とします。差分0ならwakeを設定しません。これは設定の生成であり、RunPermitや本人の承認を発行する操作ではありません。新runはrunId・pipe・stateDirectoryを生成し、旧sessionの送信数、owner/epoch/attempt、permitを読み込みません。

既存snapshotの上書き・削除は行いません。破損、入力変更、manifestや生成先plan/control/Specの同時編集、path traversal、junctionは拒否します。失敗時の部分出力は保持し、`snapshot.json`／`session.json` が未確定なら実行可能と扱いません。再生成は新しいIDを使います。生成sessionの起動には、次節のDE-03経路を明示します。

全体検証は `npm run verify` を使います。nativeとfixtureの再生成、型検査、ビルド、通常・制御・端末テストを順に実行します。個別に `npm run build` と `node --test dist/test/development.test.js dist/test/install.test.js` を実行する場合も、初回やnative／C# fixtureの変更後は先に `npm run build:native` が必要です。稼働中の実体を上書きしない条件を守り、PowerShellに拒否された場合はポリシーを緩めず、許可された通常の実行環境を確認します。[DE-02の検証記録](validation/chat-control/DE-02.md)に実行結果と未確認事項を残しています。

## 専用環境の再利用と終了・復元（DE-03）

`startDevelopmentRun(environment, run, driver)`、`statusDevelopmentRun`、`stopDevelopmentRun`、`restoreDevelopmentRun` は非同期APIです。Windows用driverは `test/live/development-session.ts` にあります。元の受入runnerは既定動作を維持し、開発経路だけ `--environment` を指定します。

```powershell
node dist/test/live/cc02-prepare.js --environment C:\dedicated\environment --snapshot C:\dedicated\snapshot.json --scenario C:\dedicated\scenario.json
node dist/test/live/cc02-session.js launch --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json --live
node dist/test/live/cc02-session.js status --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json
node dist/test/live/cc02-session.js stop --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json --live
node dist/test/live/cc02-session.js cleanup --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json --live
```

パスとRUN_IDは例です。snapshot JSONは `snapshotBuild` の戻り値、scenario JSONは前節の明示入力です。親threadも正式認証済みauthHome内で準備済みのものを明示します。このprepare経路はthreadやモデルturnを生成しません。起動は既存installerの版取得とreceiptを利用し、選定済み公式拡張のjunctionを専用extensions領域に作り、snapshotのMeristem拡張を開発hostへ渡します。モデル送信枠はscenarioで明示し、起動による自動送信は0です。新規認証・sandbox setupは追加しません。統合CLIとrefreshは次節、実Codex／UI／UACを含む2サイクルの測定はDE-05です。

環境とauthHomeのleaseを排他的に作り、共有auth設定への書込みを直列化します。runの所有権は起動前に保存し、別の操作lockで同一runの二重CLIも拒否します。prepare中は一時lease、起動後は停止・復元まで続くleaseです。残ったleaseは自動回収・上書きしません。異なるauthHomeがOS側で干渉する問題を解決したとは扱いません。

停止は既存brokerのstopを通してWorkerのidentityと終了結果を照合します。記録したCodeプロセスの実体・作成時刻・handleを検証し、通常のウィンドウ終了を要求します。未保存編集の確認等で終了できなければ強制終了せず `unknown` とします。捕捉した子プロセスの終了、追加のprocess照合、DBのstop記録も確認します。任意に離脱した子孫の完全な追跡や実VS Codeの終了はfixture成功から保証しません。

phaseは不変のsessionとは別の `lifecycle.json` に記録します。停止確認後も復元直前に専用profileの未使用を確認します。installerは所有するCLI設定とMCP blockだけを復元し、profile、認証、snapshot、Git領域、DB、証拠を削除しません。利用者が変更した値は保持します。編集済みMCP tableが残る場合はleaseを保持し、再利用を拒否します。receipt改変・所有receiptが未記録の部分install・起動identity不明・操作中断後のlockは、証拠を保持して照合を要する状態にします。正常なstopとrestoreの再実行は冪等で、別runのleaseを解放しません。

[DE-03の検証記録](validation/chat-control/DE-03.md)にローカル検証と実機未確認の範囲を記載します。

## 変更の反映と統合CLI（DE-04）

`npm run build` 後、`npm run development -- <操作>` を使います。JSON入力ファイルと実行対象のパスは絶対パスで指定します。`inspect` は読取りのみ、`prepare` は専用成果物の生成だけです。起動・停止・復元と実行を伴うrefreshには `--live` が必要です。省略されたモデル送信枠は0で、CLI自身はモデルturnを送りません。

```powershell
# input.jsonは前節のEnvironmentInput。通常のCODEX_HOMEを自動選択しません。
npm run development -- inspect --input C:\dedicated\input.json
npm run development -- prepare --input C:\dedicated\input.json

# ビルド成功・終了を確認した専用出力をsnapshot化する。JSONはBuildSnapshot。
# 稼働中runの不変snapshotは変更しません。
npm run development -- prepare --environment C:\dedicated\environment --build-root C:\completed\build

# 上の結果をnext-snapshot.jsonに保存し、明示scenarioから新runを生成する。
npm run development -- prepare --environment C:\dedicated\environment --snapshot C:\dedicated\next-snapshot.json --scenario C:\dedicated\scenario.json
npm run development -- start --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json --live
npm run development -- status --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json
npm run development -- stop --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json --live
npm run development -- restore --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json --live

# ロジックだけの変更。環境指定・live操作は不要。関連するビルド済みテストを明示する。
npm run typecheck
npm run build
npm run development -- refresh --change logic --test D:\checkout\dist\test\development.test.js

# 稼働中runを停止・復元して、新snapshotと新runで起動する。
npm run development -- refresh --change runtime --environment C:\dedicated\environment --session C:\dedicated\environment\runs\RUN_ID\session.json --snapshot C:\dedicated\next-snapshot.json --scenario C:\dedicated\scenario.json --live
```

パスは例です。`--test` は現在のcheckoutの `dist/test` 内の `.test.js` に限定し、複数回指定できます。指定テストの失敗はCLIの失敗として返ります。`prepare --build-root ... --scenario ...` ならsnapshotとrunをまとめて生成できます。snapshotだけを生成する場合は、既存環境を `--environment` で指定すれば稼働runのleaseを解放せず使えます。`npm run` の出力にはnpmの案内も含まれるため、JSONをファイルへ直接保存する場合は `node dist/test/live/development.js ...` を使います。

| `--change` | 処理 |
|---|---|
| `logic` | `tests_only`。選んだ関連テストだけを実行。VS Code・sandbox・モデルは起動しない |
| `extension` | `reload_window`。現行hostの再読込みは管理leaseを失うため、所有runの終了・復元を確認してから、新snapshotを読む専用hostと新runを起動 |
| `runtime` / `launch` / 未知の値 | `restart_session`。同じ停止確認と新run生成を必須にする |
| `acceptance` | `fresh_acceptance`。`not_run` と既存 `dist/test/live/acceptance.js` の入口を表示。現在のrunやDBを再利用せず、[既存の実機受入手順](chat-control-reference.ja.md)で独立したクリーンrunを準備する |

runtime等のrefreshは旧snapshotと異なるbuild IDを要求します。公式Codex・Node・Code・公式拡張の選定値、snapshot、scenarioを停止前に照合し、開始直前にも既存検査を通します。公式Codexの版が変われば、新hashを自動承認せず、互換性確認と明示した環境選定からやり直します。DB・型・設定の互換性を推測して旧DBを開く経路は設けず、毎回新しいidentity・DB領域・receiptを生成します。旧DBとGit成果、利用者の設定変更は保持します。

`runs/RUN_ID/refresh.json` を副作用の前に排他的に作り、同じrefreshを再送しません。後継runの生成後は、起動前に同ディレクトリの `refresh-result.json` へそのsessionを保存します。成功後は返された後継runのsessionでstatus／stop／restoreしてください。停止が `unknown` なら起動せずCLIは終了コード1を返します。起動失敗・通信断・途中中断も自動再送せず、旧runと後継runのstatus、lifecycle、receiptを確認します。予約記録を削除して再試行せず、停止・復元後に明示した新runを準備します。別runがleaseを取得した場合は、そのrunを停止せず切替を拒否します。

ビルドと反映は別操作です。既存のtsc watchを使ってもコンパイルだけに留め、live再起動・hashの許可・モデル送信へ連動させません。実行中snapshotの上書きやnativeの差替えは行いません。開発hostの再起動とfixtureの成功はクリーンな実機受入の成功を意味しません。[DE-04の検証記録](validation/chat-control/DE-04.md)を参照してください。

## 有限のprobeと開発サイクルの記録（DE-05）

静的な `inspect` はsandboxを起動しません。明示した環境に対して、別操作の `sandbox-probe` を使います。対象の正式認証・sandbox準備を先に確認してください。専用領域にも本人のUAC同意が必要になる場合があります。

```powershell
npm run development -- sandbox-probe --environment C:\dedicated\environment --probe-id first-mxc --sandbox mxc --timeout-ms 30000 --live
npm run development -- cycle --environment C:\dedicated\environment --snapshot C:\dedicated\snapshot.json --scenario C:\dedicated\scenario.json --live
```

`--sandbox` は `elevated` または `mxc` の明示指定だけ、timeoutは1000〜30000ms（省略時30000ms）です。選定済みexeと環境manifestを再照合し、認証領域のleaseを取得して、sandboxを1回だけ起動します。管理設定を読み込み、workspace内のファイルを読めることと、専用canaryの読取り拒否を確認します。MXCの自動選択を無効にして指定方式へ固定し、失敗時の方式切替・setupの再試行・モデル送信は行いません。保存済みのsandbox選択やWindows設定も変更しません。

結果は `probes/PROBE_ID/probe.json` に保存します。同じprobe IDは再実行できません。raw出力や例外本文は保存せず、固定の失敗ラベルとexit codeだけを残します。環境IDと `authLeaseHash` で予約の所有記録を照合できます。`phase: observed` はコマンド完了と管理領域denyを示し、子孫を含む終了の受入や実UIの確認を意味しません。`ownedProcessesStopped` と実際のUAC回数は、観測できなければ `unconfirmed` です。timeout・起動失敗では実行結果が不明なためauth leaseを保持します。記録とOS上の所有者・終了を照合するまで、leaseを削除して再試行したり別方式へ切り替えたりしないでください。自動回収の機能はありません。

`cycle` は送信枠0のscenarioだけを受け付け、新runのprepare→start→status→stop→restoreを既存の所有者・receipt検査を通して実行します。`runs/RUN_ID/cycle.json` に各段階の実測時間を保存します。結果不明の停止では復元せず、次のrunもleaseで拒否します。起動や限定確認の失敗は、後片付けが成功しても `phase: unknown` のままです。`cleanupPhase` と `limitedCheck` は別に記録します。`limitedCheck: observed` は専用プロセスのrunning照合であり、画面やモデル応答の確認ではありません。

CLIが明示的に呼んだsetupとモデルturnは0です。公式Codex内部のsetup、UAC、人へ依頼した操作、window再起動は、自動計測していないため `unconfirmed` と記録します。数値0で代用しません。2回の試験では同じ環境・profile・authHomeを使い、各回を停止・復元した後に新runを準備してください。[DE-05の実測と留保](validation/chat-control/development-environment-first.md)にfixture・実Codex・実UI・OS隔離の範囲を分けて記録します。

## 終了・中断時の判断

| 観測した状態 | エージェントが行う確認と次の操作 |
|---|---|
| 正常終了 | 対象sessionでstop→restore。`stopped`／`restored`、receiptの復元結果、専用profileの未使用、環境・共有authのlease解放を確認する。Git成果・DB・証拠・profile・認証は保持する |
| stopが `unknown`、操作接続の切断、host消失 | window消失やACKだけで終了成功にしない。対象runとrefreshの後継session、lifecycle、receipt、discovery、OSの実体・作成時刻・所有プロセスを照合する。確認不能ならleaseと証拠を保持し、新run・再送・復元を進めない |
| 二重CLI・他runのlease | 競合操作を中止し、所有者のrunを確認する。leaseや操作lockを削除して通さず、他runのwindow・MCP・DBへ触れない |
| 設定の同時編集・復元の再実行 | installerが利用者変更を保持することと `retained` を確認する。所有MCP tableが編集されて残る場合はleaseを解放しない。確認済みstop／restoreの再実行は同じ対象だけに行い、別runのleaseを解放しない |
| 別版exe・hash不一致・snapshot破損 | 切替を拒否し、旧runを保持する。公式版の再選定は互換性確認を伴う別操作。自作ビルドは成功を確認して新しいsnapshot IDで生成し、既存snapshotは上書きしない |
| UAC・ログイン・正式UI同意が必要 | エージェントは正規の入口と対象・必要性を示す。本人だけが回答し、回答後の結果を別途確認する。UAC自動クリック、秘密・markerのコピー、sandbox方式の無断fallback、同一失敗条件でのsetup再試行はしない |

通常のdriverでwindowを観測できない場合、起動を再送せず先にOSと正式UIを照合します。DE-05の現在PCでは通常CLIからのwindow表示を確認できず、公式Computer Useの `launch_app` と専用GUI補助で2回の通常終了を観測しました。その補助はローカル試験用であり、CLI一般の可視性を保証しません。強制終了は別の重大な影響を伴う操作です。DE-05の一度の明示同意を、将来のrunの同意へ流用しません。詳細と補助資料の所在は[DE-05記録](validation/chat-control/development-environment-first.md)に残しています。

## クリーン受入と後続工程

`refresh --change acceptance` は `fresh_acceptance`／`not_run` と既存runnerの入口を返すだけです。実機受入そのものは開始しません。独立した試験root、専用profile、新run、有限送信枠を用意し、[運用リファレンスのCC-07手順](chat-control-reference.ja.md)から `dist/test/live/acceptance.js prepare|install|launch|parent|status|cleanup` を明示実行します。旧受入の接続情報を使う場合も復元済みsessionと現在の選定値を照合します。`cleanup --window-closed` の前提を守り、開発用の再利用経路に置き換えません。外部Gitの受入には明示した試験repo／branchが別途必要です。

開発用scenarioの `approvedMaxTurns` は親wakeを含む総枠、`maxInstructions` はWorker枠です。省略時は両方0。たとえば総枠6・Worker枠2を明示するとwake枠は4です。各値は0〜20の整数、Worker枠は総枠以下、差分は12以下にします。これは設定例であり送信許可ではありません。実送信には別途承認された有限枠と既存のRunPermitが必要です。`cycle` は両枠0だけを受け付け、クリーン受入runnerの `--max-turns` 契約とは区別します。配送不明の指示も消費記録に残し、自動再送しません。

MC-03には [DE-06引継ぎ記録](validation/chat-control/DE-06.md)のmanifest・snapshot参照、対応表、終了状態、有限枠と留保を渡します。MC-02の実UI回答・個別auto-reviewの確認範囲は着手時に対応表の最新版で再確認し、DEの成功で未確認事項を埋めません。MC-11は `inspectEnvironment`／`prepareEnvironment`／`snapshotBuild`／`prepareRun` と既存installerを再利用し、新しい権限・計画版2・リリース用設定の対応を後半で仕上げます。これらの新仕様や通常環境への導入・公開・常駐化はDE-06の範囲外です。
