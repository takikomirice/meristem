# Meristem Worker のモデル・推論強度の自動調整 Implementation Plan

> 実装時は `superpowers:executing-plans` または `superpowers:subagent-driven-development` を使い、工程ごとに検証する。`[ ]` は実装・受入が未実施の項目を示す。

**Goal**　通常の作業で得た検証結果を使い、必要なときだけ Worker の model／effort を上げ、次に類似した仕事を割り当てる際に実績を使えるようにする。

**Architecture**　Coordinator は失敗原因と成果の採否を判断する。broker は事前に許可された候補から次の設定を選び、既存の Worker 作成・配送・統合経路を使う。評価は統合の記録から集計し、通常運用の判定で追加のモデル呼び出しを発生させない。

**Tech Stack**　現行の Windows、Node.js 24.22.1 以上、TypeScript、組み込み SQLite、Zod、`node:test`。

**Spec**　本書の「運用仕様」。現行制御の前提は[ワーカー運用改善計画](2026-11-17-worker-coordination-evolution.md)および[運用リファレンス](../../chat-control-reference.ja.md)。調査起点は `0bf3d75`。

## 現行実装と接続点

| 現在できること | 今回追加する判断 |
| --- | --- |
| `src/plan.ts` が工程表のモデル・推論強度・依存と作業範囲を検証する | 自動調整に参加するタスクと、利用できる設定の順序を宣言する |
| `PlanControl.reserveAssignment` と `send_instruction` は工程表の設定に従う。`WorkerRuntime` が実カタログと起動応答を照合する | 予約済み attempt の設定を配送まで固定し、切り替え後も同じ検査を通す |
| `record_decision` が引継ぎや統合を記録し、`accept_integration` が検証済みの最終 SHA と成果を結び付ける | 次の設定の選択理由と、検証を通った実績を対応する attempt に結び付ける |
| 専用開発環境では run ごとに新しい状態ディレクトリを生成できる | 選んだ過去 run の集計を小さなローカルファイルで持ち込み、次の run で利用する |

MC-07 の設定照合と MC-08 の計画改訂を土台にする。既存 MC の統合受入と切り分けて実施し、着手時に最新の統合ブランチと共有ファイルの作業状況を再確認する。MC-07 の実モデルによる次タスク実行は[既存の検証記録](../../validation/chat-control/MC-07.md)で未実施として扱われている。

## 運用仕様

- **出発点。** Coordinator は Sol 6.2／`high` を運用例とし、今回の自動調整は Worker に適用する。通常の Worker は Sol 6.2／`medium` を初期の推奨値とし、判断が難しいと分かっている仕事は最初から Sol／`high` や Astra／`high` を計画で選べる。製品コードはモデル名を固定せず、実行環境のカタログにあるモデル ID と effort の組を設定に書く。Luna や Terra も同じ契約で明示的に選べる。
- **事前に決める範囲。** 版2の `run.worker_model_policy` に順序付き候補を置き、対象のタスクだけ `model_routing` を指定する。既存の `agent` がそのタスクの初回設定であり、通常の再割り当ての基準にもなる。`model_routing` がないタスクはこれまでどおり固定。通常案は `Sol/medium → Sol/high → Astra/high`。候補列の変更は新しい run の承認で扱う。対象、候補、最大の追加試行数を既存の RunPermit で人が確認できるようにする。
- **切り替える条件。** Coordinator が必須検証の不合格や、検証可能な調査を終えても原因を絞れなかったことを確認し、`record_decision` で根拠付きの引継ぎを選ぶ。そのとき broker が候補列の次の設定を決める。指示不足、環境エラー、承認待ち、利用枠・配送の不明、複数 Worker の取り込み時だけに出た競合はモデル切り替えの根拠から外す。分類が不明な場合は通常の相談・診断へ戻す。
- **引継ぎ。** 選択は次の attempt に適用する。Coordinator は前回の成果・失敗した確認・新しい指示を引き継ぎ、既存の `create_worker` と `send_instruction` で配送する。選択機能が独自に Worker を起動したり再送したりする経路は追加しない。既存の Git、停止、権限、スロット、修正回数・送信枠の検査を通す。途中の設定変更や既存権限の持ち越しは行わない。
- **評価する対象。** 初回の受入と、設定変更後に復旧できたかを別の実績として記録する。成功の根拠は `accept_integration` と最終 SHA。個々の Worker に帰属できない統合失敗、配送結果不明、取消は初回成功率の分母から外し、件数を併記する。初回設定には実際に照合できたモデル ID と effort を使い、未確認の設定を成績に加えない。Worker の自由記述は原因調査の材料に使う。
- **次の仕事に使う実績。** 同じリポジトリで、着手前に付けた仕事の種類・判断の難しさが同じものを比べる。少数の実績は件数付きで表示する。通常作業では、比較が必要なタスクに着手前から同じ比較用のキーを付け、初回 `agent` を変えれば Sol→Astra と Astra→Sol の両方を試せる。復旧の成功だけで初回の割り当てを推奨しない。
- **記録の量。** 管理 DB の決定・検証記録を再利用し、比較に使う要約は対象リポジトリの直近200件を上限とする。200件は初期の設計値。比較資料として会話全文、プロンプト、差分、ログ本文を複製しない。専用のモデル試験モード、計画表の分割・統合の自動化、新しい UI はこの計画の範囲外。

