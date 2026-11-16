# CC-00R 実施結果

実施日: 2026-11-15（日本時間）
対象: [実装計画のCC-00R](../../superpowers/plans/2026-11-15-codex-chat-control-implementation.md)
判定: **CC-00Rの受入完了。専用子CLI・統合ターミナル・実shell/孫プロセスの停止・履歴継続・親再開入口・MCP呼出し元相関を実証した。CC-01は未着手。**

## 最終受入（追加12ターンの実施後）

[専用子CLIの受入証跡](CC-00R.direct-acceptance.evidence.json)と、前回確認済みの[親UI再開証跡](CC-00R.parent-wake.evidence.json)を組み合わせた判定。単一の連続試験で全項目を通したという記録ではない。以前の失敗・未確認記録は下に時系列で保持する。

| 計画の確認項目 | 結果・証拠 |
| --- | --- |
| suspended起動と専用所有単位 | 子はJob割当前・明示Resume前に動かない。fixtureでP/A/B/Dを独立させ、A停止後もP/B/Dのマーカー増加を確認。RPC interruptの受領だけでは孫のマーカーが止まらない対照もPASS。 |
| 子RPCと表示/停止の分離 | 子の`codex-stdio`はbrokerが唯一のstdio所有者。拡張IDの多重化なし。ACL付き16 endpointで表示接続を保持してもstatus/stop可能。表示接続の破損・過大入力・切断はworkerを止めず、broker EOFはJobを閉じる。 |
| terminal状態・入力・非表示 | 実VS Codeでcwdと`gpt-6-luna / low (requested)`を表示。貼付けは送信されず、非表示の2秒間もA/Bのshellと孫マーカーが増えた。adapterで古いattempt拒否・完了タブの表示だけの閉鎖・停止結果不明時のpoll継続を確認。 |
| ログの安全性・上限 | 固定したイベント名だけを表示しraw RPC/認証応答を流さない。制御列/秘密除去、64 KiB/イベント、1 MiB/未描画キュー、UTF-8境界、省略件数、100件ずつの継続poll、ページ取りこぼし防止をPASS。描画前にstatus RPCを処理する。 |
| 親中継の回帰 | 既存テストに完全一致ID衝突・途中切断・形式変更時の漏出防止を追加。分類不能フレームが管理応答待ちに来た場合は抑止し管理を無効化する。破損したUIフレームまで無損失で扱えるという保証ではない。 |
| build・型・fixture | 標準`npm run build:native`、型検査、extension build、root tests、terminal testsをPASS。今回の環境では通常の`powershell.exe -NoProfile -File`経路が動作し、実行ポリシーは変更していない。 |
| 実catalog・子の独立性・履歴 | 専用認証homeで実catalogを照合し、別cwdのA/Bを別App Server/Jobで起動。Aに覚えさせたtokenを同じthreadの次turnが完全一致で返した。無効model/effortとbusyは送信前拒否のfixture分類を使用。要求値・返却設定を確認したが、backend実効値の独立検証はしていない。 |
| タブ閉鎖と対象の限定 | Aの実terminalをゴミ箱で閉鎖。公式sandbox内で実Codexが起動したshell/孫のPID不在と2秒間の追記なしを確認。Pの制御応答、Bと対照Dの追記は継続。 |
| 明示停止・異常終了・窓終了 | 別fixtureでCの停止command、Bのhost強制終了、Eの通常VS Codeウィンドウ終了を実施。すべてshell/孫のPID不在と2秒間の追記なし。さらに別の実shell試験でbroker EOFを確認した。 |
| 親再開・呼出し元 | 前回の通常UI応答後に同じ親rootへ保存済み子結果を送った再開証跡を保持。今回、親Pと子AのMCP processが実Jobのプロセス一覧に含まれ、metadataのthread/turnが当該root/turnと一致した。caller引数を身元にしていない。 |
| 復元・後片付け | 専用configの試験MCPブロックとprofileの導入値を復元。worker host不在に加えて、閉鎖前に記録した専用profileの25プロセスすべての不在を別観測で確認。通常profileや無関係なウィンドウは変更していない。 |

