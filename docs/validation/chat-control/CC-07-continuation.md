# CC-07 残りの総合受入

> 公開用の写しです。個人のパスや非公開試験リポジトリの識別子を置き換えています。試験結果・版・ハッシュは変更していません。[処理の範囲](../../publication-preparation.md)を参照してください。

2026-11-16（日本時間）。plan revision 2、route `extension_parent_cli_workers`。

## 今回の範囲

[前回の記録](CC-07.md)と[実機証拠](CC-07.live.evidence.json)を保持し、同履歴修正、新担当への引継ぎ、質問応答、通常親UIの送信／停止／モデル選択、GitHub統合readbackを追加確認する。前回合格済みの並列統合、内部subagent、遅延報告、再読込みを今回の成功へコピーしない。

利用者は追加の実モデル試験を完了まで行うことと、新規の試験repo作成を承認した。各sessionの送信前予約・上限を維持し、結果不明の送信を再送しない。通常profileへの導入、公開配布、自動起動登録は対象外。

## 再現入口

`test/live/acceptance.ts prepare --scenario serial` は既存のローカルGit fixtureを再利用し、A→Bの直列工程表と `node checks.mjs A` / `node checks.mjs A B` を用意する。既定の並列シナリオは維持する。`--windows-sandbox` の明示値を準備runnerへ渡せるようにした。

今回のcheckoutには前回CC-06/07のローカルsessionがなかったため、復元済みCC-03 acceptance-12の明示パスを使用した。Codex `0.169.0-alpha.11.1` のSHA-256は保存値に一致。Node `24.22.1`、workerは `gpt-6.1-sol / medium`、MXC。補助拡張は新規VSIXを公式VS Code CLIで専用extensions領域へ導入した。

GitHubは利用者が作成を委任した非公開repo `<private-acceptance-repository>`。`cc07-seed`を作成した。子のGit操作は固定ローカルbare remoteで行い、統合結果のGitHub push/readbackを別に確認する。

## 初回試行 serial-01

親2ターン＋子1ターン。親の通常チャット、製品のRunPermit確認、子Aの専用ターミナルと起動を確認した。Aは `draft` を書き、`alpha` を要求するcheckの失敗まで進んだ。

試験指示がGit追加許可にworktreeディレクトリも含めてしまったため、子のpermissions要求は `unsupported` となった。対応するのは固定Gitパスであり、権限判定を緩めて通さなかった。製品CLIから停止し、`native_job_empty` / `native_creation_identity`、未コミットのa.txt保持を確認した。これは直列修正・報告の成功には数えない。

チャットタブだけの閉鎖では親App Serverが残り、cleanupは拒否した。その後、利用者が専用ウィンドウ全体を閉じ、親切断とuninstallの `restored` / `retained: []` を確認した。通常profile・認証情報・Git成果は削除しない。

修正試行では、既存の共通gitdir、linked-worktree gitdir、ローカルbare originだけを要求する手順に修正した。この境界を運用スキルのreferenceにも明記した。

## 自動検証

最初の `npm run verify` はインストール済み依存の `yaml` 不足で型検査に失敗した。lockfileを変更せず `npm ci --ignore-scripts` で復元後、全233件（native 39、control 180、terminal 14）、型検査、buildが成功した。

追加の直列シナリオは未実装exportによるREDを確認してから実装し、`node --test dist/test/acceptance.test.js` の2件が成功した。実Gitで誤った値をcheckが拒否し、修正後に成功し、A統合前にはBが解放されず、B確認時にもAの回帰を検出する。

## 直列試行 serial-02

新規RunPermit、通常親UIからの明示再開、新担当Aと同履歴Bの候補／統合受入、run完了まで確認した。途中の失敗は以下のとおり保持する。

serial-02の初回Aは意図したcheck失敗を正しく報告したが、通常のlocal pushもMSYS `sh.exe` の `NtCreateDirectoryObject` で失敗した。同履歴の修正attemptはalphaをcommitした後、同じpush失敗に対して未対応の広いcommand許可を要求したため停止した。このattemptを成功した修正とは数えない。

