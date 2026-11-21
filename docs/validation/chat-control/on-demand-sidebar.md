# 通常の Codex サイドバーからの単発呼び出し

普段使う VS Code の公式 Codex 拡張で、呼び出した親チャット（Coordinator）が、読み取り専用の子チャット（Worker）の結果を同じ応答で受け取れるかを確認する。[実装計画](../../superpowers/plans/2026-11-20-meristem-on-demand-plugin.md)

## 入口別の記録

ローカルでは `npm run verify` が成功した。配布・ネイティブ関連など47件、制御系451件、VS Code 拡張36件の計534件が合格し、スキップは0件だった。計画指定の `node --test dist/test/on-demand.test.js dist/test/workers.test.js` でも47件が合格した。

| 入口 | 確認項目 | 結果 |
| --- | --- | --- |
| 自動テスト（本物の Windows Job、模擬 Codex） | 空白を含む同一 Git ルートの A/B、実際の終了コード 0/7、Worker の要求履歴と停止 | 2件合格。A/B の receipt は別々。Worker の `turn/start` は0件、Job の空状態と host 終了を確認。API キーを示すアカウント応答も送信前に拒否 |
| 開発作業のツールシェル（公式 Codex、2026-11-21） | 送信0回の事前確認 | 下記の実測記録。通常サイドバーは別途確認 |
| 展開した ZIP と専用の Codex プロファイル | 公式 CLI による marketplace／プラグインの追加・削除、配布物およびインストール先キャッシュからの起動 | パッケージ試験で確認。両方の `inspect` は模擬 Codex。既存の MCP／VS Code 設定とコミットを保持 |
| サイドバーの会話 A/B（2026-11-21） | 個別の標準出力と終了コード | 同じ Git ルートで A は 0、B は 7。別々の receipt が各会話に戻った。B で Skill を検出。B の保存済み応答・ツール履歴で完了を確認。許可画面は未観測 |
| サイドバーのシェル（同日） | ChatGPT 認証、読み取り専用の隔離、停止 | 公式 CLI 0.171.0-alpha.13。実ファイルの隔離、読み取り専用スレッドと Job の停止を確認。親側の試験設定はフルアクセス |
| インストール済みプラグイン（同日） | 読み取り専用の実モデル1往復と削除 | 実装 `0a1233e` の配布キャッシュから `gpt-6-luna / low` に1回送信。A に返った識別子とファイルの値が完全一致、再送0回。削除後、キャッシュと marketplace 登録が消え、VS Code 設定と試験用 Git は一致。通常 Codex 設定のファイル全体の指紋は変化し、差分の原因は特定できていない |
| 通常サイドバーからの編集 | モデルの選択、利用者による範囲の承認、保存・監査・統合 | 工程1〜3の実機受入と編集経路の実装後に確認 |

### ファイルを確認する各 Worker を VS Code の下部に表示する

オンデマンド版のプラグインと同じビルドの `meristem-chat-control-*.vsix` を、普段の VS Code の「拡張機能」→「…」→「VSIX からのインストール」で追加する。信頼済みのローカルウィンドウで公式 Codex サイドバーからファイルの確認を頼むと、そのウィンドウに `Worker inspect #番号` が開く。タブを閉じても検査は続き、結果は依頼した会話に届く。表示用 VSIX を入れていない環境でも単発の検査は利用できる。

2026-11-21、普段の VS Code プロファイルに開発版 VSIX とプラグインを導入し、このサイドバーから別の試験用ファイルを検査した。実 Worker に1回送信し、終了コード0。再読込みの操作は不要だった。実際の画面で `pwsh` と並ぶ `Worker inspect #1`、起動・ファイル確認・終了の3行を確認した。返却された要約はファイルの接頭辞と32桁の16進形式を正しく説明し、識別子の全文は含まなかった。下部タブは検査後も参照でき、試験用 Git の変更は0件。試験に使ったプラグイン ZIP の SHA-256 は `0727880dff721c2a27dbf596013b32da838dc829526a1c5e0be0f3bbf90a523d`、VSIX は `80588f95d4c102528d0e77c5819505ee73055309ec1d2edef5611ce16da4250d`。

この試行の前に会話 B の入力直後に VS Code が落ちたとの申告があり、19:58（日本時間）に Code.exe のダンプが記録されていた。B のコマンドと応答の完了は公式の会話履歴から回収できた。クラッシュの原因は未特定。

同じウィンドウから2ファイルを同時に依頼した実機試験では、2つの Worker host が同時に存在し、下部パネルに `Worker inspect #2` と `Worker inspect #3` が並んだ。各1回送信し、個別のファイル名と応答が元の呼び出しに返り、両ホストは終了した。`forest.txt` の内容は要約と一致した。`harbor.txt` は Worker が読み取れなかったと回答し、内容確認は未達。公式 CLI の読み取り専用サンドボックスで同じファイルを直接確認した追試は成功した。モデルへの再送は0回。