### 検証結果とレビュー修正

- `npm run build:native` / `npm run typecheck:extension` / `npm run build:extension`: PASS。
- `npm test`: **33/33 PASS**。親relay・Job所有/停止・MCP・試験台帳/復元の回帰を含む。
- `npm run test:terminal`: **12/12 PASS**。実モデル呼出し0件。
- 最終native版の実CLI preflight: 認証済み、catalog、workspaceWrite/network無効、Job割当、EOF後host不在をPASS。**モデルturn 0件**。
- レビューでは、表示接続のIOExceptionがworkerを止める問題、無改行の過大入力、停止結果不明でもpollが止まる問題、停止通知と別表示接続終了の競合、停止client保持によるhost残存を修正した。再現テストの失敗→成功と全体PASSを確認した。途中の全体実行で所有単位テストが1件timeoutした記録も保持し、停止通知の所有者限定と終了待機の総時間上限を加えた最終版で再検証した。

### 実機試験の範囲と残る制約

- 今回承認された追加12回をすべて計上し、残り0回。11回は正常完了を観測、1回は完了未確認のまま所有Jobを回収した。親UIの1回の入力から2回の開始が観測された試験も両方数え、未知結果を再送しなかった。APIキー課金へ切り替えていない。
- suite04のshell/履歴指示には返信条件の矛盾があり、履歴確認は不合格として保持した。suite05で「shell開始」と「token想起」を別turnに分けて合格した。親MCPはsuite03、子MCPはsuite04の確認済み項目だけを採用し、suite全体の失敗を成功へ塗り替えていない。
- 実停止試験時と最終buildのhashを別々に記録した。実機後のResume分離、ページ取得、表示切断処理、停止通知の後片付け修正はfixtureと最終版の実CLI無推論preflightで検証した。追加枠を超えて最終版の実モデル停止試験を再実行してはいない。
- 異なる利用者tokenによるACL拒否と、backendの実効model/effortは未確認。永続broker、製品向けMCP変更操作、正式承認の配送、CC-03の無人2工程、通常導入はこの段階の成果に含めない。
- 現在の再現入口は`direct-probe.mjs --live --case preflight|shell`と`direct-suite.mjs --live --case acceptance`。必須パスと使い捨て試験rootを明示する。suiteの手順・前提は[README](../../../README.md)を参照。shell/acceptanceには新たに承認された送信枠が必要で、今回の台帳は再利用しない。

## 初回時点の実装・検証記録（以下は履歴）

### 実装した範囲

- `ProcessTree`へ明示cwdを追加。既存のsuspended起動、Job Object割当確認後の再開、kill-on-closeをworker hostで再利用する。
- `LocalPipe.CreateSecurity()`へ現利用者/SYSTEM許可とNetwork SID拒否を集約し、worker hostも再利用する。
- `CodexWorkerHost.exe`を追加。試験用の絶対exe/cwdと専用Job Objectを要求し、16個の独立したACL付き名前付きpipe endpointでstatus/events/stopを受ける。管理操作はread-only status/event readとstopのみ。stop応答はJobを閉じた後、子プロセスの終了を待ってから`ok: true`を返す。
- Worker stdout/stderrはraw RPC・秘密を表示しないよう破棄する。表示できるのはhostが生成したJob所属・終了確認イベント。
- 補助VS Code拡張のfixture接続、状態/イベント取得、試験workerの停止、`isTransient`なPseudoterminalを追加。terminalは入力を配送せず、500 ms間隔・最大100回でpollする。閉じたときrunningなら現在のbindingだけを停止し、completedなら表示のみとする。
- 明示`--live --case fixture-stop` runnerと独立marker fixtureを追加。実Codex/VS Codeを起動するcaseにはしていない。

## 検証

