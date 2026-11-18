# MC-11b 専用環境の設定生成・導入・復元

2026-11-18（日本時間）。[工程表のMC-11](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md) の後半を、MC-07／08／11aを取り込み済みの `0bf3d75` から専用worktreeで実施した。

## 実装と確認範囲

- 準備用JSONで親thread、版2工程表、repo、Gitブランチ範囲、コーディネーターのモデルと推論強度、専用パスを明示する。既存DE診断の選定済みパスとhashを再照合し、新しい `control.json` と導入用JSONを生成する。
- MC-07の `workspace` 権限検査を再利用する。書込み上限は工程表の `worktrees_root`、既定reviewerは `user`。検証済みの `auto_review` は明示指定できる。既定の親再開・修正回数は無制限。正整数の指定と、DEの有限の試験予算も維持する。
- 導入前に工程表と生成設定のhash、専用設定と親作業ディレクトリの束縛、repo／worktreesのパスを再照合する。Codexのhashが違う場合は互換性の再検証へ誘導する。生成と導入ではワーカーを起動せず、人が既存のRunPermitを確認する。
- 既存installerと版1のreceiptを使う。復元は利用者による後の設定変更、認証データ、Git成果、状態ファイル、生成ファイルを保持する。開発snapshotの生成と配布用の生成はcontrol設定の組み立てを共有する。
- 展開した検証用ZIPの同梱Nodeで `prepare`、`install`、`uninstall` を実行するテストを追加した。Windows PowerShell 5.1で日本語を含むパスと、導入用JSONを保存する手順も対象にした。

## 検証

| コマンド | 結果 |
|---|---|
| `npm run build`、`npm run typecheck` | 成功 |
| `node --test dist/test/install.test.js` | 17/17。専用環境・親thread・Git範囲、Codex更新、導入先の差替え拒否、利用者設定の保持、版1 snapshotを確認 |
| `node --test test/package.test.mjs` | 3/3。展開したZIPの同梱Nodeから、準備用JSONを読み、PowerShellで導入用JSONを保存し、設定を適用してreceiptから復元 |
| `npm run verify` | 終了コード0。nativeビルド・型検査・本体と拡張のビルド、および通常42/42・制御347/347・端末25/25の計414件が成功 |
| `git diff --check`、日英の準備用JSON例の読み込み | 成功 |

着手時に開始した全体検証とRED用の再ビルドが同じworktreeで重なり、追加テストが旧コードを読み込んで失敗し、snapshot試験でも `build changed since completion` を検出した。この初回の全体実行は参考結果とし、再ビルドを並行させず、固定した実装で全体検証をやり直した。

## 自己レビューと判断

独立レビューの指摘3件を修正した。通常の `CODEX_HOME` が既定外のパスを使う場合も保護し、専用認証領域を実装・repo・worktreesから分離した。導入先の再指定と、準備後のジャンクションへの差替えは導入時の照合で拒否する。レビュー指摘に対応する回帰テストを追加し、修正前は通常の `CODEX_HOME` に相当するパスを受理して失敗することを確認した。

生成を導入とは別の操作にし、導入用JSONに生成設定のhashを含めた。準備から導入まで工程表のファイルhashを固定し、導入後は既存の人による工程表改訂手順を使う。準備・導入時は実行元シェルの `CODEX_HOME` も保護対象とし、専用 `CODEX_HOME` を付与した環境での起動は導入後に行う。新しい依存やDB形式は追加していない。

根のREADMEは既存の概要を維持し、[日本語導入案内](../../releases/INSTALL.ja.md) と [英語導入案内](../../releases/INSTALL.en.md) を更新した。配布ZIP内ではこの2文書がREADMEになる。

作業ブランチは `feat/mc-11b-install-generation`。全体検証ログは専用worktreeのGit管理外 `.local/mc-11b-verify.log` に保持する。コミットとpushの結果は完了報告に記載する。

実モデル、実VS Code UI、追加のOS隔離検証、公開は `not_run`。導入・復元は専用fixtureを対象とし、MC-12の統合受入は別工程とする。
