# Meristem v0.2.0 — Windows x64 配布版

**日本語** | [English](INSTALL.en.md)

VS Codeの親チャット（コーディネーター）から、独立した子チャット（ワーカー）へ作業を割り当てる実験的な開発者向けツールです。以降は「コーディネーター」「ワーカー」と表記します。ワーカーは内部サブエージェントとは別のCodex CLIチャットです。

## 内容と必要環境

このZIPには、ビルド済みの本体・Windows用実行ファイル・補助拡張VSIX・Node.js・依存ライブラリと各ライセンスを含めています。利用するだけなら、Node.jsの別途導入、`npm ci`、TypeScriptやC#のコンパイルは不要です。

別途必要なのはWindows x64、Git、VS Code 1.90以上と公式Codex拡張、.NET Framework実行環境、スクリプト実行が許可されたPowerShellです。実モデルの利用には、正式なChatGPTログイン済みの専用Codex homeが必要です。Codex・VS Code・Git、認証情報や個人の設定は同梱していません。

これは設定済みのワンクリックインストーラーではありません。専用プロファイルと、そのPCの実行ファイル・親thread・工程表・Git範囲を結び付ける設定を準備して使います。対応を実証したCodexは `0.169.0-alpha.11.1`、同梱Node.jsはrelease manifestで確認できます。

## 展開と起動確認

1. Releaseの `SHA256SUMS.txt` とダウンロードしたZIPの `Get-FileHash -Algorithm SHA256` を照合します。
2. ZIPを新しいローカルフォルダーに展開し、`release-manifest.json`があるフォルダーでPowerShellを開きます。配置後に移動した場合は、絶対パスとhashを含む実行設定を作り直してください。
3. 次のコマンドで、同梱Nodeとライブラリを使って本体を読み込めます。モデル呼出しや設定変更は行いません。

```powershell
.\node\node.exe --input-type=module -e "await import('./dist/src/install.js'); console.log('Meristem runtime ready')"
```

## 専用プロファイルへの導入

### 現在のソース版での読取り専用診断（MC-11a）

この節のAPIはMC-11a以降を含むビルド向けです。公開済みv0.1.0のZIPでは「既存installerでの導入」の手順を使います。

`dist/src/install.js` の `inspectEnvironment(installationSpec, environmentInput?)` は、既存の専用開発環境の診断を再利用し、`{ tools, blockers, warnings }` を返します。`tools` はCodex・Node・VS Code・公式Codex拡張のパス、版、SHA-256を示し、確認できない値は `null` です。`InstallationSpec` は既存installer schemaから公開した型で、従来の `InstallSpec` も使えます。

`installationSpec` は既存の `install-request.json` の全部または一部です。公式拡張とVS Codeの選定、hashに対応する版の引継ぎには、DEで使う既存の `environmentInput` を第2引数で明示します。補助拡張を公式拡張と見なしたり、PATH・最新チャット・通常プロファイルから対象を補完したりしません。第2引数がなくても診断でき、足りない選定・確認項目をblockerとして返します。

ビルド済みのソース版で、明示した2ファイルを読み取る例です。配布物にNodeが同梱されている場合は、そのNodeを継続して使ってください。

```powershell
$meristemNode = '<選定済みNodeの絶対パス>'
& $meristemNode --input-type=module -e "import {readFileSync} from 'node:fs'; import {inspectEnvironment} from './dist/src/install.js'; const read = p => JSON.parse(readFileSync(p,'utf8')); console.log(JSON.stringify(inspectEnvironment(read(process.argv[1]),read(process.argv[2])),null,2));" '<install-request.jsonの絶対パス>' '<DE input.jsonの絶対パス>'
```

診断では `--version`、モデル、sandbox setup、ログインを起動しません。CodexとVS Codeの版は選定済みhashに結び付く引継ぎ情報、実行中Nodeの版は `process.version` です。認証は `auth.json` の存在だけ、sandboxは専用CODEX_HOMEの `config.toml` の設定だけを確認します。有効なログイン、sandboxのOS対応・実際の隔離、プロセス終了や復元の成功は、この結果だけでは確認できません。`warnings` にはその区別も表示します。

