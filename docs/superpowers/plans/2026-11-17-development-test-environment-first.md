# 開発と試験環境の整備を先行する Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 今回の依頼は本書の作成だけ。実装・設定変更・試験起動・sandbox初期設定は開始しない。後日の実装ではMC-02の検証終了と引継ぎを確認したあと、本書を元計画のMC-03より先に実施する。進行中の別作業、未コミット差分、過去の証拠を上書きしない。

**Goal:** 毎回の設定作成、認証・sandboxの再準備、VS Codeの開閉、停止・復元の手作業を減らし、以降のMeristem改修を既存のCodexから検証しやすくする。

**Architecture:** 既存のinstaller・receipt・試験runner・通常テストを再利用し、明示した専用環境の診断、設定生成、寿命管理を薄い開発用CLIにまとめる。認証／sandbox／VS Codeプロファイルは再利用し、runごとのidentity・DB・指示・証拠は分離する。実行中の成果物を直接差し替えず、変更範囲に応じて通常テスト、拡張の再読込み、対象プロセスの再起動、クリーンな実機受入を使い分ける。

**Tech Stack:** 現行のWindows x64、Node.js 24.22.1以上、TypeScript、C#／.NET Framework、PowerShell、Node組込みAPI、既存yaml/zod、VS Code公式CLI・開発ホスト、`node:test`。新規依存関係や常駐サービスを前提にしない。

**Spec:** 本書「1. 先行する仕様」が今回の合意。元の[ワーカー運用改善計画](2026-11-17-worker-coordination-evolution.md)のMC-11から現行環境で先行できる部分を切り出し、試験環境の再利用と開発時の反映手順を追加する。元計画1.7節の自律実行方針を適用する。本書作成は2026-11-17（日本時間）。MC-02の[対応表](../../validation/chat-control/worker-coordination-compatibility.md)は進行中の引継ぎ資料であり、実装着手時に最終版を再確認する。

## Global Constraints

- 順序は「MC-02の検証終了・引継ぎ → 本書DE-01〜06 → 元計画MC-03以降」。MC-01/02の実装・証拠は再実装せず利用する。元計画のファイル自体は今回変更しない。
- ここで改善するのは開発・試験の運用。Meristemを使ってMeristem自身を開発することを必須にしない。現在使うCodexと、試験対象のCodex／Meristemを区別する。
- 診断はデフォルトで読取りのみ。モデルturn、sandbox実行、UAC、インストール、認証、設定変更を「診断」の副作用として開始しない。
- UACの保護を維持する。自動クリック、UAC無効化、保護ポリシーの緩和、秘密・sandbox markerのコピーによって確認を省略しない。
- 元計画のタスク権限選択、増員、相談UI、工程表改訂、無制限運転などは実装しない。新しい権限・plan版2の実行設定への対応は、該当機能が固まったあとのMC-11で仕上げる。
- 通常のVS Code設定、通常の `CODEX_HOME`、PATH、registry、firewall、OSポリシーを暗黙に変更しない。本人限定のログイン・正式同意以外の承認済み準備・操作・停止・復元はエージェントが行う。
- 明示したexe・版・hashの照合を維持する。ビルド後の自分の成果物は停止確認後に再生成できるが、公式Codexの版変更をhashだけ差し替えて受け入れない。
- owner/epoch/attempt、単一writer、配送不明の再送禁止、停止確認、Git成果・未コミット変更・履歴の保持を維持する。待機中の別工程や別ユーザーのプロセスを止めない。
- 無関係な変更を混ぜない。プロジェクトの必須検証、Git規則、実機観測の区別を維持し、未実施は `not_run`、終了未確認は `unknown` とする。

## Review Focus

