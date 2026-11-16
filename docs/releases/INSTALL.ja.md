# Meristem v0.1.0 — Windows x64 配布版

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

補助拡張VSIXを、公式VS Code CLIから試験用の `--user-data-dir` と `--extensions-dir` を指定してインストールします。VSIXだけでは本体の代わりにはなりません。

実行対象と正式認証を確認し、[導入リファレンス](https://github.com/takikomirice/meristem/blob/v0.1.0/docs/chat-control-reference.ja.md)に沿って `install-request.json` と `control.json` を準備します。`implementationRoot` はこの展開先、Nodeは `node/node.exe`、本体は `dist/src/`、native hostは `.local/chat-control-build/` にあります。この `.local` に入っているのは配布用の3実行ファイルだけで、開発者の管理状態ではありません。

```powershell
$meristemNode = (Resolve-Path -LiteralPath '.\node\node.exe').Path
powershell.exe -NoProfile -File '.\scripts\install.ps1' -NodeExe $meristemNode -ConfigPath '<準備したinstall-request.jsonの絶対パス>'
```

導入だけでワーカーは起動しません。指定した専用環境を開き、人が実行対象を確認してRunPermitを許可します。質問・承認・停止・復旧の操作は[運用スキル](https://github.com/takikomirice/meristem/blob/v0.1.0/skills/codex-chat-coordination/SKILL.md)を参照してください。未対応要求を自動許可したり、APIキー課金へ切り替えたりはしません。

## 停止と復元

ワーカーのターミナルは読取専用です。通常のコーディネーター停止または `stop_run` で管理対象全体を停止できます。再読込み・再起動後に自動再開しません。状態照合と人の再確認が必要です。

全体停止と専用ウィンドウ終了を確認した後、同梱Nodeを指定して `scripts/uninstall.ps1` を実行し、導入時の `installation.json` を渡します。後から利用者が変更した設定値、Git成果、未コミット変更、状態DBは保持します。

## ライセンスと検証範囲

独自部分は [MIT License](../../LICENSE)、依存ライブラリは [Third-party notices](../../THIRD_PARTY_NOTICES.md)、同梱Node.jsのライセンス全文はZIP内の `node/LICENSE.txt` を参照してください。

ZIPの内容・ライセンス・ハッシュと、展開先の同梱Nodeによる本体の読込みを検査しています。新しいPCでの実モデル受入、通常プロファイルでの常用、任意のCodex版への互換性を保証するものではありません。[機能と制約](https://github.com/takikomirice/meristem/blob/v0.1.0/README.md)も確認してください。
