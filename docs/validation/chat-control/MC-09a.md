# MC-09a: 拡張側の担当・作業・相談表示

2026-11-17。起点は`f980879`（MC-05統合済み）。ブランチは`feat/mc-09a-terminal-presentation`、専用worktreeは`.local/worktrees/mc-09a`。[計画](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md)のMC-09aだけを実装する。MC-09全体のチェックはMC-09bの実接続まで確定しない。

## 実装と固定した表示契約

- `extension/src/control-client.ts`に、MC-01の`WorkerPresentation`と同じフィールドの拡張用型を置く。本体と拡張は別ビルドのため本体の実装をimportしない。`WorkerRef`の識別フィールドは変更しない。
- `ControlConnection.getStatus`の返り値`WorkerStatus`には、従来の`cwd`／`branch`／`agent`／`state`に加え、任意の`presentation`、`consultations`、`permissionSummary`、`lastResult`、`connection`を受け取れる。`consultations`は相談の`id`／`recipient`／`question`／`state`／`taskIds`／`blockingTaskIds`だけを使い、`presentation.decisionIds`と照合する。情報がないときは詳細未取得と表示し、相談の解決や保留解除を推測しない。適用権限の情報がない場合も「情報なし」と表示する。
- `TerminalBinding.presentation`は初期タブ名、status内の`presentation.displayName`は`onDidChangeName`による表示名更新に使う。操作対象は従来のWorkerRef・attemptのままで、表示名やGitブランチを操作先に使わない。表示上のモデル・推論強度は要求した値であり、適用telemetryとして扱わない。
- 作業状態と相談状態を別行に表示する。各pending相談について明示された`taskIds`から`blockingTaskIds`を除いた範囲を「続行範囲」、後者を「保留範囲」として表示する。回答済み・取消・旧版の相談から現在の保留や再開許可を作らない。相談ごとの範囲表示は全相談を集計した実行許可ではない。
- 任意の`DisplayEvent.source`は`tool`／`worker`を区別する。未指定の旧イベントは従来の限定ログのまま表示し、由来を推測してラベルを付けない。現在作業も`activitySource`で区別する。
- 最終活動のISO時刻を表示し、60秒以上古くなれば通常のstatus pollで「活動更新が古い」と表示する。接続失敗／`connection: unknown`は最新状態未確認と表示する。状態が同じなら要約を重複出力しない。監視・経過時間表示・描画のためにモデルを呼ばない。
- actor・attempt・フルパス・ブランチは`showWorkerTerminalDetails(terminal)`の詳細描画へ分ける。この関数は読取り表示のみで、コマンド登録はMC-09bに引き継ぐ。
- 完了後にterminalを自動disposeしない。入力・貼付け、非表示、明示停止、プログラムによるdispose、実行中／終了済みタブ閉鎖の既存境界を維持する。`isTransient`も維持し、VS Code再起動後の画面復元は追加しない。

## 表示の上限と失敗経路

既存の1出力64 KiB、未描画バッファ1 MiB、イベント取得100件の上限を維持する。最新状態はログと別の置換可能な優先枠に保持し、そのbytesも同じ1 MiBへ計上する。ログoverflowで最新状態や停止確認を捨てない。描画は`setImmediate`で分割し、status RPCを待たせない。

通常表示は活動説明2,048 bytes、相談理由256 bytes、続行／保留範囲は各512 bytes、権限／結果は各1,024 bytesまでのプレビューとし、項目ごとに「表示省略」を付ける。相談の照合は最大128件。64 KiBの要約枠に収まらない相談は省略件数を示す。最終活動・直近結果を相談群の前に確保する。UTF-8途中で切らず、タブ名・詳細・要約・イベントすべてに既存のANSI／OSC／制御文字除去と秘密情報のマスクを適用する。全文会話・raw RPC・内部思考の新しい収集はない。

status取得に失敗したときは未表示イベントのcursorを確定せず、復旧後に同じcursorから読み直す。新しい配送やモデル呼出しは発生しない。

## 検証とレビュー

MC-09a追加前の`build:extension`と`test:terminal`は15/15成功。固定入力の表示テストを先に追加し、担当名・作業／相談・古い活動／接続不明・長文表示の未実装をREDで確認した。status失敗時のcursor進行も専用テストでRED→GREENを確認した。