| 条件 | 必要な動作 | 工程 |
|---|---|---|
| UAC連発、ログオンエラー1909、同じsetup失敗の繰返し | 同一条件で自動再試行を続けず、症状・対象・根拠を記録。通常診断からsetupを起こさない | DE-01 |
| PATHと公式拡張に別版のCodexがある／公式拡張が更新された | MC-02で選んだ実体を照合し、勝手に最新版を選択・許可しない | DE-01/02 |
| 同じ環境を2回使う／別の試験が同時利用する | 認証・profileは維持し、実行DBとidentityは別。環境leaseで競合を拒否する | DE-03 |
| 生きているrunの最中にdist・native・設定が変わる | 稼働中artifactを上書きせず、必要な対象だけ停止・再起動する。未知なら切替を保留する | DE-02/04 |
| 試験中に利用者が設定変更／操作接続が切れる | receiptと所有者を再照合し、利用者の変更を保持。接続切断だけで停止成功にしない | DE-03/05 |

## 1. 先行する仕様

### 1.1 MC-02の引継ぎ条件

実装着手時にMC-02の最終commit／差分、対応表、検証結果、対象の公式Codex・拡張・Nodeの版とhash、専用authHome、未確認事項、終了・復元状態を読む。MC-02で実行中のVS Code・broker・workerが残っていれば、対象を識別して引継ぎ、無断で終了・再設定しない。

「MC-02終了」は、すべてのAPI・UIが対応済みという意味ではない。例えば実UI回答や個別auto-review結果が未確認なら、そのまま留保して本書の非依存部分へ進める。本書の完了を、人間専用回答経路や新しい権限機能の受入に流用しない。

作成時点でMC-02の対応表にはPATH上と公式拡張同梱のCodexが別版だったこと、実UI回答・一部レビュー結果が未確認であることが記載されている。これは途中経過であり、着手時の事実を再取得する。

### 1.2 診断とUAC連発への対応

最初にファイルの存在・実体パス・版・hash、専用領域、設定の参照先、sandbox選択、既存試験の生存状態を読取りで確認する。認証は必要な状態の有無だけを確認し、トークン・cookie・資格情報・raw設定全文は出力しない。

UAC頻発の原因候補として、異なるauthHome間の初期設定干渉、初期設定の失敗・再試行、異なるCodex版、対象フォルダー／ネットワーク条件の変化を調べる。原因はログ・実設定で確認し、既知issueだけから断定しない。採取するログは診断ラベル・エラーコード・必要な時刻等に絞り、秘密を保存しない。

同じ失敗条件で自動setupを繰り返さない。通常のプロセス起動で `CreateProcessWithLogonW` の1909などが出た場合も、記録して進行可能な読取り・文書・通常テストを切り分ける。正規の権限確認・実行経路を使える場合は必要性を明示して利用し、制限を迂回しない。アカウントのunlockやWindowsポリシー変更は暗黙に行わない。

MXCは候補として診断に表示できるが、OS／Codex／組織ポリシー／管理領域deny／所有プロセス停止の適合確認前に切り替えない。実際のsandbox起動probeは通常診断と別の明示操作にし、拒否・失敗・timeout後に自動fallbackや再設定を行わない。対応がなくてもelevatedで使える先行改善は続ける。

### 1.3 固定環境とrunを分離する

利用者が指定した専用envRootに、再利用するVS Codeデータ・拡張参照・環境manifestと、run別のDB・設定・receipt・証拠を分けて置く。envRootの配置は既存installerのrepo／worktree／implementationRootとの分離条件を満たす。authHomeはMC-02で確認した正式認証済みのものを明示参照し、runごとに増殖・複製しない。

再利用するのは認証／sandbox準備と専用profile等の固定部分であり、旧RunPermit、owner epoch、DB上のactive状態、turn予算、approval grantではない。runId・pipe・親binding・stateDirectory・Gitの試験領域・送信枠は新run用に生成する。既存runの再開と新run作成を混ぜない。