- `build-native.ps1 -OutputDirectory .local/chat-control-build -WithFixtures`: PASS。`powershell.exe -NoProfile -File ...`経由はこの環境の実行ポリシーに拒否されたため、同じスクリプトを現在のPowerShellから直接実行した。ポリシーは変更していない。
- `npm run typecheck:extension`: PASS。
- `npm run build:extension`: PASS。
- `npm run test:terminal`: 3/3 PASS。
- `node --test test/worker-host.test.mjs`: 3/3 PASS。16 endpointへの並行status取得、対象workerの孫プロセスだけの停止、自然完了時の孫プロセス回収、fixture外の実行ファイル/marker拒否、peer workerと独立control markerの継続を確認。
- `node --test test/relay-spike.test.mjs`: 14/14 PASS。既存親中継の回帰を確認。
- `terminal-probe.mjs --live --case fixture-stop ...`: PASS（mock fixtureのみ）。機械可読fixture記録は[CC-00R.fixture.evidence.json](CC-00R.fixture.evidence.json)。

## 未実施・未確認

- 専用VS Code profileのterminal接続・表示・非表示時の継続・閉鎖停止、通常親UIの応答後の中継再開、子Aの実MCP thread/turn相関を確認した。実モデルturnは累計7回（先の承認1回＋追加承認6回）で、正常完了5回・完了未確認で回収2回。通常親Pからの子A/B割当、子の同履歴追加依頼の完了、model/effortの実効値の独立検証、親の実MCP呼出し相関は未確認。
- 追加実施で実Codex App Serverの初期化、model catalog取得、root thread作成、Job Object経由の停止は確認した（モデルturnなし）。WorkerHostはCodexRelayを所有Job内で起動し、stdioをterminalへは流さない。選択したApp Server event名だけを管理イベントへ投影する。
- 親中継の新しい管理ID完全衝突・途中切断・形式変更テスト、64 KiB/1 MiB上限の境界テスト、実sandbox shell/孫プロセスとそのbroker EOF/host異常終了/VS Code終了時の停止は未確認。hidden-panelの実機継続とstale-bindingのfixture拒否は確認済み。試験profileは終了し、親の試験設定を復元した。
- `turn/interrupt`受領を実プロセス終了と混同していないことは新しいfixtureのstop経路で別途待機したが、Codex turn interruptとの実機比較は未実施。
- 異なる利用者tokenからのACL拒否、thread/request identity相関も未確認。

この結果はCC-00や旧A/B/Cの証拠を更新・代替しない。新しいlive結果を捏造せず、上記未実施事項を完了条件として残す。

## 2026-11-15 追加実施

- [実Codex子worker no-inference evidence](CC-00R.real-child.evidence.json): Codex CLI 0.169.0-alpha.11.1をhash照合後に起動し、未認証・隔離`CODEX_HOME`で`account/read`、`model/list`（9件）、`thread/start`（root thread・cwd一致）、`relay/status`を確認した。stop応答はprocess exit後に返り、WorkerHostもexit code 0で終了した。モデル呼び出しは0件。
- [専用VS Code profileの実端末接続結果](CC-00R.real-vscode-terminal.evidence.json): VS Code 1.146.0の一時profileで拡張コマンドを確認し、初回はterminal表示まで進んだが、拡張hostからACL付きnamed pipeを開く処理が`EPERM`となった。terminal closeからworker stopを確認できず、control ACLは緩和していない。二回目は追加した事前接続確認で`EPERM`を表示し、terminalを成功扱いしない。
- この時点ではnamed-pipe制限の原因は未特定だった。同じ利用者での再試験結果は後述。親P・B・MCP metadata・公式sandbox shell・host/EOF/VS Code終了の受入は未実施。
- 追加コード検証: `npm test` 19/19 PASS、`npm run typecheck:extension` PASS、`npm run build:extension` PASS、`npm run test:terminal` 3/3 PASS。nativeの3 executableは`build-native.ps1`と同じcsc source/optionsの直接実行でcompile PASS。
- `npm run build:native`はPowerShell実行ポリシーで`-File scripts/build-native.ps1`が拒否されたため、そのコマンド自体はPASSとしていない。ポリシーは変更せず、同じcsc引数を直接実行してnative buildを確認した。

