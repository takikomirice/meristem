# MC-10a 標準Codex履歴の読取り

2026-11-18（日本時間）。MC-07統合済みの `ed9401b` を起点に、`feat/mc-10a-worker-history` の専用worktreeで実装した。[工程表 MC-10](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md#mc-10-標準codex履歴への接続と再開前の照合)

## 読取り契約

- `WorkerRuntime.readHistory(worker, registration, cursor?)` は、呼出し側が信頼できる保存済み登録を渡す。登録の `WorkerRef` 全体を照合し、公式 `thread/read` の応答からthread ID・作業ディレクトリ・ルートthreadを確認する。現在のruntimeに対象の登録がある場合はproviderも照合する。
- `thread/read` は `includeTurns: false` とし、`thread/turns/list` の公式summaryを既定の新しい順で最大8ターンずつ取得する。返却値はthread ID、provider、turn IDとstatus、利用者とアシスタントのテキスト、次のcursorに絞る。summaryで省略される途中の発言や添付、ツール出力はこの戻り値の対象外。本文はMeristemのDBやログに保存しない。[MC-02の対応表](worker-coordination-compatibility.md) [OpenAIのApp Server実装](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_processor.rs)
- 閲覧専用のApp Serverを要求ごとに起動し、初期化と読取りRPCを発行して終了を確認する。既存の1 MiB RPCフレーム上限を使い、読取り失敗は実行中のワーカーの接続や停止結果に波及しない。閲覧に伴う新規thread、再開、モデルturn、旧grantの復元は発生しない。

## 検証と引継ぎ

- 最終差分の `npm run build` と `node --test dist/test/workers.test.js` は成功。ワーカー試験は32件、失敗0件。
- 追加の2テストは実装前に履歴読取りメソッドの欠落で失敗し、実装後に成功した。停止後の別runtime、WorkerRefの各項目不一致、異なるthread・cwd、不正なページcursor、閲覧で送るRPCを確認した。成功応答はRPC境界のfixtureで供給し、読取り失敗は既存のnative fixtureが返す不完全な応答で確認した。
- 実Codexの履歴読取り、実UI、VS Code再起動後の閲覧と明示再開は `not_run`。MC-10bでは保存済み登録を選ぶ操作と表示を接続し、再開時はGit・実行記録・停止結果を別途照合する。Codexの履歴statusはMeristemの実行・停止証拠に使わない。
- 操作UI公開前の内部API追加のためREADME更新なし。MC-10aの対象差分を専用ブランチへ出し、工程表の共通チェックは統合時に反映する。