envRoot単位の単一leaseと、元ファイルの内容／receipt照合を用意する。同じauthHomeに一時MCP設定を書き込む操作は直列化し、既存の別試験のentryがあれば上書きせず所有者を照合する。試験終了時はrun用設定だけを復元し、固定profileやauthHome全体を消さない。複数のauthHomeがOS側で干渉する問題は、各ディレクトリのleaseだけで解決したと扱わない。

### 1.4 自動生成とビルド成果物

MC-02の選定済みパス・版を元に環境manifestを生成し、以後の絶対パス・hash・control／install設定を機械生成する。候補が複数でも、既に承認・選定された実体があればそれを使う。単にPATHの先頭や最も新しいexeを採用しない。

ビルドと実行を分離する。実行対象はbuild IDとhashで固定したsnapshotとし、runが使うJavaScript・native・sidecarを編集中のdistへ直結させない。既存installerが要求する `dist/src/`、`.local/chat-control-build/` 等の配置をsnapshot内でも維持して、汎用plugin loaderを作らない。Node・公式Codexは明示パスで参照してよく、ライセンス・認証を含む無条件コピーはしない。

snapshot作成はビルド完了を確認した後の専用出力だけを対象に行い、入力が途中で変われば失敗として再生成する。build IDを任意パスとして使わず、同じsnapshotを別内容で上書きしない。runが参照中のsnapshotは消さない。

### 1.5 変更の反映と試験モード

| 変更内容 | 開発時の反映・確認 |
|---|---|
| ロジック・validation・保存処理 | 型検査、関連するmock／ローカルテスト。VS Codeは起動しない |
| 拡張の表示・コマンド | ビルド後、専用開発ホストを再読込みして確認 |
| broker・MCP・worker host | 該当runを安全に終了し、新snapshotと新しい実行identityで起動 |
| 親relay・起動契約・profile・接続binding | 必要な専用Codex／VS Codeセッションを停止・再起動。必要ならwindowを閉じる |
| 停止・切断・復元・正式受入 | 独立したクリーンな試験runで再現する |

拡張hostの再読込みでも、管理lease喪失等によってrunが停止し得る。停止する場合は先に終了を確認し、「UI変更だから実行中でも安全」と判断しない。現行アーキテクチャで必要な再起動は残すが、profile・authHome・sandboxの初期準備までやり直さない。

自動ビルドは既存tscのwatch等を優先する。ただしwatchによる再コンパイルは、実行中プロセスへの即時反映や新hashの許可を意味しない。全文ホットリロード、実行中のnative差替え、正規設定を迂回する動的コード注入は追加しない。

開発時の反復確認と、再現性を確認する最終受入を分ける。開発モードだけの成功をクリーンな実機受入成功へ読み替えない。実機のモデル送信は明示した有限枠を使い、環境準備だけでモデルを呼ばない。

### 1.6 自律実行と範囲外

元計画1.7節に従い、承認済みの設定生成・起動・VS Code操作・MCP停止・終了確認・復元・検証はエージェントが担当する。自身の接続が切れる操作は、先に記録と別の正規確認経路を準備して行う。本人限定の認証・UAC等の同意だけを利用者へ依頼する。依頼には実際の制約と、何を試したかを示す。

製品全体のON/OFFスイッチ、通常profileへの導入、Marketplace公開、自動更新、常駐サービス、OS横断対応、UAC自動承認、v0.2.0新機能そのものは範囲外。既存の試験起動・停止・復元操作を整えることは本書の範囲に含む。

## 2. 既存コードと変更候補