## 2026-11-15 認証後turnの事前確認

- [専用CLI認証事前確認](CC-00R.real-turn-preflight.evidence.json): 利用者から専用profileの認証完了連絡を受け、runnerが使う隔離`CODEX_HOME`を確認した。`auth.json`がなく、同じhomeを指定した`codex login status`はexit code 1（未認証）だったため、モデルturnは送信していない。グローバル認証情報へのfallback/copyはしていない。
- [実catalogの無推論取得](CC-00R.real-catalog.evidence.json): 実Codex App Serverから9モデルと対応effortを取得し、承認済み1ターンの指定値を`gpt-6-luna` / `low`に選んだ。これは候補選択だけで、`turn/start`は送信していない。
- runnerに`--one-turn --auth-home --model --effort`経路を追加した。送信前にlogin状態と実catalogのmodel/effort一致を確認し、turn/startは一度だけ送信、結果不明なら再送しない。既存evidence pathへの書込みも拒否する。
- 追加検証: runner構文check PASS、fixture-stop PASS、既存fixture証拠への上書き拒否とSHA-256不変を確認、`npm test` 19/19 PASS、`typecheck:extension` PASS、extension build PASS、terminal tests 3/3 PASS、native worker/relay tests 17/17 PASS。
- この時点では認証先の相違により1モデルturnは未実施だった。以下の追加試験で専用CLI認証とterminal接続を確認した。

## 2026-11-15 専用CLI認証後の実施

- [認証済み1モデルターン](CC-00R.real-single-turn.evidence.json): 専用`CODEX_HOME`でCLIと`account/read`の認証済みを確認。実catalogで有効な`gpt-6-luna` / `low`を指定し、`turn/start`を一度だけ送った。受領したturn IDに対応する`turn/completed`の`completed`を確認し、Job停止とWorkerHost exit code 0まで確認した。返信本文は採取しておらず、要求設定の実効値の独立検証もしていない。
- [同じ利用者での実VS Code terminal試験](CC-00R.same-user-terminal.evidence.json): 以前のhostはsandbox専用利用者、VS Codeは通常利用者だった。`LocalPipe.CreateSecurity()`は起動利用者とSYSTEMだけを許可するため、この組合せでは`EPERM`になる。正規の実行承認を経て通常利用者でhostを起動し、ACLを変えずに接続できた。OS利用者の同一性は、sandbox内コマンドのSID末尾1003と通常起動の1001を比較して確認した。
- 専用profileで`Worker fixture running`、専用cwd、初期化ログを確認。パネルを隠してもhostは生存し、再表示後に対象terminalだけを終了すると、worker stop・WorkerHost exit code 0・対象hostの不在を確認した。この試験はモデル要求0件で、認証済み1ターンとは別試験。実shellや孫プロセスを開始した試験ではない。
- runnerの完了待ちで勝者が決まった後もtimeout timerが残る問題を修正した。既に停止証跡を保存した旧runnerだけを終了し、修正後の無推論probeはPASSとNodeプロセスexit code 0を確認した。
- モデル実行枠は承認済みの1回を使用済み。親P・子B・履歴継続・実shell/孫プロセス・MCP相関の追加実機試験は別途実行承認が必要。CC-00R全体は未完了でCC-01を開始しない。

## 2026-11-15 追加最大6ターンの承認後

追加枠の[集約証跡](CC-00R.additional-summary.evidence.json)。追加枠は**3回送信、正常完了1回、完了未確認のままJob回収2回、未使用3回**。先に承認された1回とは別枠。配送結果不明の同じ要求を自動再送せず、後の試験は所有Jobを閉じて別attempt/root threadで実施した。