試験後は複数ファイルの依頼例を追加したプラグインと、表示接続数の独自上限を外した VSIX を同じプロファイルに導入した。インストール先の Skill、CLI、ターミナル表示コードとビルド出力が一致。通常 VS Code の設定ファイルは導入前と同じで、試験用 Git の変更とプラグイン配下で稼働中の専用プロセスは各0件。最終導入物の SHA-256 はプラグイン ZIP が `46016693804c45385409d8caa211b7870c8241aa58d3de677891f5b0c0236b8b`、VSIX が `67c4876c864348c335b54677d7c017854328ed103053f5d6a947f165840e8b14`。

表示追加後の `npm run verify` はネイティブビルド、型検査、ビルド、配布関連47件を通過した。制御系452件のうち451件が合格し、既存のゲートウェイ試験 `peers_holding_connections_after_reply_do_not_crash_gateway` が20秒でタイムアウトしたため、一括コマンドは終了コード1。該当試験の単独再実行は4.6秒で合格し、後続の `npm run test:terminal` は38件すべて合格した。

### ツールシェルからの実測

2026-11-21、Windows x64 の開発作業用ツールシェルで、空白を含む使い捨て Git リポジトリから実行した。公式拡張 26.1117.41037 付属の `codex-cli 0.171.0-alpha.13` を使い、既存のサンドボックス設定を継承した。最初の試行は `sandboxExit=unknown` で終了した。隔離試験の子プロセスを Windows Job で管理する変更後、同じリポジトリ・設定で1回再測定した。

| 項目 | 元のシェルで得た結果 |
| --- | --- |
| 実行ファイル | host と Codex の SHA-256 を確認。再測定時の値は下の stdout に記録 |
| CLI の認証 | 同じ公式実行ファイルで `login status` が終了コード0を返し、ChatGPT ログイン表示を確認 |
| 物理的な隔離 | 再測定では canary 検査が30秒の制限に達し、専用 host が124、probe が1で終了。実行全体は33.586秒。隔離試験の Job 内のプロセスが0個になったことを確認 |
| Worker の認証・起動・停止 | 隔離で停止し、Worker の `account/read`、読み取り専用 `thread/start`、その Worker の Job の停止は未確認。両試行のモデル送信は計0回 |
| 既存設定と作業場所 | `config.toml` と VS Code の `settings.json` の指紋は実行前後で一致。試行後の `git status --porcelain` は0件 |

再測定時のシェル出力（1行目は probe、2行目は終了コード・経過時間・設定と Git の比較）を示す。

```jsonl
{"status":"failed","fixture":false,"turnsSent":0,"executable":"confirmed","cliChatgptLogin":"confirmed","chatgptAccount":"unconfirmed","filesystemIsolation":"unconfirmed","readOnlyThread":"unconfirmed","shutdown":"unconfirmed","failedAt":"read_only_isolation","hostSha256":"f60cf669e63d36794b40cf9e9008a83fa6f115b35d2d934c8972bba9c39a94ca","codexSha256":"0fc911eec975caaf723866face254a7cf1f789786859b2c6c4bacaa7b57a69a0","sandboxExit":"124","isolationJobStopped":true}
{"probeExit":1,"elapsedMs":33586,"settingsMatch":true,"worktreeChanges":0}
```

## 一度の実機セッションで確認する手順

### 1. 空白を含む作業場所を用意する

開発用 checkout で `npm run build:native`、`npm run build` を実行し、次の PowerShell で試験用フォルダーを作る。表示された probe の絶対パスを控える。あとでプラグインを試す際は配布物に入った起動スクリプトを使う。

```powershell
$probePath = (Resolve-Path -LiteralPath '.\dist\test\live\on-demand-probe.js').Path
$trialRoot = Join-Path ([IO.Path]::GetTempPath()) ('meristem sidebar ' + [guid]::NewGuid())
$trialRepo = Join-Path $trialRoot 'sidebar A B'
New-Item -ItemType Directory -Path $trialRepo | Out-Null
git -C $trialRepo init --quiet
$probePath
$trialRepo
```

試験用フォルダーを普段の VS Code で開き、同じフォルダーで公式サイドバーの会話 A と B を開く。公式拡張、Codex CLI、VS Code の版、通常のサンドボックスと承認設定を控える。Meristem の VSIX、管理ターミナル、専用 relay、グローバル MCP の追加操作は必要ない。

### 2. 出力の宛先と許可表示を調べる

下の `<probe の絶対パス>` を上で得た値に置き換える。それぞれの会話で「このコマンドをこのフォルダーのシェルで1回実行し、標準出力の JSON と実際の終了コードを同じ応答に返して」と依頼する。毎回違う短い識別子を使う。

```powershell
# 会話 A
node '<probe の絶対パス>' echo A-91 0
```