| 場所 | 現状と利用方法 |
|---|---|
| `src/install.ts`, `test/install.test.ts` | 明示パス・hash、固定レイアウト、設定2箇所の変更、receipt、利用者変更を保護する復元を再利用 |
| `test/live/cc02-prepare.ts` | 新規root、authHomeの明示、profile／run生成を既に持つ。固定環境とrun生成の分離に使う |
| `test/live/cc02-session.ts` | launch／relaunch／status／cleanupを持つ。既存の閉鎖要件を単に削除せず、開発用の寿命管理と使い分ける |
| `test/live/acceptance.ts`, `test/live/approval-roundtrip.ts` | 実機入口・有限送信枠・MC-02 probeを再利用。確認済み以上の能力を前提にしない |
| `scripts/build-native.ps1` | `-OutputDirectory` を利用可能。稼働中exeへの上書きを避ける |
| `src/workers.ts`, `native/Program.cs` | exe・入口hash、所有者、終了確認は維持。先行環境改善だけのために権限・停止本体を改造しない |
| `package.json`, `tsconfig.json`, `extension/tsconfig.json` | 既存build・typecheck・testを再利用し、必要最小限の開発用入口を追加 |

作成候補は `src/development.ts`（診断・設定生成）、`test/live/development.ts`（開発用操作CLI）、`test/development.test.ts`（fixture試験）、`docs/development-environment.ja.md`（手順）。役割が既存関数への数行の委譲で済む場合はファイル分割を増やさない。既存CLIをラップしても、認可・hash・停止確認を省略しない。

## 3. 共通interfaceと状態

以下は実装案であり公式Codex APIではない。MC-02終了時の既存型を優先し、重複定義を避ける。

```ts
type EnvironmentInput = {
  implementationRoot: string; envRoot: string; authHome: string;
  codexExe: string; nodeExe: string; codeExe: string; extensionDirectory: string;
};
type Diagnostic = {
  code: string; severity: 'info' | 'warning' | 'blocker';
  message: string; nextAction: string | null;
};
type EnvironmentReport = {
  tools: Array<{ name: string; path: string; version: string | null; sha256: string }>;
  diagnostics: Diagnostic[];
};
type BuildSnapshot = { id: string; root: string; manifestHash: string };
type DevelopmentEnvironment = {
  id: string; envRoot: string; authHome: string; profileDirectory: string;
  extensionsDirectory: string; input: EnvironmentInput; manifestHash: string;
};
type DevelopmentRun = {
  id: string; environmentId: string; snapshot: BuildSnapshot;
  stateDirectory: string; sessionFile: string;
  phase: 'prepared' | 'running' | 'stopped' | 'restored' | 'unknown';
};
type ChangeClass = 'logic' | 'extension' | 'runtime' | 'launch' | 'acceptance';
type RefreshAction = 'tests_only' | 'reload_window' | 'restart_session' | 'fresh_acceptance';
```

- `inspectEnvironment(input: EnvironmentInput): EnvironmentReport` は静的診断のみ。JSONC／TOMLの内容全体を再構成しない。既存MC-11用interfaceと統合できる場合は互換adapterを使い、別々の設定契約を増殖させない。
- `prepareEnvironment(input: EnvironmentInput, report: EnvironmentReport): DevelopmentEnvironment` は専用領域とmanifestを準備し、通常設定は変更しない。実認証・sandbox setup・モデル送信は行わない。
- `snapshotBuild(environment: DevelopmentEnvironment): BuildSnapshot` は完了した成果物の配置とhash検証を行う。ビルドコマンドそのものは既存npm／PowerShellを使う。
- `prepareRun(environment, snapshot, scenario): DevelopmentRun` は新runのcontrol／install／session設定を生成する。scenarioは既存のserial／parallel試験が使えるものに限定し、親thread・repo・許可範囲を明示する。
- `selectRefresh(change: ChangeClass): RefreshAction` はlogic→tests_only、extension→reload_window、runtime/launch→restart_session、acceptance→fresh_acceptance。変更classが不明ならrestart_sessionへ倒す。実行中lease・プロセス状態による停止確認は、この選択とは別に必須とする。
- 開発CLIは `inspect | prepare | start | status | stop | refresh | restore` を入口にする。既存session runnerとinstallerへ委譲できる処理は再利用する。`start`／実行を伴う`refresh`は明示したlive環境だけを対象にし、既定で送信するモデルturnは0。
- phaseの更新はプロセス・receiptの事実確認後に保存する。受信ACKやwindow消失だけでstopped／restoredへ進めない。実行不明の操作をCLI再実行で無条件に再送しない。