| 試験 | 観測と判定 |
| --- | --- |
| 子Aの実MCP呼出し | [suite初回](CC-00R.live-suite.evidence.json)で正常turn完了。MCP transport metadataのthread IDとturn IDが登録root thread/当該turnに一致した。ツール引数からcaller身元は受け取らない。 |
| 同じ子Aへの追加依頼 | 同じthreadへのturn/start受領は確認したが、完了通知・shell markerは確認できず、有限timeout後に所有Jobを回収した。履歴の想起やshell開始を成功扱いしない。 |
| legacy sandbox指定 | [送信前確認](CC-00R.live-suite-workspace-write.evidence.json)で、`sandbox: workspace-write`を送っても対象版が`readOnly`を返すことを再現した。モデルは送信しなかった。 |
| 公式permission profile | 無推論の`permissionProfile/list`で組み込み`:workspace`の許可を確認。`experimentalApi: true`と`thread/start.permissions: :workspace`で`workspaceWrite`・ネットワーク無効が返った。[公式profileでの試験](CC-00R.live-suite-official-workspace.evidence.json)はturn受領後に正式な応答が必要なserver requestを検出したため、代理回答せずJobを閉じた。 |
| 親Pの通常UI | 別の専用profileへ公式拡張と親relayを読み込み、初回案内を進めた。公式Windows setupが`Approval was canceled`で停止。親へのモデル要求は0件で、親の応答後の再開も未実施。管理者権限なしへの切替はしていない。 |

