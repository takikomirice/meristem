# DE-05: 有限のsandbox probeと開発サイクルの実測

2026-11-17（日本時間）。[開発環境計画のDE-05](../../superpowers/plans/2026-11-17-development-test-environment-first.md#de-05-有限のsandbox適合確認と開発サイクル実測)を対象とする。着手時HEADは `193c95e`、ブランチは `docs/worker-coordination-plan`、着手時の未コミット変更はなし。DE-06・MC-03以降には進めない。

## 対象と再選定

利用者から「MC-02は別PCで行ったため、現在PCで新しく組む」と指示された。旧PCのログ・authHomeを推測して置き換えず、[MC-02対応表](worker-coordination-compatibility.md)の未完了・実UI・個別auto-reviewの留保を維持した。今回の観測を旧PCの再検証として算入しない。

- Windows 11 Home、build 26300、Node v24.22.1、VS Code 1.146.0。
- 公式拡張 `openai.chatgpt-26.1111.21308-win32-x64`、Codex `0.169.0-alpha.11.1`。exe SHA-256は `a473edef0d52c4ffa067060ddd48a3d85720a3256cbd0510aab71d406f3af744` でMC-02の選定値と一致した。PATH上の別版は使っていない。
- 現在PCにあった既存の専用authHomeで、公式 `login status` によりChatGPT認証を確認した。通常のCODEX_HOMEを自動採用せず、認証情報・sandbox markerをコピーせず、新規ログイン操作も開始しなかった。開始時にはMeristem MCP設定と開発leaseが存在しなかった。
- 新しいenvRoot・profile・extensions参照・実行用Git領域を分離して作成した。旧試験のRunPermit、送信枠、owner epoch、DBを流用していない。実装root内のauthHomeとビルド入力が重なるため、専用の完了済み出力を別領域に用意してからsnapshot化した。
- 実Codexの新しい親threadを作成した。モデルturnは送らず、native hostのjob閉鎖・子プロセス終了・host終了を確認した。thread作成をモデル応答やOS隔離の成功とは扱わない。

## 実装と証拠の意味

`test/live/development.ts` に `sandbox-probe` と送信枠0専用の `cycle` を追加した。既存の環境・snapshot・installer・所有者・receipt・停止・復元の検査を利用し、新しい依存や常駐処理は追加していない。日英READMEと[開発手順](../../development-environment.ja.md)を更新した。

実機初回では専用Codeプロセスがrunningでも、通常終了に使うwindow handleがなく、Computer Useにも対象windowが現れなかった。brokerのstop応答は成功しattemptは0件だったが、Codeの終了を推定せず `unknown` を維持して2回目を止めた。1回の表示要求と、親VS Code環境を除去した別条件の表示要求でも操作対象を確認できず、原因を断定していない。Windowsユーザー・session・desktop名の一致はメタデータで照合した。

利用者がこの専用profileのプロセスだけを強制終了することを明示承認したため、実体・作成時刻・親子関係を再照合して19件を対象とした。終了処理の途中にAccess deniedがあり、成功を推定せず独立したOS照合を実施した。記録した全19identityの不在、専用profileの未使用、brokerのstopped状態、attempt 0件を確認してから既存の停止・復元APIへ確認事実を渡し、`restored`・retained 0件を確認した。通常の作業windowは保持した。これは一度だけの承認済み回復であり、通常終了の成功や汎用の強制停止機能には算入しない。lease／lifecycleの直接編集・削除で復元を装っていない。

`test/live/development-session.ts` の起動設定も補正した。専用の対話用Codeを `windowsHide: false` で起動し、親の `VSCODE_*` とcrashpad接続環境を引き継がない。背景の診断helperは非表示のまま。対応するfixtureテストでRED→GREENを確認したが、この補正だけで初回のwindow問題が解消したとは主張しない。

probeは静的診断と別の明示操作であり、選定済みexeを1回だけ起動し、1000〜30000msのtimeoutと管理領域denyを指定する。対象版の `sandbox --help` で `--include-managed-config` とpermission profileの入口を確認した。elevated／MXCの指定を固定し、無断の方式変更、Full Access、setup再試行、モデル送信を行わない。保存済みconfigを書き換えず、attemptを先に保存し、同じIDの再送を拒否する。失敗・timeout時にはauth leaseを保持する。

`phase: observed` のprobeはworkspace読取りとcanaryの読取り拒否を確認した範囲を示す。所有プロセスの子孫を含む停止を独立に観測していなければ、`ownedProcessesStopped: unconfirmed` のままとする。cycleの `limitedCheck: observed` は所有VS Codeプロセスのrunning照合であり、Codexや拡張の準備完了・画面操作・モデル応答を保証しない。終了・復元は別の既存検査を通す。起動失敗を後片付けの成功で成功扱いにしない。

明示的なsetup呼出しとモデル送信は0回。公式プロセス内部のsandbox setup、実際のUAC、人へ依頼した操作、window再起動は自動計測していないため、CLIの自動記録では `unconfirmed` とする。実測時間とfixtureの回数を、これらの未観測値の代用にしない。

## UACとsandboxの留保

旧PCのMC-02ログは現在のPCに存在せず、初期設定干渉や1909の原因を再現・断定できない。現在の専用authHomeは設定上 `elevated` で、既存sandboxログには `setup` という語が複数回あるが、語の出現数はsetup起動数やUAC回数を意味しない。対象ログに1909の文字列は見つからなかった。初期設定干渉は仮説として残す。

[公式Windows sandbox資料](https://learn.chatgpt.com/docs/windows/windows-sandbox)では、MXCはOS能力・組織設定に依存し、明示指定は非対応やポリシー拒否時に失敗する。現在PCのbuild番号だけで対応済みと判断せず、管理設定を含む明示probeの結果を別に記録する。UACの自動操作、保護機能・OSポリシーの緩和は追加していない。

## 同じ固定環境での2サイクル

初回の失敗・承認済み回復と分け、同じenvRoot・profile・extensions参照・authHome・snapshotで2回の正常サイクルを確認した。snapshot IDは `de05-initial`、manifest SHA-256は `177eb910515ffaced4d7e464c64d33589b221530b7b8f805881924556ff8a329`。各回のrun ID、stateDirectory、pipe、receipt、DB領域は新規で、RunPermit・旧owner・送信枠を再利用していない。

エージェントの通常コマンド経路ではwindowを観測できなかったため、試験用の小さい.NET launcherをComputer Useの公式 `launch_app` から起動した。launcherは選定済みCodeのhashを照合し、同じ専用profileとauthHomeで `ProcessWindowStyle.Normal` を指定するだけで、認証・sandbox設定・モデル送信を行わない。実際のprepare・installer・lease・status・stop・restoreは既存APIとWindows driverを使用した。fixture成功の代用ではない。

launcher自身はwindowを持たずすぐ終了するため、Computer Useは「launcherに対象windowなし」と返した。再送せず、生成されたCodeのPID・作成時刻・実体と、後から一覧に現れた専用windowのhandleを照合して継続した。専用windowの画面を観測し、通常の `CloseMainWindow` と全捕捉handleの終了確認を通して終了した。2回とも強制終了は不要だった。通常の作業windowは保持した。

| 段階 | 正常サイクル1 | 正常サイクル2 |
|---|---:|---:|
| prepare | 48.109秒 | 40.598秒 |
| start | 88.303秒 | 94.566秒 |
| status | 2.353秒 | 1.222秒 |
| stop段階（画面確認・合図待機を含む） | 89.303秒 | 45.894秒 |
| restore | 0.722秒 | 0.670秒 |
| 全体 | **228.790秒** | **182.950秒** |

時間は各段階の実測値。startにはsnapshot照合とGUI起動の待機を、stop段階には画面確認とエージェントの合図待機を含む。純粋な起動・終了処理時間や、同条件の速度改善量へ読み替えない。通常windowの起動・終了を各回1回ずつ観測し、同じprofileを閉じて開き直した。各回でauth configのバイト一致、profile設定の意味上の一致、`restored` を確認した。

明示setup呼出し・モデルturnは両回とも0。公式内部のsetupとsecure desktopのUAC回数は観測手段がないため `unconfirmed`。この正常2サイクルでは本人にログイン・設定編集・window操作を依頼していない。先行する例外回復の強制終了同意1件とは分けて記録する。

GUI launcherのソース・exe・起動要求・結果、各サイクルの元JSONは `.local/de05/` に保持した。これは今回の実機観測の補助であり、通常CLIだけで現在のエージェント環境から常にwindowを表示できるという受入ではない。DE-06へこの制約と既に準備した補助経路を引き継ぐ。製品用の汎用launcherや自動GUI切替は追加していない。

## MXCの有限な実機probe

正式に選定した同じCodexで、管理設定を含むMXC明示probeを実行した。通常診断からの起動は0回。実probeは以下の2件で、それぞれ起動1回、timeout 30000ms、モデルturn 0回。最初の成功を再送したものではなく、2件目で所有Jobの終了観測を追加した。失敗時の再試行・elevated／unelevated／Full Accessへのfallback・setupの反復は行っていない。

| probe | sandbox実行時間 | exit | workspace読取り・管理canary deny | 所有プロセス停止 |
|---|---:|---:|---|---|
| 単体CLI | 447ms | 0 | observed | 独立観測なし、unconfirmed |
| native Job外側監視付きの独立probe | 479ms | 0 | observed | observed（root終了・Job empty） |

2件目は既存 `native/ProcessTree.cs` を変更せず、試験用observerに組み込んだ。選定済みNodeのhashを照合し、CLIをsuspendedで所有Jobに割り当ててから再開する。35秒のroot待機と5秒の停止確認を持ち、stdout/stderrは保存しない。実Code／通常window／他の試験をJobに入れない。実Codexを使った実機観測であり、MockCodexは使用していない。

observerは `jobAssigned: true`、`commandRootExited: true`、`commandExitCode: 0`、`jobEmpty: true`、自身の終了コード0を返した。内側CLIの `ownedProcessesStopped` は引き続き `unconfirmed` で、外側の独立したOS観測を別の証拠として関連付けた。CLI一般が子孫停止を自己証明するよう改変していない。この条件での管理領域denyと所有Jobの停止を確認した範囲であり、ネットワーク分離や全権限機能の受入ではない。

probe後もauth configは開始前とバイト一致し、選択済みの `elevated` を維持した。Meristem MCP entry、auth lease、環境lease、所有CLI設定は残っていない。MXCへの永続切替、通常環境への導入、registry／firewall／OSポリシーの変更は行っていない。初回の承認済み回復を含め、設定復元と通常作業windowの保持を最終確認した。

## 自動検証とレビュー

- 着手時baseline: 開発テスト37/37成功。
- 主要probe／cycleテストのREDを観測後に実装。明示live、有限timeout、再送・fallback拒否、hash変更拒否、設定保護、同一環境で2run、未知の停止後の復元・追加起動拒否を確認した。
- 起動前失敗を復元成功で成功扱いにする問題も、追加テストのRED→GREENで修正した。
- 起動補正前の開発テスト42/42成功。fixtureのOS効果はdoubleで分離し、既存installer・receiptと実ファイルを使用した。実機・OS隔離・UACの受入には算入しない。
- 主CLI追加時の独立した読取りレビューでCritical／Importantの指摘なし。その後の実機検証で追加した起動補正は自己レビュー・TDD・全体回帰で確認した。軽微な追加観点として、probeの非ゼロ終了41／42・throw・signal単独の表形式テストは未追加。timeout経路と再送・fallback拒否は検証済み。
- 起動境界とlease照合の追加後に、最終 `npm run verify` が終了コード0。通常42/42、制御244/244、端末14/14、**計300件すべて成功**。nativeビルド・型検査・JS／拡張ビルドを含む。開発テストは43件で、起動の可視設定と親VS Code bindingを渡さないことも確認した。
- 文書参照、差分、秘密の非混入、利用者設定・別プロセス・未コミット成果の保持、lockの解放を自己レビューした。DE-06・MC-03以降と、MC-02の実質問フォーム／個別auto-reviewは未実施のまま。

ローカルの実行入力・snapshot参照・元の測定記録・RED／GREEN・全体検証ログは `.local/de05/` に保持する。公開文書には認証情報、raw設定、sandboxログ本文、アカウント情報、個人の絶対パスを含めない。