## Global Constraints

- 版1、およびモデル調整を指定していない版2の工程表・MCP 呼び出し・保存データは既存動作を維持する。既存の `create_worker` の戻り値形状を維持し、選択結果は `get_status` の追加フィールドから取得する。
- RunPermit の対象、承認済み工程表、既存の認証・課金経路と権限上限を守る。モデル切り替えだけで権限・必須検証・依存・スロット・送信枠を変えない。実行環境の拒否や照合失敗は既存の停止・照合経路に従う。
- 運用例の `medium`、`high`、比較用の件数・しきい値は設計の出発点。節約効果は実測する。利用量が公式応答から計測できない場合は未計測と記録する。

## Review Focus

1. 前回 attempt の終了や配送結果が不明なときに、モデルを変えて同一仕事を二重起動しない。工程2で確認する。
2. 計画改訂・再起動・並列割り当てで、古い選択が別 attempt や別タスクに適用されない。工程2で確認する。
3. 自称「失敗」、検証未実施、複数候補での統合失敗をモデル固有の失敗と誤認しない。工程1・2で確認する。
4. 引継ぎ込みの成功や選択の偏った実績が、初回向きの比較を押し上げない。工程1・3で確認する。
5. 他リポジトリ、不一致のモデル設定、改変された集計、少数サンプルでは割り当ての基準を変更しない。工程1・3で確認する。

## ファイルと責任

| ファイル | 責任 |
| --- | --- |
| `src/plan.ts`、`src/contracts.ts` | 版2の任意設定、候補と仕事分類、旧版互換。候補の組は既存の `ModelId`／`Id` を再利用 |
| `src/broker.ts`、`src/mcp.ts`、`src/store.ts` | 親の検証済み判断、次 attempt の選択と予約、配送の照合、既存の決定ログと状態への記録 |
| `src/model-routing.ts`（新規） | 切り替え候補の順序、評価対象条件、受入実績の集計と同種タスクの比較。モデルや外部サービスを呼ばない |
| `src/cli.ts`、`src/install.ts`、`src/workers.ts` | 承認時の要約、ローカル集計の持ち込み、実カタログとモデル設定の適用確認。既存経路に接続 |
| `test/plan.test.ts`、`test/plan-control.test.ts`、`test/mcp.test.ts`、`test/store.test.ts`、`test/workers.test.ts`、`test/model-routing.test.ts`（新規） | 設定、評価の根拠、既存の制御境界を fixture で検証 |
| `skills/codex-chat-coordination/`、`docs/chat-control-reference.ja.md`、`README.md`、`README.en.md` | 運用例と判定根拠、使える設定、既存の切り戻し経路を説明 |

## 工程1　通常運用の実績を記録する

**成果物**　`get_status({runId, taskId})` に、モデル設定、初回か引継ぎか、根拠のある結果を読み出せる任意の `modelRouting` を追加する。既存の `Registration.settings`、構造化報告、`record_decision`、`accept_integration` を出典に使う。