この版のpermission profileは[公式App Server API](https://learn.chatgpt.com/docs/app-server)のbeta入口を使い、[公式権限profile](https://learn.chatgpt.com/docs/permissions)の`:workspace`だけを許可する。nativeの許可はCC-00R用sidecar設定との一致と許可cwdを要求し、全権限profile・任意の権限指定・turn中の権限変更を公開しない。legacy指定が反映されなかった理由そのものは対象版の内部実装まで特定できていない。

試験brokerは`live-suite.mjs --live --real-exe <absolute-exe> --root <new-CC-00R-root> --auth-home <dedicated-home> --evidence <new-json>`。同一承認内の続きは`--budget-root <original-root>`で共通6回台帳を指定し、`--remaining-only`でmetadataターンを繰り返さない。台帳は送信前に排他的に予約し、timeout/承認待ちでも枠を戻さない。`--remaining-only`は新attemptであり、元の会話履歴の継続成功を意味しない。試験MCPのconfig項目だけを終了時に除き、公式setupが保存した設定を保持した。[configが既に存在した時点の中止記録](CC-00R.live-suite-permissions.evidence.json)も残す。

### モデルを使わない追加実装・検証

- `--broker-stdin true`の明示owner channelを追加した。EOFでworkerのJobを閉じる。`broker_eof_and_host_death_stop_owned_descendants`を失敗させてから実装し、EOF・host異常終了の両方でfixtureの孫marker停止を確認した。
- terminalの接続にattempt IDを固定し、別attempt/別pipeの停止をI/O前に拒否する。接続時のbindingを複製して後の差替えの影響を防ぐ。`stale_terminal_binding_cannot_stop_new_attempt`は修正前に実I/Oへ進んで失敗し、修正後は送信前拒否でPASS。
- `workspace_write_requires_explicit_matching_CC00R_profile`で、通常profile、全権限指定、legacy sandbox、許可cwd外のcatalog取得を拒否し、明示CC-00R設定と一致した公式`:workspace`だけを通すことを確認した。
- WorkerHostはserver requestの内容を表示せず「正式な応答が必要」とだけ投影する。試験runnerはこの状態で停止し、成功stub・暗黙許可・権限緩和を行わない。初期化途中の失敗でも起動直後からhostをcleanup対象へ登録する。
- 検証: native relay/hostを同じcsc引数でcompile PASS。`npm test` **24/24 PASS**、型検査・extension build PASS、terminal tests **4/4 PASS**、新runner/MCP probeの構文check PASS。native必須テストは20/20 PASS。`build:native`スクリプト経由の実行ポリシー制約は前述のまま。

別コンテキストの差分レビューで見つかった3件も修正した。初期化応答が停止したMockでbroker EOFを発生させ、修正前の終了timeoutと修正後のJob内プロセス不在を確認した。親の2ターンは同じ6枠台帳で送信前予約し、同一rootの異なる2ターンの完了記録なしでは先へ進めない。設定復元・所有host不在を確認できない場合は`passed`にしない。親予約とcleanup判定の回帰テストは欠落した状態で失敗させてから修正し、全24テストを通した。このレビュー後に追加モデルは送っていない。

この時点では追加suiteのworker host/relay/試験Nodeに残存がないことを確認し、親profileは公式OS承認のため開いたままだった。profileの終了と復元の追加結果は次節に記す。実shell/孫プロセスの停止・P/B/Dの継続・親UI再開・VS Code終了・全境界テストなどはまだ受け入れておらず、**CC-00Rは未完了、CC-01は開始しない**。

## 2026-11-15 公式OS承認後の親再開・後片付け

[親UIと中継再開の証跡](CC-00R.parent-wake.evidence.json)。利用者の承認を受けて専用親profileを再読み込みし、公式Windows setupを再開した。利用者からOS承認完了の連絡を受け、setup案内が消えて通常入力画面へ進めたことを確認した。管理者権限なしへの切替、承認状態の書換え、独自setupは行っていない。

1. 共通台帳で親2回分を送信前予約し、公式UIで`GPT-6 Luna / Light`を選択した。試験文の入力後に`CC00R_PARENT_READY`を確認した。
2. その後のイベント照合で、公式UIから異なる2 rootへ2回のturn/start受領・正常完了が記録されていた。余分なUI要求の原因は未特定で、空threadだけとして除外せず**2回とも追加枠へ計上**した。UIに表示中の対象は、登録済みかつloadedで、試験文・token・正確な返信・完了turnが一致する唯一のrootを読んで特定した。タイトルやlatestでは選んでいない。
3. 残り1回を台帳へ予約し、保存済み子AのMCP相関結果と、後続shell試験は未完了という事実を入力にして、完了済み親の同じthreadへ`turn/start`を1回だけ送信した。異なるturn IDの正常完了と、公式UIの`CC00R_PARENT_74 CC00R_PARENT_WAKE`表示を確認した。親側の通常応答後の再開入口と履歴継続の実証であり、CC-03の無人工程実行ではない。
4. 最終照合は、親の実開始3回・正常完了3回・active turn 0、追加枠全体は**6回送信・正常完了4回・完了未確認でJob回収2回・残り0回**。先の個別承認1回を含む累計は7回。モデルを追加で送らず試験を終了した。
5. 親profileと以前のworker試験profileを通常UIで終了した。閉鎖前に記録した親profile/relay/子Codexのプロセスがなくなったこと、CC-00R host/relayの残存がないことを確認した。親profileの導入値と一致する試験設定4キーを取り除き、通常profile・利用者の変更・公式setupの設定・試験証跡を保持した。

再現入口は`parent-probe.mjs --live --session <prepared-P-session.json> --phase prepare|observe-first|wake`。`prepare`は予約とcatalog確認のみ、`observe-first`はUIの実turn数と本文一致の照合、`wake`だけが1回のモデル送信を行う。送信前にphaseを保存し、結果不明や再実行時は同じ要求を再送しない。**追加6回枠は使用済みなので、このsessionへのモデル送信を続けない。**

残る受入は、子が始めた公式sandbox shell/孫プロセスの停止とP/B/Dの継続、子の同履歴追加依頼の完了、異常終了時の実コマンド停止、親MCP相関、全境界テスト等。追加の実モデル試験には新しい実行枠の承認が必要で、CC-00R全体は未完了のまま。
