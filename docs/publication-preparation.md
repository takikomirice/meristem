# 公開準備の記録

2026年11月16日。日本語の概要は [README](../README.md)、英語の概要は [English README](../README.en.md) を参照してください。

本書の「準備時点」は公開前の確認記録です。v0.1.0の公開手順では、承認済みのmain統合・1コミット化・noreplyメールへの変更・タグとReleaseの作成・作業ブランチ削除・公開設定への切替を続けて実施します。対象と検証項目は[公開計画](superpowers/plans/2026-11-16-v0.1.0-public-release.md)、配布物の説明は[Releaseノート](releases/v0.1.0.md)を参照してください。

## ライセンスと配布物

- 独自のコードとドキュメントに [MIT License](../LICENSE) を適用した。著作権者名は公開用のアカウント名を使用し、メールアドレスはライセンスへ記載しない。
- ルート、補助拡張、試験用拡張のpackage metadataとlockfileのルート表記をMITへ揃えた。npmの依存バージョンとintegrityは変更しない。
- [第三者ライセンスの案内](../THIRD_PARTY_NOTICES.md)に、直接依存・開発用依存の版、ライセンス、元のライセンスファイルの場所を記載した。第三者のコードや外部ツールをMITへ変更するものではない。
- ローカルVSIXへMIT全文と第三者ライセンスの案内を含め、manifestのLicense情報と対応するassetを設定した。配布対象は従来の補助拡張に限定し、認証・実行管理・sandbox・モデル選択は変更しない。

MIT本文は [SPDXの標準文面](https://spdx.org/licenses/MIT.html)、VSIXのLicense assetは [公式vsce実装](https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts)を確認した。

## 公開対象から除いた内容

| 対象 | 処理 |
|---|---|
| `debug.log` | Gitの追跡対象から外し、ignoreへ追加。利用者のローカルファイルは削除しない。 |
| 検証JSON 10ファイル | 個人のユーザーディレクトリ、ローカルの作業場所、非公開試験リポジトリの識別子を必要な箇所だけ置換。`publicationRedactions`で処理の種類を明記。 |
| 検証Markdown 2ファイル | 上記と同じ情報を置換し、非公開試験repoへのリンクを除去。公開用の写しであることを冒頭に明記。 |
| ローカル環境ファイルと配布物 | 既存の`.local`、`node_modules`、ビルド出力の除外を維持し、`.env`、`.env.*`、`*.vsix`をignoreへ追加。`.env.example`は追跡可能にする。 |

処理した検証ファイルは `docs/validation/chat-control/` 以下の次の12件。

- `CC-00.transport.evidence.json`
- `CC-00.ui.evidence.json`
- `CC-00R.live-suite.evidence.json`
- `CC-01.evidence.json`
- `CC-02.acceptance.evidence.json`
- `CC-02.preflight.evidence.json`
- `CC-02.review.preflight.evidence.json`
- `CC-03.acceptance.evidence.json`
- `CC-07.continuation.evidence.json`
- `CC-07-continuation.md`
- `evidence/inventory.json`
- `report.md`

置換前の12ファイルとローカルログは、Git管理外の`.local/publication-prep/`へSHA-256付きで退避した。公開版のパスは再現用のplaceholderであり、観測した実パスではない。試験結果、失敗・未確認の判定、時刻、版、artifact hash、モデル送信回数は変更していない。既存の検証記録を今回の新しい実機成功として扱わない。

## 確認範囲と履歴

準備前の `d10c3fa` を基準に、追跡ファイル171件と到達可能な履歴21コミット・447個のファイル内容を確認した。秘密鍵、GitHub/OpenAI/Google/Slackの既知のキー形式、AWS access key形式を照合し、該当する実資格情報は検出しなかった。`authorization`という項目にある人の承認の説明や、テスト用の固定値は資格情報とは区別した。この確認はあらゆる秘密情報の不在や、プログラム全体のセキュリティ監査を保証するものではない。

今回の削除・伏せ字処理は最新ツリーに対する変更である。過去コミットには以前のログとローカルパスが残り、コミット作者のメールアドレスもGit metadataに残る。履歴書換え、force-push、作者情報の変更は行わない。スカッシュマージだけでは、既にmainにある過去コミットや元の作業ブランチの履歴は消えない。過去の到達可能な履歴ごと非公開情報を消す場合は、公開前に履歴の扱いを別途決める必要がある。

## GitHubの表示設定

リポジトリの説明を次の内容に設定し、GitHub APIで再取得して確認した。

> Experimental Windows tool coordinating independent Codex CLI chats from VS Code, with Git worktrees, verified integration, and stop controls.

トピックに `codex`、`vscode-extension`、`mcp`、`coding-agents`、`git-worktree`、`windows`、`typescript`、`experimental` の8件を設定した。AboutのWebサイト欄は、整備した作業ブランチの日本語READMEへ案内する。mainへの反映後はリンク先もmainへ揃える。

既定ブランチの`main`には、この準備時点でREADMEもLICENSEもない。GitHubトップのREADMEとライセンス自動表示には、実装ブランチ全体の`main`への反映が必要である。今回の操作では既定ブランチ・公開範囲・アクセス権を変更せず、GitHub PagesやMarketplaceへの公開も行わない。

## 検証

配布テストは、ライセンスがない従来VSIXで失敗することを確認してから実装した。更新後は実際のZIP内のMIT本文・第三者ライセンス案内・manifest・content typeを検査し、許可したファイル以外が含まれないこと、既存VSIXを再実行で上書きしないことを確認する。

通常の必須検証は `npm run verify`。実モデルや外部GitHubへの試験実行は含まない。公開用の検証記録については、元ファイルとの比較で数値・真偽値・結果・時刻・hashの保持を確認した。公開対象174ファイル、JSON 52件、依存パッケージ100件のlicense metadataと元ライセンスファイル、依存バージョンの保持、ignore規則も検査した。変更したMarkdown文書内のローカルリンク86件の参照先も確認した。

最終の `npm run verify` はexit 0。native/spike/package 40件、control 181件、terminal 14件の全235件、ルートと補助拡張の型検査・buildが成功した。自己レビューで配布用案内文からソースツリー専用の相対リンクを外し、文書変更後に `node --test test/package.test.mjs` も再実行して成功した。

制限環境ではPowerShellスクリプトが実行ポリシーで拒否されたため、ポリシーを変更せず通常のホスト環境で配布テストを実行した。
