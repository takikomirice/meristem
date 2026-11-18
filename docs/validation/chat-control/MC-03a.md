# MC-03a: 相談処理と人向けフォームの単体確認

2026-11-17（日本時間）。[工程表](../../superpowers/plans/2026-11-17-worker-coordination-evolution.md#mc-03-相談inboxと人への選択式質問)のMC-03aのみを対象とする。起点は `6c41c3f`、実装ブランチは `feat/mc-03a-consultation-inbox`。統合・実装担当は本作業のエージェント1人。MC-03b／MC-04aは実装しない。

## 引継ぎと変更範囲

MC-02の最終commit・対応表とDE-06の引継ぎを確認した。DE-05の環境manifest／snapshot manifestのhash、選定済みCodex・Node・VS Codeのhashは引継ぎ値に一致した。既存3runはすべて `restored`、環境leaseと共有auth leaseは不在だった。既存snapshot・認証・専用設定・過去の証拠を変更せず、Git管理外の `.local/worktrees/mc03a` へ同じ起点のworktreeを作成し、依存・dist・native出力を分離した。

`Decision`／`DecisionAnswer`／`HumanDecisionRef`、既存のStore API、operation／revisionによる単一writerの契約を維持した。DB migration・共有schema・依存追加はない。

| ファイル | 変更 |
|---|---|
| `src/decisions.ts` | 仕様改訂・増員の提案先を人に限定。選択肢付きの人向け相談への自由記述を、新しい未承認proposalとして原子的に保存 |
| `src/requests.ts` | 標準MCP form用の `decisionForm`／`elicitDecision`。選択肢・自由記述・サイズの検査と取消・無回答・切断時の未承認維持 |
| `test/decisions.test.ts`、`test/requests.test.ts` | 複数相談、古い回答、正式approval RPCとの分離、修正案、再起動、標準MCP callbackを既存fixtureと実Storeで確認 |

## MC-03b／MC-04へ渡す契約

- `present` で得たdecision ID・plan/proposal hash・formGenerationを、表示した相談と一緒に保持する。`decisionForm` は選択肢のIDをenumにし、ラベルと説明をmessageに載せる。選択式に自由記述を併設する場合、その欄は明示的に「修正案」と表示する。
- `elicitDecision(decision, elicit)` は標準MCP `elicitInput` 相当のcallbackを受ける。取消・拒否・空回答・timeout・切断は `undefined` を返し、相談を解決せず、再送もしない。不正な回答は拒否する。この戻り値だけでは人由来を証明しない。
- 保存には既存の `resolveHuman(form, answer, verifiedHumanContext)` が必要。MC-03bはMC-02で確認した人専用callbackから接続し、model向けtoolに人の回答endpointを公開しない。既存の `answer_request` による正式承認は別経路のままにする。
- 選択肢付き相談に非空の自由記述があれば、選択の有無にかかわらず旧案は `superseded`、返却値は新しい `pending` のDecisionとなる。新IDは回答operation ID、新questionは修正案本文、proposal hashは再計算し、対象run・plan・task・blocking範囲・選択肢を維持する。旧案には回答を残す。同一operationの再照合では同じ新案を返す。新案は改めて表示・回答するまで未承認である。
- 選択肢のない自由回答型の相談は、自由記述を通常の回答として保存する。選択肢がある場合の修正案はDecision本文の既存上限（4,096文字／UTF-8 8,192 bytes）に従う。
- 回答・取消・superseded時のhold行削除は既存の意味を維持する。停止確認、実行枠解放、保留作業の再開許可を意味しない。MC-04は回答内容・現行plan・Git・owner／attempt・他の未解決相談を照合する。
- 読取りは既存のStoreページングを利用する。通知のwire形状・進捗イベント・wake cursorへの集約はMC-03bの接続時に固定し、本工程では追加しない。

## 検証

着手時のbuildと既存decisions／requestsの31件は成功。追加テストで5件のRED（親宛の仕様変更提案、原案を承認してしまう自由記述、修正案の上限、フォーム生成・回答処理）を確認し、実装後39件がGREENになった。

標準MCP SDKのInMemoryTransportと実Storeを使うfixtureを追加し、取消・拒否・無回答・切断・選択回答・修正案を別々に確認した。decisions／requests／mcp／wakeの対象81件は成功。独立レビューでもdecisions／requestsの47件が成功し、修正必須・Minorの指摘はなかった。

`npm.cmd run verify` はnative build、typecheck、本体・拡張build、通常42件まで成功した。制御系の実行中にMC-03bの追加依頼を受けて実行セッションが終了し、制御系の最終集計・端末テストの結果は得られていないため、全体成功とは記録しない。MC-03aで必須の対象81件は上記の別実行で成功している。MC-03bの統合後に残る回帰を検証する。ログ・進行記録は本worktreeのGit管理外 `.local/mc03a/` に保持する。

## 残る確認

MC-03bのMCP／CLI／wake配線、MC-04とのhold／回答／resume結合、実UI由来の今回の回答、実モデル・正式実行承認ゲートは `not_run`。fixtureの回答を人の実同意や実機受入へ読み替えない。native／拡張の新配線はMC-03bで必要になった箇所を実装し、今回は未使用の別UIを追加しない。

READMEは未更新。利用者向けtoolや設定はまだ変わらず、内部契約と後続作業の説明はこの記録へまとめた。MC-03aの単体完了をMC-03全体の完了とはしない。