hash不一致は互換性の再検証が必要です。発見したhashへの自動差替え、認証ファイルのコピー、通常settings／通常CODEX_HOME／PATH／registry／OSポリシーの変更は行いません。blockerがなくても導入可否は既存installerで、所有runの終了・復元は正規statusとreceiptで照合してください。既存のsnapshot・新run準備・停止・復元はDEの入口を再利用します。

不足するツールは [VS Codeの公式導入案内](https://code.visualstudio.com/docs/setup/windows)、[Git for Windowsの公式配布](https://git-scm.com/install/win)、[Codexの公式Windows案内](https://developers.openai.com/codex/windows)から準備します。承認済み範囲の準備・起動・診断・終了確認・復元はエージェントが進め、本人限定の認証入力や正式同意、新たな重大な影響の判断が必要な場合だけ利用者に依頼します。管理者権限・ネットワーク・組織ポリシーの制限は回避しません。

### 版2の専用設定を生成する（MC-11b）

MC-11bを含むビルドまたはZIPで利用できます。公開済みv0.1.0は、下の「既存installerでの導入」の手順を使います。

専用VS Codeのユーザーデータ・拡張ディレクトリと専用 `CODEX_HOME` を選びます。専用VS Codeの `User/settings.json` と専用 `CODEX_HOME/config.toml` は事前に作成してください。準備と導入は、専用 `CODEX_HOME` を環境変数に設定する前に実行します。installerは実行元シェルの `CODEX_HOME` も保護対象にします。公式Codex拡張と補助VSIXは、公式VS Code CLIで両専用ディレクトリを指定して導入します。実モデルを使う場合のログインやWindows sandboxの初期設定は公式の手順で行います。

準備用JSONの例です。各パスとIDを対象環境に合わせて置き換えます。`controlConfig` の親ディレクトリは既存の専用環境内に置き、`controlConfig`、`installDirectory`、`stateDirectory` には新しいパスを指定します。

```json
{
  "implementationRoot": "C:/meristem/build",
  "realExe": "C:/tools/codex.exe",
  "nodeExe": "C:/meristem/build/node/node.exe",
  "helperExtension": "C:/meristem/build/extension",
  "settings": "C:/meristem-dedicated/profile/User/settings.json",
  "codexConfig": "C:/meristem-auth/config.toml",
  "controlConfig": "C:/meristem-dedicated/control.json",
  "installDirectory": "C:/meristem-dedicated/installation",
  "parentCwd": "C:/work/repository",
  "prepare": {
    "environmentRoot": "C:/meristem-dedicated",
    "stateDirectory": "C:/meristem-dedicated/state",
    "parentThreadId": "REPLACE_WITH_VERIFIED_PARENT_THREAD_ID",
    "planPath": "C:/work/repository/plan.md",
    "repositoryPath": "C:/work/repository",
    "repositoryId": "repository",
    "branchScope": ["meristem-integration"],
    "coordinator": { "model": "REPLACE_WITH_VERIFIED_MODEL_ID", "effort": "medium" }
  }
}
```

- `planPath` は `schema_version: 2` の工程表を指定します。工程表のrepoと統合ブランチは `repositoryPath` と `branchScope` に一致させます。導入時に工程表、生成設定、準備時に選んだ導入先を照合します。導入後の工程表改訂には既存の合意手順を使います。
- `prepare.permissionPermit` は既定で `workspace`、工程表の `worktrees_root`、`user` です。選定済みの環境で `auto_review` を使う場合は、`allowedProfileIds: ["workspace"]`、`writableRoots: ["<worktrees_rootの絶対パス>"]`、`allowedReviewers: ["auto_review"]` を明示します。各ワーカーへの書込みは割り当てたworktreeに絞られます。
- `prepare.executionLimits` の `maxWakeTurns` と `maxCorrectionsPerTask` には正整数または `null` を指定できます。省略と `null` は無制限です。工程表の `run.execution_limits` に有限上限があれば、実行時に両方の有限上限のうち厳しい方を適用します。開発runnerの有限の試験予算は従来どおりです。
- 選定用JSONには `codeExe`、`extensionDirectory`（公式拡張のフォルダー）、`selectedTools` を入れます。`selectedTools` の `codex`、`node`、`code` それぞれに照合済みの `sha256` と `version` を指定します。Codex更新時は対象版の互換性を再検証してから選定を更新します。

同梱NodeはZIP内の `node/node.exe` が選ばれます。ソースから使う場合は、各スクリプトに `-NodeExe` で選定済みNodeの絶対パスを渡します。

```powershell
$preparePath = '<準備用JSONの絶対パス>'
$selectionPath = '<選定用JSONの絶対パス>'
$installPath = '<新しい導入用JSONの絶対パス>'
if (Test-Path -LiteralPath $installPath) { throw 'Select a new installation request file' }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$prepared = & '.\scripts\install.ps1' -Prepare -ConfigPath $preparePath -EnvironmentPath $selectionPath
if ($LASTEXITCODE -ne 0) { throw 'Configuration preparation failed' }
$prepared | Set-Content -LiteralPath $installPath -Encoding UTF8
& '.\scripts\install.ps1' -ConfigPath $installPath
```

準備では指定先に `control.json` を排他的に作り、導入用JSONを標準出力へ返します。Nodeからは `prepareInstallation(input, inspectEnvironment(input, selection))` で同じ処理を呼べます。続く導入は専用settingsとMCP設定に構成を適用し、`installation.json` のパスを返します。ワーカーを動かすには、専用環境を開いて人がRunPermitを確認します。

### 既存installerでの導入

補助拡張VSIXを、公式VS Code CLIから試験用の `--user-data-dir` と `--extensions-dir` を指定してインストールします。VSIXだけでは本体の代わりにはなりません。

実行対象と正式認証を確認し、[導入リファレンス](https://github.com/takikomirice/meristem/blob/v0.2.0/docs/chat-control-reference.ja.md)に沿って `install-request.json` と `control.json` を準備します。`implementationRoot` はこの展開先、Nodeは `node/node.exe`、本体は `dist/src/`、native hostは `.local/chat-control-build/` にあります。この `.local` に入っているのは配布用の3実行ファイルだけで、開発者の管理状態ではありません。

```powershell
$meristemNode = (Resolve-Path -LiteralPath '.\node\node.exe').Path
powershell.exe -NoProfile -File '.\scripts\install.ps1' -NodeExe $meristemNode -ConfigPath '<準備したinstall-request.jsonの絶対パス>'
```

導入だけでワーカーは起動しません。指定した専用環境を開き、人が実行対象を確認してRunPermitを許可します。質問・承認・停止・復旧の操作は[運用スキル](https://github.com/takikomirice/meristem/blob/v0.2.0/skills/codex-chat-coordination/SKILL.md)を参照してください。未対応要求を自動許可したり、APIキー課金へ切り替えたりはしません。

## 停止と復元

ワーカーのターミナルは読取専用です。通常のコーディネーター停止または `stop_run` で管理対象全体を停止できます。再読込み・再起動後に自動再開しません。状態照合と人の再確認が必要です。

全体停止と専用ウィンドウ終了を確認した後、導入時の `installation.json` を指定します。MC-11bを含むZIPでは次のコマンドで復元できます。公開済みv0.1.0では `-ConfigPath` と同梱Nodeの `-NodeExe` を指定します。

```powershell
& '.\scripts\uninstall.ps1' -ReceiptPath '<installation.jsonの絶対パス>'
```

復元に使うのはreceiptに記録された設定値です。後から利用者が変更した設定値とMCPテーブル、Git成果、未コミット変更、状態DB、生成ファイルは保持します。結果の `retained` で利用者設定の保持を確認できます。

## ライセンスと検証範囲

独自部分は [MIT License](../../LICENSE)、依存ライブラリは [Third-party notices](../../THIRD_PARTY_NOTICES.md)、同梱Node.jsのライセンス全文はZIP内の `node/LICENSE.txt` を参照してください。

ZIPの内容・ライセンス・ハッシュと、展開先の同梱Nodeによる本体の読込みを検査しています。MC-11bでは同梱Nodeを使う設定生成・導入・復元も試験用プロファイルで検査します。新しいPCでの実モデル受入や選定外のCodex版は別途確認が必要です。[機能と制約](https://github.com/takikomirice/meristem/blob/v0.2.0/README.md)