```powershell
# 会話 B
node '<probe の絶対パス>' echo B-44 7
```

呼び出し履歴の標準出力と終了記録を各応答に照合する。A には A の識別子と終了コード 0、B には B の識別子と意図的な終了コード 7 が表示される。両者の `repositoryId` は一致し、実行時に生成した `receipt` は異なる。相手側の receipt が届いていないことも確認する。シェルが途中で制御を返した場合は、その呼び出しの完了を同じ応答内で待てたか記録する。

A の同じシェルで次を1回実行する。probe は通常の認証で `account/read` を行い、`thread/start` で読み取り専用設定の応答を確認し、ターンを送らずに Job を停止する。実ファイルの検査には使い捨ての可視ファイルと管理領域の canary を用いる。

```powershell
node '<probe の絶対パス>' worker
```

`status`、実際の終了コード、両実行ファイルの SHA-256、CLI の `cliChatgptLogin`、Worker の `chatgptAccount`、`filesystemIsolation`、`readOnlyThread`、`shutdown` を残す。`processes` は今回の host と子の PID・生成時刻・Job ID を表す。成功した呼び出しを、同じ A でもう1回実行し、初回と2回目の許可表示の有無・対象を控える。拒否された場合は元の呼び出しの `failedAt` と、シェルが表示した拒否操作を記録し、その条件の判定を保留する。アカウントの識別情報・トークン・会話全文は記録に貼らない。

### 3. 明示依頼で Worker の結果が戻るか確かめる

1. 試行用リポジトリの `git status --porcelain` と HEAD（未コミットならその旨）、既存の Codex MCP／VS Code 設定の指紋、同名の marketplace・プラグインの登録状況を控える。初回導入用には未登録の環境を使う。試行に使う公式拡張と同じ版の Codex CLI を使い、展開した配布物の最上位フォルダーを `codex plugin marketplace add '<展開した最上位フォルダーの絶対パス>'`、続いて `codex plugin add meristem@meristem-local` で登録する。インストール後は新しいサイドバー会話で Skill の読込みを確認する。実際に必要だった再読込と許可操作を記録する。
2. 短い雑談を1往復する。会話のツール呼び出しを数え、Meristem 呼び出し0件を確認する。インストール前、雑談中、inspect 中、完了・取消後のプロセスを観測する。配布物の実行パス、起動した host とその子孫の PID・生成時刻で数える。短時間の起動を観測できない場合は、その区間の件数を未測定と記す。
3. 利用者の PowerShell で下のコマンドを実行する。値は会話に貼らない。現行の `inspect` の Worker は `gpt-6-luna / low`、ChatGPT 認証を使う。1呼び出しの実送信上限は1回。実機試行の送信枠を確保してから「Meristem で `sample.txt` を確認して。書かれている識別子を返して」と頼む。Coordinator のツール履歴で inspect 1回、直接のファイル読取り0回、同じ呼び出しの終了コード0を確認する。利用者があとでファイルを開いて値を照合し、元の応答への到着と別会話への配送0件を記録する。配信結果が不明なら送信済みとして数えて終了する。自動再送は0回。

```powershell
[IO.File]::WriteAllText((Join-Path $trialRepo 'sample.txt'), 'sample-' + [guid]::NewGuid().ToString('N'))
```

### 4. 計画の選択・編集権限と削除を確かめる

| サイドバーへの依頼 | 元の応答で確認する内容 |
| --- | --- |
| 「Meristem でこの計画を実装して」 | 選んだ工程表、明示指定を理由に呼んだ `run`、表示された対象・権限 |
| 独立した2件を含む「この計画を実装して」 | モデル自身が分担を選んだか、選択理由、同時実行するタスク |
| 1行の訂正 | 指定の1行を直接編集し、Meristem 呼び出し0回 |
| 相談だけ | 会話の回答と Meristem 呼び出し0回 |

現行の `run` は工程表を読み、編集経路の実機承認待ちを返す。初版の受入後、通常サイドバーで利用者本人が作業範囲・権限を確認できる経路を実装してから、ローカル bare Git を送信先にした別の試行で編集を検証する。並列2件の割当 → 報告 → 保存と検証 → 監査 → 統合を元の会話で追い、最終 SHA、Worker の停止、他会話への配送0件、結果不明時の重複割当・保存の有無を残す。[工程表の例](pre-p6-small-plan.md)

削除直前の試行用ファイル・コミットとその指紋を控える。削除の試験は `codex plugin remove meristem@meristem-local`、続いて試験で追加した marketplace に対して `codex plugin marketplace remove meristem-local` を使う。新しいサイドバー会話で Skill が消え、試行で動いた専用プロセスが0個であることを確認する。試行用ファイルとコミットは削除直前に、既存 MCP と VS Code 設定は導入前に控えた値と照合する。