- [x] 版2のタスクに任意の `model_routing: { kind: 'implementation' | 'investigation' | 'visual' | 'routine', complexity: 'bounded' | 'complex', comparison_key?: string, pin_initial?: true }` を追加する。`comparison_key` は既存の `Id` で検証し、同じ基準で評価できる通常タスクを着手前に関連づけるためだけに使う。`pin_initial` は初回 `agent` を固定する。ここでは割り当てを変えず、着手時の分類、計画版、必須チェック名の集合を評価の出典として保持する。
- [x] `record_decision` の `handoff_new`／`retry_same` にだけ任意の `modelAssessment: { attemptId, reason, checkName? }` を追加する。`reason` は `required_check_failed | investigation_stalled | unclear_instruction | environment | waiting_approval | integration_conflict | unknown`。前二者は既存の `evidenceRefs` と、対象が同一タスク・attempt・計画版であることを要求する。`required_check_failed` には必須チェック名と構造化失敗結果、`investigation_stalled` には保存済みの失敗報告と Coordinator の確認を要求する。権限申請や配送が未解決の attempt は評価を確定しない。
- [x] `src/model-routing.ts` に `summarizeModelOutcomes(samples: readonly ModelOutcome[]): ModelOutcomeSummary[]` を追加する。`ModelOutcome` は repo の照合キー、runId・taskId・attemptId・planHash、仕事分類のキー、照合済みの model／effort、初回／引継ぎ、判断理由、結果、証拠参照、記録時刻を持つ。所要時間は同じ定義で測れた記録のみ集計する。完了済み候補は既存の統合決定を出典にし、別の永続テーブルが不要なら既存 Store の決定記録を使う。旧データで出典が欠ける場合は未評価とする。
- [x] `routing_outcomes_are_attributed_once_to_the_verified_attempt` を追加する。再実行・再起動・N件統合でも同じ attempt は一件とし、候補受入だけでは成功にしない。初回失敗→引継ぎ成功は初回不合格1件、復旧成功1件、タスク完遂1件を期待する。偽の attempt、旧計画版、未確認設定、承認待ち、出典のない失敗も確認する。
- [x] RED → GREEN を確認する。`npm.cmd run build`、`node --test dist/test/model-routing.test.js dist/test/plan-control.test.js dist/test/mcp.test.js dist/test/store.test.js`。評価記録だけで配送・モデル呼び出し・統合条件が変わらないことを自己レビューし、この工程をコミットする。

工程1は MC-09b／10b／11b の統合後の `41d794a` を起点に実装した。起動時に照合した model／effort と着手時の計画条件を既存の attempt に保存し、結果は既存の親決定ログから読み出す。独立レビューを受け、最終 SHA が欠ける、または異なる場合はモデル実績を未評価にし、旧計画版と配送結果不明の実績は集計しないことを追加の RED → GREEN で確認した。既存の直列取り込みは成立し、採否の検査を追加した範囲はモデル実績のみ。所要時間と利用量はこの工程の記録から比較できず、実モデル受入は未実施。

全体検証の `npm.cmd run verify` は統合直後が426件、工程1の実装後が通常42件・制御362件・端末29件で計433件成功。工程1の回帰7件は単独実行でも成功。

## 工程2　承認済み候補から次の設定を自動で決める

**入力契約**　`AgentChoice = { model: string, effort: string }`。版2の `run.worker_model_policy: { mode: 'rules' | 'learned', candidates: AgentChoice[] }` は任意。工程2では `rules` を受け付け、工程3で `learned` を追加する。順序付き候補は2〜4件、組の重複なし。run と対象タスクの双方に指定がある場合に適用し、その `agent` の組は候補列に含める。

**出力契約**　選んだ model／effort、前回 attempt、理由、根拠、選択時の planHash を親の決定記録に残す。`get_status` の `modelRouting` に次の割り当ての設定と理由を出す。`create_worker` は従来どおり `WorkerRef` を返し、`send_instruction` で attempt に予約された設定を照合する。

