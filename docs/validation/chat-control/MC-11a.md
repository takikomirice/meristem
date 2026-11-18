# MC-11a: 導入前の読取り専用診断

2026-11-18（日本時間）。着手時HEADは `2e3ba12`、専用branchは `feat/mc-11a-install-diagnostics`。対象は[計画のMC-11a](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md)で、[DE-06の引継ぎ](DE-06.md)を参照した。MC-11全体の完了やMC-11bの設定生成の受入は意味しない。

## 実装と判断

- `src/install.ts` に `InstallationSpec` と `EnvironmentReport`、読取り専用の `inspectEnvironment` を追加した。既存schemaから型を公開し、従来の `InstallSpec`、install／uninstall、receipt、設定形式は維持した。
- DEの `inspectEnvironment` を再利用し、Codex／Node／VS Code／公式拡張のパス・版・hashと、blocker／warningを返す。入力の不足・不正パス・hash不一致を成功へ読み替えず、取得できないtool情報は `null` にする。
- **判断:** 既存のinstaller schemaにはVS Code・公式拡張の選定や、hashに結び付いた版metadataがない。第1引数の `Partial<InstallationSpec>` を維持し、第2引数で既存のDE `EnvironmentInput` を明示できるようにした。schemaや生成形式は拡張せず、入力のない項目はblockerとして報告する。利用者は完全な診断にDE入力を渡す必要がある。
- **判断:** DEの `implementationRoot` はcheckout、installerの同名項目はsnapshotを指し得る。DE入力のrootを維持して既存の配置診断へ渡す。現在PCで見つけた正規snapshotの重複誤判定を回帰テストで修正した。snapshot／receiptの完全な検証は既存installerの責任であり、静的診断で代替しない。
- 通常profileや認証を探索・複製せず、実行ファイルの `--version`、モデル、sandbox setup、VS Code、ログインを起動しない。認証はファイルの存在、sandboxは設定値の静的確認に限り、実際の有効性・OS隔離・所有者・終了・復元は未確認と明示する。
- 日英の導入案内にソース版の診断入口、既存DE基盤の再利用、公式導入案内へのリンク、本人入力・正式同意と通常操作の区別を追記した。公開済みv0.1.0 ZIPへの追加と混同しない。

MC-11bの `prepareInstallation`、版2・権限・上限設定の生成、install／uninstallスクリプト、配布受入は実装していない。既存の `prepareEnvironment`／`snapshotBuild`／`prepareRun` とreceiptを再利用する方針を引き継ぐ。

## 検証

着手時のnative・本体・拡張ビルドと既存installer 10/10が成功。新しい診断4件はAPI未実装でRED、その後GREENを確認した。現在PCで判明したsnapshot配置の誤判定も、`environment_overlap` のREDを確認して修正した。

独立レビューはImportant 1件。Windows PowerShell 5.1で案内の `-e` 引数内の引用符が失われる問題を実行で再現した。両言語の掲載コマンドを実行する回帰テストでRED→GREENを確認して修正した。その他のCritical／Important／Minorは指摘なし。版2生成と実権限・実機停止の確認を対象外にする判断は、MC-11a／11bの境界と静的診断の契約に従う。

修正後の固定したコードでは次を実行した。

| 検証 | 結果 |
|---|---|
| `npm.cmd run typecheck` | 本体・拡張とも成功 |
| `npm.cmd run build` | 本体・拡張とも成功 |
| `node --test dist/test/install.test.js` | 16/16成功。診断6件、既存導入・復元10件を含む |
| `npm.cmd test` | 42件中41成功。`malformed_or_disconnected_display_client_does_not_stop_worker` が表示socketの切断待ち3秒でtimeout |
| 上記の失敗1件だけ同条件で再実行 | 1/1成功。nativeコード・timeoutは変更せず、初回の失敗は成功へ読み替えない。原因は未確定 |
| `npm.cmd run test:terminal` | 15/15成功 |
| `git diff --check` と文書のローカル参照 | 成功 |

追加で実行した `npm.cmd run verify` は終了コード1。native・型・buildと通常42/42は成功し、制御326件中325成功・1失敗・取消0だった。失敗は修正前に追加してコンパイルした `install_diagnostics_accept_snapshot_inside_dedicated_environment` の `environment_overlap` で、上の修正後installer 16/16に同じ試験を含めて成功している。端末試験には到達しなかったため、修正後に上記15/15を別実行した。

この追加回帰は修正途中の探索実行で、最終固定コードでの `verify` 全体成功へ読み替えない。MC-11a指定の型・build・installerを固定コードで確認し、変更の影響する診断・snapshot・導入・復元・掲載コマンドを再検証した。MC-12の固定commitによる全体受入は今回の範囲外である。

現在PCでは、DE-05で明示した環境manifestと既存runのinstaller Specを参照して読取り診断した。正規snapshotの誤判定を直した後はblocker 0。Codex `0.169.0-alpha.11.1`、Node `v24.22.1`、VS Code `1.146.0`、公式拡張 `26.1111.21308` の版metadataと各hashを確認した。PATH別実体、認証ファイルの存在、設定上のelevated、run状態未確認、installer検証待ちをwarningに残した。参照したsettings／Codex config／control config／DE入力・参照／sessionのhashは診断前後で一致し、実行ファイルprobe・setup・モデル送信は0。個人のパスや認証本文は本記録に含めない。

## 留保と引継ぎ

実モデル・実UI・sandbox probe・OS隔離・新しいrunの起動／停止／復元・通常profileへの導入・公開配布は `not_run`。この工程は診断の追加であり、過去のDE-05実機結果を再実行したとは扱わない。正式認証の有効性やsandboxの適合、PIDだけからの終了確認は成功と報告しない。

通常設定、通常CODEX_HOME、PATH、registry、OSポリシー、既存run、snapshot、ログ、成果物は変更しない。人へ依頼した操作は0件。新しい依存・永続化形式・権限設定の変更はない。READMEの利用説明は変わらないため更新せず、日英の専用導入案内を更新した。作業ログは専用worktree内のGit管理外 `.local/mc-11a/` に保持する。Gitのcommit／push結果は完了報告を参照する。