これは[CC-06](CC-06.md)に記録済みのMXC制約と一致した。後続は、その試験で使った[Git標準remote-ext](https://git-scm.com/docs/git-remote-ext)によるnative `receive-pack`へ統一した。固定した同じlocal bareと割当branchだけを対象に、`protocol.ext.allow=always`をそのコマンドに限定する。origin・ACL・sandbox・ネットワーク許可は変更しない。

利用者が通常の親入力欄から停止確認と `resume_run` を依頼し、追加子を起動せずrevision 8で再開した。その後の `handoff_new` は別thread・別worktreeのAを作成した。Aのcommit／check／push／報告／cleanupが成功し、remote readbackは `219493f97ddaf9ba193e774f6df9ba2275aef690` に一致した。

親の初回mergeはintegration gitdirへの書込み拒否で失敗した。候補だけが受入済みで依存は解放されなかった。通常親の正式なコマンド単位の実行承認経路で、固定SHAへの `merge --ff-only` のみを実行し、同SHAでのA checkと統合受入後にBを起動した。子adapterの未対応要求を通したものではない。

Bの初回は、試験指示が未実行checkに `evidence_refs: []` を渡していたため構造化質問報告が拒否された。summaryだけの代替報告もplan modeでは拒否され、報告なしで正常終了・cleanupした。検証を弱めず、未実行の質問段階では `checks: []`、checkを記載する場合は実際の参照を1件以上とする手順へ修正した。

Bを `retry_same` で同じthread/worktree・新owner/attemptとして再開し、修正した質問報告を保存した。利用者が親の正式フォームを操作したことも確認した。親の `beta` 回答は元の質問requestへ結び付き、同履歴の次ターンで実装を再開した。

Bは `b.txt` だけへ `beta` と1個のLFを書き、commit、A/B check、割当branchへのpush、remote SHA一致、clean worktree、最終報告、正常turn終了、job停止を完了した。再指示には含めなかった履歴内の確認文字列を最終報告で想起した。親は候補を受け入れた後、固定SHAをfast-forward mergeし、最終HEAD `694bd021fadcfa5bfc3a66754fc97a3516c82a74` に対するA/B checkを再実行して統合受入した。進捗書込みと `finish` によりrevision 27でrunは `completed` となった。未解決要求・不明配送は残っていない。

今回成功した同履歴修正はBの報告schema修正と、その後の質問応答・実装完了である。Aのコード修正attemptはcommitまで進んだが停止しており、成功した候補受入として扱わない。serial fixtureの親は保存済みイベントを見て試験controllerが起動した。自動wakeの再実証とはせず、過去のCC-03／CC-07の個別証拠と区別する。

## GitHub readback

統合結果だけを非公開の試験repo（識別子は公開対象外）の `cc07-serial-integration` へ通常pushした。connectorのrepo metadataでprivateを確認し、branchの保護状態は `gh api` で `protected: false` を確認した。`ls-remote`、GitHub branch API、新規cloneのHEADがすべて上記最終SHAに一致した。新規cloneでも `node checks.mjs A B` はexit 0、worktreeはcleanだった。

追加の作業ファイルのバイト比較は、既存の `core.autocrlf=true` によるCRLF展開で一度失敗した。Git blobを直接読み直し、a.txtは `alpha\n`、b.txtは `beta\n` に一致した。改行変換の設定や成果物を変更して通したものではない。子候補のローカルbareへのpush、最終統合のGitHub push、Meristemソースbranchのpushは別操作として記録する。

## 通常親UI・終了・設定復元

利用者が通常入力欄から停止確認と明示再開を送信したturnを `composer` と正常終了で照合した。最後に利用者が通常UIで `gpt-6-luna / low` を選び、60秒待機の指示を送信して停止ボタンを押した。`turn_context` の選択値、`composer`、待機の中断、`turn_aborted: interrupted` を確認した。実効backendモデルを推定したものではない。runはrevision 28で `stopped` となり、統合成果と報告を保持した。

利用者が専用ウィンドウ全体を閉じ、通常の作業ウィンドウが残った。親App Serverの切断を確認してuninstallを実行した。settingsキーは復元し、利用者のthemeを保持した。MCPへの後追いの `start_run` 承認設定を検出したため、installerは `retained` を返した。利用者が今回の導入ブロックと承認設定の2箇所だけの削除を明示承認した後、その2箇所だけを除き、他のbytesが変わらないことを比較して復元した。receiptの保持判断は書き換えず、追加復元の証拠を別に記録する。

全5attemptに `native_job_empty` / `native_creation_identity` がある。OSで10個のhost/child identityの不在を確認した。1つのPID番号は後発の `conhost` に再利用されていたが、作成時刻と実行ファイルが異なり、停止対象にしなかった。serial-01の2個のPIDも不在だった。worktree、branch、未コミットdraft、停止したAのcommit、状態DBと報告を保持した。

終了後のDBはrevision 29の `needs_reconcile`、attempt数5／配送予約6のままで追加起動なし。read-only SQLite openがWAL indexの復旧要求で拒否されたため、DB/WALのbyte一致コピーだけで復旧・照合し、元ファイルのhash不変を確認した。元DBの状態を書き換えて合格にしていない。

追加試験はserial-01が親2＋子1、serial-02がrunner親13＋通常UI親2＋子6、計24ターン。内部subagentは今回追加していない。各送信前予約を維持し、不明結果は再送していない。前回の19ターンとは別試行である。

## レビューと受入判定

独立した差分レビューにCritical／Important／Minorの指摘はなかった。実機結果と設定復元の判定はrootが担当し、変更していない製品コードの全面再監査は今回の範囲に広げなかった。既存の `debug.log` は変更に含めない。frontmatterと相対参照、構造化報告schema、差分、証拠の秘密除去を確認した。

最終の `npm run verify` はexit 0。native 39、control 181、terminal 14の全234件、型検査、buildが成功した。実機後の製品コード変更はなく、最終buildと実機時のhashを別に保存した。独立レビュー後の変更は報告形式の説明補足と受入記録であり、rootがschema・参照・証拠と照合した。

[今回の実機証拠](CC-07.continuation.evidence.json)は前回の並列／内部subagent／停止後の遅延報告／再読込み証拠を置き換えず、別試行として補完する。両記録を合わせてCC-07の専用環境での総合受入を完了とする。通常profileへの導入、公開配布、自動起動登録は実施していない。未対応承認、直接CLI入力、TUI、VS Code終了後の継続実行は従来どおり保証外。