## 4. 実装工程

工程は `DE-01 → DE-02 → DE-03 → DE-04 → DE-05 → DE-06`。既存の `node:test` とfixtureでred→greenを確認し、工程単位で自己レビュー・commitする。共有されたMC-02の未コミット変更や、別エージェントのビルド中成果物を巻き込まない。実装開始前にMC-02の完了状態と作業所有を確認する。

### DE-01: 引継ぎと副作用のない環境診断

**Files:** Create `src/development.ts`, `test/development.test.ts`; Read `docs/validation/chat-control/worker-coordination-compatibility.md`; Reuse `src/install.ts` の既存のパス・hash検証。

**Interfaces:** 3節の `EnvironmentInput`、`EnvironmentReport` と `inspectEnvironment` を作る。診断ラベルは固定し、rawログや例外全文を出さない。

- [x] MC-02の最終結果・版・hash・authHome・残プロセス・復元状態を読む。UI未確認等を消さず、今回に必要な事実と後続へ残す留保を記録する。
- [x] `inspect_does_not_start_sandbox_model_or_uac`：fixtureの起動記録が空、通常settingsとauth設定がbyte単位で不変、秘密文字列がreportに含まれないことをassertする。
- [x] `inspect_reports_selected_executable_mismatch`：PATH上と選定済みCodexが別版でも選定値を変更せず、消失・hash不一致をblockerとして返すことを確認する。
- [x] `setup_failure_is_reported_without_retry_loop`：1909・setup失敗・timeoutの入力事実を区別し、setup呼出し回数が0のままであることを確認する。Windowsの制限を解除する処理を追加しない。
- [x] `npm run build`、`node --test dist/test/development.test.js` で失敗を確認後、最小の読取り診断を実装して同コマンドを通す。証拠の匿名化と副作用を自己レビューしてcommitする。

実装・検証・MC-02の留保は [DE-01の検証記録](../../validation/chat-control/DE-01.md)を参照。MC-02は未完了のまま、今回の明示依頼に従って非依存の読取り診断だけを実装した。

### DE-02: 設定生成と不変なビルドsnapshot

**Files:** Modify `src/development.ts`, `src/install.ts`, `test/development.test.ts`, `test/install.test.ts`; Reuse `scripts/build-native.ps1`。設定型のexport等、既存installerへの変更は最小限にする。

**Interfaces:** `prepareEnvironment`、`snapshotBuild`、`prepareRun` を追加する。環境manifest、snapshot manifest、runごとのsessionを別に保存する。

- [x] `generated_paths_and_hashes_match_snapshot`：空白・日本語を含む専用配置で生成したentry／native／MCPの実体とhashが一致し、既存installerが受理する配置になることを確認する。
- [x] `snapshot_never_overwrites_live_build`：runが使用するsnapshotは変更せず、新build IDへ出力する。同じIDに別内容、生成中の入力変更、snapshot外を指すpath traversalを拒否する。
- [x] `new_run_never_reuses_identity_or_budget`：同環境の2回目でもrunId・pipe・stateDirectory・owner関連の生成対象が新しくなり、有限試験枠と旧許可を流用しないことを確認する。
- [x] 既存のSpec・receipt・固定レイアウトを再利用して生成を実装する。保存時に既存ファイルの同時変更を検出し、credentialやauthHome全体をcopyしない。ビルド・copy・検証を同期した一まとまりにする。
- [x] `npm run build`、`node --test dist/test/development.test.js dist/test/install.test.js` のred/green、配置・復元回帰確認後にcommitする。新しいartifact形式だけのためのpackage依存を追加しない。