独立した読取りレビューで次のImportant 2件を再現し、回帰テストを先に失敗させてから修正した。

1. 大量ログが状態要約を押し出し、完了時に担当や終了状態が一度も表示されない。最新状態の有界優先枠で修正。
2. 契約内の長い相談理由20件で、後続相談の保留範囲や直近結果が切り捨てられる。項目ごとの省略と要約枠の明示計数で修正。

長文相談の回帰fixtureは日本語2,048文字／6,144 bytesとし、文字数・UTF-8 bytes両方の契約内で確認する。最終制御テストの実行中にfixtureの長さだけをこの値へ合わせ、拡張を再buildして25/25成功を確認した（`contract-sized-terminal.log`）。プロダクトコードの変更はない。標準verify末尾のterminal試験も同じ最終ビルドを使う。

同名担当の異なるattemptへのイベント・停止の分離、非表示継続、停止不明時のpoll継続、完了ログ保持、状態優先描画、UTF-8・秘密・制御文字、64 KiB／1 MiB境界、低速描画とRPCの順序も確認する。レビュー対象外とした実接続は下の引継ぎへ残す。

途中の`npm run verify`はnative build・型検査・buildが成功したが、通常テスト42件中41件成功、`malformed_or_disconnected_display_client_does_not_stop_worker`がsocket終了待ちでタイムアウトした。同じ未変更nativeテストはコード変更なしの単独再実行で成功した。途中失敗は成功へ読み替えず、`.local/mc09a/verify.log`／`native-retry.log`に保持する。

修正後の全体検証では、通常テスト42件中41件成功、VSIX内容検査のPowerShell出力をUTF-8としてJSON解析する箇所が失敗した。CP932の「表」に含まれるbackslash byteが新しい「表示省略」文言で顕在化したため、`test/package.test.mjs`の検査子プロセスだけにUTF-8出力を明示した。梱包した`terminal.js`の全文がビルド出力と一致する検査も追加し、単独RED→GREENを確認した。これは5.3節の拡張ファイル一覧に加えた最小の検証基盤修正で、製品packager・OS設定・公開仕様は変更しない。読み違えた場合は日本語の梱包結果を誤判定するため、追加した全文一致検査で検出する。失敗ログは`final-verify.log`／`packaging-encoding-red.log`、成功ログは`packaging-encoding-green.log`へ保存した。

最終の`npm run verify`はexit 0。native build・本体／拡張の型検査・build、通常42件・制御297件・端末25件の計364件がすべて成功した（`verified-final.log`）。最後のプロダクトコードと検査基盤修正を含む結果で、上記fixture調整後の端末ビルドも末尾で確認済み。文書更新後の`git diff --check`と関連Markdownの相対リンクも成功した。RED／GREEN・レビュー修正・全体検証のログと作業台帳はこのworktreeの`.local/mc09a/`に置く。

自己レビューでは、表示名と操作先の分離、最新状態の優先枠とbytes計上、停止確認の描画、入力を転送しないこと、旧接続の互換性、秘密・制御文字の除去、変更ファイルと後続工程の境界を確認した。修正必須の残件はない。依存追加、認可・配送・永続化形式の変更、成果や既存証拠の削除はない。README日英と運用リファレンスも更新した。

全体ログ内の`related.test.js`の意図的な失敗は、失敗を検知する`logic_refresh_runs_tests_without_vscode`のfixtureであり、その親テストは成功している。

## MC-09bへの引継ぎと未実施

backend／nativeのstatus・実イベントは変更していない。`managed-client.ts`を含む既存接続は従来のstatus／イベントを返し、新情報を勝手に補完しない。MC-09bで上記の任意フィールドとsourceを実データから供給し、名称変更・詳細表示・既存Quick Pick等のコマンドを登録する。MC-04の保留、MC-05の退役／停止、MC-08の古い相談、完了後の相談更新を実statusと照合して表示・停止を受け入れる。

実モデル、実VS Code UI、標準履歴、再起動後の表示／明示再開、追加OS隔離の新規受入は`not_run`。認証・通常profile・専用実機環境・DB・設定・native実装は変更していない。過去のCC／MC証拠や他工程のworktreeはそのまま保持する。