- [x] `routing_is_opt_in_and_bound_to_the_human_permit` を追加する。無指定・版1は現行動作。未知の項目、候補重複、対象タスクの初期設定が候補外、古い承認、候補の無断書き換えを拒否する。`start_run` のプレビューと既存 CLI の人向け表示で対象・順序・上限を見せ、表示した scope／plan hash の承認だけを消費する。候補列の変更は新しい run の承認で扱い、MC-08の改訂で許せる明示設定は候補列内に限定する。
- [x] `selectNextAgent(candidates: readonly AgentChoice[], previous: AgentChoice): AgentChoice | undefined` を実装する。確認済みの能力上の失敗を Coordinator が `handoff_new` で指定した時点で、現設定の次だけを準備する。設定列の末尾、修正枠なし、再試行不能、候補外は次の設定を準備しない。候補列を一周させず、同じ run・タスクに対する自動変更は設定列の長さから1を引いた回数まで。現行の修正枠がそれより小さい場合はそちらが先に効く。配信・認証・権限上の失敗は既存の扱いに戻す。
- [x] `routing_reserves_the_choice_before_worker_start` と `routing_preserves_stop_and_approval_fences` を追加する。予約と決定を既存の単一 writer に載せ、`Registration.settings` と実カタログの照合を維持する。固定タスクは従来どおり工程表の設定で照合する。調整対象は現行 planHash と予約した attempt の設定で照合する。旧 attempt、承認待ち、未解決停止、送信不明、改訂、再起動、同時 `create_worker`、旧リクエストの再送、別タスクの設定流用で追加配送が起きないことを確認する。
- [x] `model_switch_does_not_inherit_history_grants` を追加する。切り替えは検証済みの後始末と Git 状態を条件に、新しい attempt・thread で行う。旧ワーカーへ送らず、同じ権限プロファイルを改めて検証する。候補がカタログにないと判明した場合は理由を返し、他の候補への自動再送はしない。
- [x] RED → GREEN を確認する。新しい worktree では `npm.cmd run build:native` で WorkerHost とテスト用 exe を先に生成する。`npm.cmd run build`、`node --test dist/test/model-routing.test.js dist/test/plan.test.js dist/test/plan-control.test.js dist/test/mcp.test.js dist/test/workers.test.js`。Coordinator スキルと運用リファレンスに設定例を追加し、自己レビュー後にコミットする。ここで通常運用の切り替えと記録を使い始められる。

工程2は `6b10919` を起点に実装した。人が見る候補列と切り替え上限を RunPermit に紐づけ、broker が記録した設定を新しい attempt の起動と配送で照合する。独立レビューを受け、切り替え準備時の元 worktree の HEAD を起動前に再照合し、既存のスレッド ID を登録させない検査を追加した。起動後のカタログ変更では配送を取り消し、再照会で同じ理由を返す。CLI と RunPermit の接続は native fixture で確認し、追加の回帰4件も単独実行で成功した。実モデルでの受入は未実施。

最終の `npm.cmd run verify` は終了コード0。native・型検査・ビルド、通常42件・制御374件・端末29件の計445件が成功した。

## 工程3　実績から次の初回割り当てを改善する

**入力契約**　ローカル CLI の `routing-summary --state <停止済み状態ディレクトリ>` を用意し、必要な場合は `--state` を複数指定できるようにする。既存のオフライン状態参照と同様に読み取り専用で取り出し、対象 repo の一致と run の確定状態を照合する。`--out <ファイル>` で次の run に持ち込むサイズ制限付き JSON を出力する。導入時の信頼済み設定 `mcp.scope.modelRoutingSummary: { path, sha256 }` で一つだけ指定し、読み込み先は worktree と認証領域の外に置く。起動時に正規化パス、形式・サイズ、repo の照合キーと hash を確認し、承認対象に集計の hash を含める。任意のファイルを開く MCP ツールは追加しない。

**判断規則**　`recommendInitialAgent(baseline: AgentChoice, candidates: readonly AgentChoice[], stats: readonly ModelOutcomeSummary[]): AgentChoice | undefined`。対象 repo・仕事分類・判断の難しさ・着手前の `comparison_key`・必須チェック名の集合が一致する通常タスクの、確定した初回成績だけを入力にする。比較用に記録するタスクは `pin_initial: true` にし、両設定を着手前に振る。自動調整の初期条件は、既定と候補に各5件以上の有効な初回実績があり、候補の初回受入率が既定を20ポイント以上上回ること。条件を満たす候補が複数あれば受入率が高い順、同じなら候補列の順を使う。比較用のキーがないタスクや差が付かないタスクは計画指定で開始する。件数・試行の偏りを確認して見直すための仮値であり、統計的な優越や費用削減を保証するものではない。