実装、独立レビュー、検証と既知の環境制約は [DE-02の検証記録](../../validation/chat-control/DE-02.md)を参照。追加した生成・snapshot・installer回帰は成功し、PowerShell実行制限と古いnative fixtureによる既存の失敗は成功扱いにしていない。ビルド完了は呼出元が確認し、`recordBuildCompletion` で固定した出力を同期的にcopy・照合する。DE-02完了時点ではDE-03以降は未着手。

同日の追確認では、OSのポリシーを変更せず通常経路でnative／fixtureを再生成でき、DE-02を対象とした `npm run verify` が274件すべて成功した。初回の環境要因による失敗は解消済み。実機UI等の留保や、検証中に追加された別作業・DE-03以降の完了には読み替えない。

### DE-03: 専用環境の再利用と安全な終了・復元

**Files:** Modify `src/development.ts`, `test/live/cc02-prepare.ts`, `test/live/cc02-session.ts`, `test/live/cc02-restore.ts`, `test/development.test.ts`, `test/install.test.ts`。通常受入用の既存動作はデフォルトで維持する。

**Interfaces:** envRootのlease、runのphaseと所有receiptを使う。既存runのstop/status・installerの復元処理に委譲する。実機試験用DBとアプリの実データを混同しない。

- [x] `environment_reuse_preserves_auth_and_profile`：同環境で2runを順にprepare→start→stop→restoreしても、authHomeとprofileの利用者設定を保持し、二度目のprepareがsandbox setupを呼ばないことを確認する。
- [x] `concurrent_environment_use_is_rejected`：同envRootまたは同auth設定への二重操作を拒否し、他runのMCP entry・DB・VS Codeウィンドウを変更しないことを確認する。
- [x] `restore_preserves_later_user_edits`：試験中に変更された設定は残し、未解放leaseやunknown停止のまま同領域を再利用しないことを確認する。
- [x] 毎回のcleanupで固定環境全体を解体しない開発用経路を追加する。旧runnerの `--window-closed` 条件を単に削除せず、必要な対象の終了確認を先に実装する。未知の配送・PID再利用・切断を既存のidentity検査へ戻す。
- [x] `npm run build`、`node --test dist/test/development.test.js dist/test/install.test.js dist/test/control.test.js dist/test/broker.test.js` のred/greenと、例外・部分成功後のlease／receipt確認後にcommitする。

実装・レビュー・検証結果と実機未確認の範囲は [DE-03の検証記録](../../validation/chat-control/DE-03.md)を参照。共有lease、停止・復元の冪等化、未記録の部分installの再利用拒否を確認した。DE-03完了時点ではDE-04以降は未着手。

### DE-04: 変更範囲に応じた反映と開発用CLI

**Files:** Create `test/live/development.ts`; Modify `src/development.ts`, `package.json`, `test/development.test.ts`; Reuse `test/live/acceptance.ts`, `test/live/cc02-session.ts`。自動ビルドが必要なら既存tscを利用する。

**Interfaces:** `selectRefresh` と3節の開発CLIを実装する。`inspect`は読取り、`prepare`は成果物生成、`start/stop/refresh/restore`は対象限定の状態更新として区別する。

- [x] `logic_refresh_runs_tests_without_vscode`：logicではVS Code起動・sandbox setup・モデルturnが0回で、選んだ関連テストを実行することを確認する。
- [x] `extension_refresh_stops_owned_run_before_reload_when_required`：拡張再読込みがleaseを失う場合に先にrunを終了し、reloadで旧runが勝手に復活しないことを確認する。
- [x] `runtime_refresh_uses_new_snapshot_after_confirmed_stop`：runtime/launchでは旧所有プロセスの終了確認後に新snapshotを使い、停止unknownなら起動しないことを確認する。
- [x] CLIで新snapshotを指定しても新しい公式Codex版の互換性確認を省略しない。型・設定・DBの互換性がなければfresh runへ移行し、古いDBを無理に再利用しない。watchはビルド専用で、自動live再起動や自動モデル送信を連動させない。
- [x] `npm run build`、`node --test dist/test/development.test.js` でred/greenを確認し、既存npm scriptを壊さない最小の入口を追加してcommitする。ウィンドウ再読込み等の実機操作はエージェントが正規API／CLI／UIツールで行う。

