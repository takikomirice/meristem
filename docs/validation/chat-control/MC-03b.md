# MC-03b: 相談のMCP接続と通知

2026-11-17（日本時間）。[工程表MC-03](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md#mc-03-相談inboxと人への選択式質問)のMC-03b。起点はMC-03aの `3591dc2`、実装ブランチは `feat/mc-03b-consultation-routing`。MC-03aの専用worktreeを同じ統合担当が引き継ぎ、MC-04aの別worktree・未統合差分は変更しない。

## 実装と利用する契約

| 入口 | 契約 |
|---|---|
| `propose_decision` | `OperationRef` と `proposal` を受ける。proposalは既存DecisionProposal。親は許可範囲、ワーカーは本人taskの相談だけを作成できる。現行plan hash・taskを検査する |
| `get_decisions` | `runId`、任意の `afterId`／`limit`（1〜4、既定4）。`decisions: [{decision, answer}]` と `nextAfterId` を返す。約80K bytesでページを区切り、ワーカーへ他担当の本文・回答を返さない。formGenerationは公開しない |
| `answer_consultation` | `OperationRef` と `decisionId`。親宛は `answer`、人宛はanswerを省略して標準選択式＋自由記述フォームを表示。親から `close: cancelled / superseded` も指定できる。answerとcloseは同時指定できない |

回答・原案の差替えにはMC-03aのDecisionServiceを再利用する。人宛の回答をmodel引数で渡す経路は拒否する。フォームはモデルへ返す前に取り除き、本人用callbackだけを既存の `mcp_human_response` → CLI → McpControllerへ送る。callback内でのみopaque contextを生成し、runの有効性、親identity、permit、scope、plan/proposal hash、formGenerationを照合する。再起動で失効した世代は復活させない。

新しいnative methodや独自のフォーム配送サービスは追加しない。既存CLIのnative認証・metadata検証・汎用転送をそのまま再利用する。正式な `answer_request` の権限要求は従来の別経路を維持する。ワーカーのローカルMCP call consentには `propose_decision`／`get_decisions` を追加するが、それは呼出し自体の許可であり、相談内容への回答・同意・Git権限付与ではない。

フォーム提示の同operation再試行は状態だけを返し、旧フォームを再配送しない。有効なcallbackの同一再照合は保存済み結果を返し、異なる回答では拒否する。取消・拒否・空回答・切断・timeout・未対応クライアントでは相談を未承認のまま保持する。計画変更後の回答は拒否し、古い相談の明示取消は実行範囲の許可として扱わずに受け付ける。

相談の作成・回答・取消は `decision_changed` イベントを同一transactionで保存する。既存wake cursorへ集約し、親の活動中や人の入力と競合する状態ではsteerしない。通常の進捗イベントを新たなwake候補にせず、起床用のwireには固定指示と識別子だけを送る。nativeの固定指示に `get_decisions` の確認を加えた。

## 検証記録

追加したMCP経路・wakeの5件でREDを確認した。さらに新ツールのcall consentとscope変更後の取消で2件のREDを確認し、最小修正後の個別GREENを確認した。全体の初回GREENではfixtureがWorkerRef全体をstrictなActorRefへ渡していた2件を修正し、identity検証自体は弱めていない。

native build・本体／拡張build、対象4ファイルの89件は成功した。独立レビューでは、plan modeの人用callbackが実計画ファイルを読み直す前に保存snapshotの旧案を受理できるImportant 1件を検出した。実ファイルを変更して他のstatus操作を挟まず回答する回帰テストを追加し、拒否されないREDを観測後、callbackでも `PlanControl.assertCurrent()` を実行する最小修正でGREENを確認した。他の必須指摘・Minorはなかった。

修正後の `npm.cmd run verify` は終了コード0。native build、型検査、本体／拡張build、通常42件・制御269件・端末14件の**計325件がすべて成功**した。制御系には追加回帰を含む対象4ファイルの90件、既存のnative認証・正式承認経路、停止・復元・Git・配布の回帰を含む。ログ中の一時fixture `related.test.js` の意図的な失敗は開発CLIの失敗伝播試験であり、その親テストと最終集計は成功している。MC-03a／03bを合わせた実装での検証で、MC-03aの先行中断ログは変更しない。

最終の自己レビューで、無関係な差分、既存の正式承認の緩和、DB migration・依存追加、データ削除、制御lockの追加がないことを確認した。文書の参照・差分も確認した。ログと進行記録は本worktreeのGit管理外 `.local/mc03b/` に保存する。

## 受入の境界

MC-04aは別担当の枝番であり、本差分へ未統合。MC-04bによる相談→対象保留→回答→安全な新attempt再開、取消・superseded時の非再開、独立担当の続行の結合確認は未実施。hold行の削除を停止確認・枠解放・自動再開の根拠にしない。MC-03全体はその受入まで未完了とする。

実モデル、今回の実UI回答、正式な実行承認ゲート、専用VS Codeの新規起動は `not_run`。新しい実送信・課金・通常profile変更は行っていない。READMEは未更新で、追加toolの契約は[運用リファレンス](../../chat-control-reference.ja.md)に追記する。