- [x] 工程1の集計を、既定・候補ごとの初回受入数／対象件数、引継ぎ件数、計測できた所要時間・利用量と未計測件数として出力する。既存レコードの生ログは維持し、出力と比較入力は重複排除した直近200件に制限する。時刻が同じケースは runId・attemptId で順序を固定する。別モデルの版の結果は合算しない。
- [x] `routing_history_cannot_promote_a_model_on_recovery_only` と `routing_history_requires_comparable_first_attempts` を追加する。初回実績不足、基準と異なる仕事の混在、復旧成功だけ、同率、新しいモデルの実績ゼロでは既定を選ぶ。例として「既定3/5、候補4/5」でちょうど20ポイント差になるケースと、その直前の境界を確認する。時間・利用量は最初は参考値に留める。
- [x] `routing_summary_import_is_bounded_and_repository_pinned` を追加する。停止未確認の run は出力元から除く。別 repo、改変された要約、重複した記録、壊れたファイル、上限超過は読み込み時に拒否する。`rules` は候補を表示する段階に留め、`learned` かつ対象タスクが `pin_initial` を指定していない場合だけ初回に反映する。集計未指定、標本不足、推奨候補のカタログ非掲載が配送前に確定した場合は、初回の計画指定を既存経路で照合して使い、理由を表示する。
- [x] RED → GREEN を確認する。`npm.cmd run build`、`node --test dist/test/model-routing.test.js dist/test/plan-control.test.js dist/test/mcp.test.js dist/test/store.test.js dist/test/control.test.js`。Markdown の日英 README と運用リファレンスに、通常運用で比較対象を決める手順、`rules` への切り戻し、少数データの扱いを追記し、自己レビュー後にコミットする。

工程3の対象検証は、ビルド後に工程表・制御・MCP・保存状態・モデル割り当て・ネイティブモックを含む159件が成功した。独立レビューで見つかったカタログ応答の形式確認漏れと、未評価の引継ぎ件数の集計漏れを修正した。既存の実績には所要時間とトークン数の計測値がないため、集計には未計測件数を出力する。

`npm.cmd run verify` は終了コード0で、通常42件・制御380件・端末29件の計451件が成功した。カタログ形式の最終調整後にワーカーの回帰33件も成功した。実モデルと VS Code 実画面の受入、運用での利用量比較は未実施。

## 統合受入

- [x] `npm.cmd run verify` を実行する。通常の並列統合、停止、RunPermit、手動のモデル指定、旧版の工程表・状態読取りが通ることを確認する。
- [x] 専用のテストリポジトリと既存 ChatGPT 認証経路を使う。実モデルを試す時点で、対象カタログ・送信上限・認証・既存の利用条件を確定する。枠は送信前に確保し、応答不明も消費扱いにする。まずモデル送信なしで設定照合を確認し、その後に承認済みの有限枠で `通常の初回成功` と `切り替え後の成功または明示失敗` を観測する。fixture、設定照合、実モデル受入の結果をそれぞれ記録する。
- [x] 運用比較は Coordinator の設定を固定し、同種の Worker タスクで従来設定と `medium` 中心の設定を比較する。初回採用率、取り込みまでの手戻り、Coordinator のレビューを含む時間、計測できる利用量を確認する。モデル差・effort 差・工程分けを同時に変更しない。測定前に節約効果を記載しない。
- [x] Git 差分、秘密を含まない記録、互換性、停止・送信不明の扱い、現行 MC の受入との関係を確認する。この計画書を書いた時点では、実装・実機試験はいずれも未実施。

2026-11-18の実機では、専用ChatGPT認証のカタログでSol 6.2のmedium／highを照合し、両設定の単独課題と公式履歴の読み戻しを確認した。再起動後の通常課題でhighとmediumが各1回で採用され、必須検証不合格を根拠にhighへ引き継いだ別課題も最終SHAで採用された。試行条件・運用比較は[MC-12との総合受入](../../validation/chat-control/worker-coordination-acceptance.md)を参照。