実装・独立レビュー・検証結果は [DE-04の検証記録](../../validation/chat-control/DE-04.md)を参照。統合CLIと変更種別の選択、停止確認後の新snapshot／新runへの切替をfixtureで確認した。拡張hostもleaseを失うため停止・復元後に開き直す。DE-04完了時点では実VS Code／Codex／UAC等の観測は未実施で、DE-05以降は未着手。

### DE-05: 有限のsandbox適合確認と開発サイクル実測

**Files:** Modify `test/live/development.ts`, `test/development.test.ts`; Create `docs/validation/chat-control/development-environment-first.md`。必要なsandbox probeはMC-02の対象版と既存の公式経路を使用する。

**Interfaces:** 静的診断から明示的に分けたsandbox probeと、2回の開発サイクルの観測結果を記録する。変更したWindows設定は存在する場合だけ対象と復元を記録する。

- [x] `sandbox_probe_is_explicit_bounded_and_never_weakens_policy`：未指定ではprobeを実行せず、明示時も1回の起動と有限timeoutで終了する。elevated失敗時に無断でunelevated/Full Accessへfallbackしない。
- [x] MC-02で使った環境のログと設定を根拠に、UAC反復の条件を確認する。初期設定干渉が未確認なら仮説のまま残す。UACを自動承認したように報告しない。
- [x] MXCが候補の場合、対象版・OS・組織設定の確認後、1回の明示probeで起動、管理領域deny、所有プロセスの停止を観測する。未対応なら理由を残して既存方式を維持する。実機で対応しないこと自体を先行改善全体の失敗にしない。
- [x] 同じ固定環境で2回のprepare→起動→限定確認→停止→復元を行い、setup呼出し、実際に観測したUAC、人へ依頼した操作、window再起動、所要時間を記録する。観測手段がない項目は `unconfirmed` とし、数字を推定で埋めない。
- [x] モデルturnを伴わない操作を優先し、必要な実機turnだけ有限枠を指定する。結果はfixture／実Codex／実UI／OS隔離で分けて記録し、秘密を含めず自己レビューしてcommitする。

実装・実機2サイクル・MXCの独立観測・初回unknownと承認済み回復は [DE-05検証記録](../../validation/chat-control/development-environment-first.md)を参照。MC-02が別PCだったため、今回の明示指示に従って現在PCで専用環境を新規準備した。通常CLIのwindow表示の留保と、公式GUI起動による確認範囲を区別する。DE-05完了時点ではDE-06は未着手。

### DE-06: 回帰確認と後続工程への引継ぎ

**Files:** Create `docs/development-environment.ja.md`; Modify `docs/chat-control-reference.ja.md` の開発手順、必要な `package.json` の入口説明; Test `test/development.test.ts`, `test/install.test.ts`, `test/package.test.mjs`。元計画の合意仕様・進行記録は無断で書き換えない。

**Interfaces:** 反復開発の入口、対象選択、正常終了・異常終了・本人限定同意の扱い、クリーン受入との差、MC-11で残すv0.2.0対応を文書化する。

- [x] `npm run verify` を実行する。既存の失敗は着手時baselineと比較し、新しい原因と混同しない。共有のMC-02差分や進行中のrunを壊すbuildを行わず、必要なら隔離した出力で検証する。
- [x] 正常経路に加え、停止unknown、設定の同時編集、二重CLI、別版exe、snapshot破損、開発host切断、復元の再実行を確認する。修正後は影響する検証だけを再実行する。
- [x] 通常テストではモデル・実VS Code・外部Gitへ接続しない。実機未実施は理由と対象を残し、完了範囲を限定する。
- [x] API／CLI／UIで実行できる準備・停止・復元を人へ渡していないかレビューする。人に依頼した場合は試した経路・制約・出典を記録する。
- [x] 元計画MC-03へ渡す環境manifest、使用snapshot、対応表参照、有限試験枠の指定方法、残る未確認事項を記録する。MC-11は共通診断・生成基盤を再利用し、新しい権限・計画・リリース用設定対応だけを後半で仕上げる。
- [x] 文書・参照先・差分・README更新要否を確認し、今回の差分だけをcommit/pushする。通常環境への導入・公開・常駐化は行わない。

DE-06の回帰結果・異常経路の対応・manifest／snapshot参照・MC-03への引継ぎは [DE-06検証記録](../../validation/chat-control/DE-06.md)を参照。並行作業と出力を分けた `npm run verify` は300/300成功。README日英と開発・運用手順を更新した。元MC計画や並行MC-02差分は今回のcommit対象に含めない。

## 5. 完了条件と期待する効果

DE-06で9項目を確認した。各項目の根拠と限定は [DE-06の項目5判定](../../validation/chat-control/DE-06.md#項目5の判定)を参照。クリーン受入は既存の独立した実行入口と開発経路との分離を確認した範囲で、DE-06での新規クリーン実機受入は `not_run`。UAC回数・公式内部setup回数は `unconfirmed` のまま保持する。

- [x] MC-02の結果をそのまま引継ぎ、未確認UI・権限機能を成功扱いにせず、先行環境整備を開始できる。
- [x] 選定済み実行ファイルと既存認証を使い、パス・hash・run用設定を手書きし直さず生成できる。
- [x] 専用profileとauthHomeを再利用し、runのidentity・DB・許可・予算を流用しない。
- [x] 同じ環境を2回使って、2回目のprepareだけで認証／sandbox setupを繰り返さない。
- [x] ロジック修正の通常テストでVS Codeを開かず、拡張・runtime・起動契約の変更だけ必要な再読込み・再起動を選べる。
- [x] 稼働中snapshotの上書き、終了未確認での切替、別runの停止、利用者設定の巻戻しがない。
- [x] UACが必要な場合は本人同意に残し、反復原因と改善可能な範囲を記録する。UAC回数0や完全ホットリロードを保証しない。
- [x] 開発用環境の再利用と、クリーンな最終受入の両方を実行できる。
- [x] 起動・停止・確認・復元は可能な限りエージェントが担当し、人の手作業が必要な例外には根拠がある。

期待する効果は、機能変更に伴って必要なプロセス再起動をなくすことではなく、再起動のたびの初期準備・環境作成・設定編集・後片付けを減らすことである。改善量はDE-05の観測で示し、所要時間やUAC回数の削減を未測定のまま保証しない。

## 6. 参考資料と本書の検証

- [元計画と自律実行方針](2026-11-17-worker-coordination-evolution.md)
- [MC-02対応表](../../validation/chat-control/worker-coordination-compatibility.md)
- [現行の導入・停止・復元手順](../../chat-control-reference.ja.md)
- [CodexのWindows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)：MXCとlegacy elevatedの前提、組織制限。
- [MicrosoftのUAC説明](https://learn.microsoft.com/windows/security/application-security/application-control/user-account-control/how-it-works)：暗転するsecure desktopと本人同意。
- [VS Code拡張の開発](https://code.visualstudio.com/api/get-started/your-first-extension#developing-the-extension)：開発hostの再読込み。

本書作成時は文書・参照先・コマンド・差分の確認だけを行い、進行中のMC-02試験、sandbox、VS Code、MCP、設定、コードに変更を加えない。実装時の各工程は検証結果、未確認事項、変更ファイル、README更新、branch・commit・push結果を記録する。
