# P6前の小さな工程表の例

表示用の文字列を作る小さなNode.jsリポジトリを使う。ラベルと状態の実装は、別のファイルを担当するので並列に進められる。両方が統合された後に、読み取り専用Workerが仕様を確認する。Coordinatorが監査を受理すると、二つを組み合わせる表示の実装に進む。これは工程表の一例で、作業対象やタスク数は任意。

## 準備

1. 試験用のGitリポジトリ、空の作業ツリー用ディレクトリ、ローカルbareリポジトリを用意する。試験用リポジトリの `origin` にbareリポジトリの絶対パスを設定する。下記のチェックを `checks.mjs` として保存し、初期コミットに含める。
2. この工程表を試験用にコピーし、YAMLの `repository` と `worktrees_root` を実際の絶対パスに変更する。既存と重ならない非保護の統合ブランチ名を選び、試験環境で選べるモデルと推論設定を使う。
3. 開始時の許可に `workspace` と `read-only` を含める。同時に2人起動できる設定と利用枠で、[P6前の実装計画](../../superpowers/plans/2026-11-20-meristem-pre-p6.md)の変更を組み込んだ管理対象のCLIまたはVS Codeから開始する。

## タスク指示

| タスク | 作業と必須検証 |
| --- | --- |
| `label` | `src/label.mjs` に `formatLabel(value)` を実装。前後の空白を除き、空なら `(untitled)` を返す。`node checks.mjs label` を実行し、検証名 `label` で報告する。 |
| `status` | `src/status.mjs` に `formatStatus(done)` を実装。真なら `done`、偽なら `pending` を返す。`node checks.mjs status` を実行し、検証名 `status` で報告する。 |
| `audit` | Coordinatorが示した統合済みコミットで二つの関数と仕様を照合し、`node checks.mjs audit` を実行する。検証名 `audit` と対象コミット、判断理由を報告する。 |
| `entry` | `src/entry.mjs` に `formatEntry(label, done)` を実装。先の二つの関数を呼び、`Ada [done]` のような文字列を返す。`node checks.mjs entry` を実行し、検証名 `entry` で報告する。 |

作業担当は実施した作業とチェックの成否をCoordinatorへ報告する。監査対象のSHAはCoordinatorが監査の指示に含める。共有の進捗欄はCoordinatorが受理結果を反映する。

## 試験用のチェック

以下を試験用リポジトリのルートに `checks.mjs` として保存する。Node.jsの標準機能で実行できる。

```javascript
import assert from 'node:assert/strict';

async function checkLabel() {
  const { formatLabel } = await import('./src/label.mjs');
  assert.equal(formatLabel('  Ada  '), 'Ada');
  assert.equal(formatLabel('  '), '(untitled)');
}

async function checkStatus() {
  const { formatStatus } = await import('./src/status.mjs');
  assert.equal(formatStatus(true), 'done');
  assert.equal(formatStatus(false), 'pending');
}

async function checkAudit() {
  await checkLabel();
  await checkStatus();
}

async function checkEntry() {
  const { formatEntry } = await import('./src/entry.mjs');
  assert.equal(formatEntry('  Ada  ', true), 'Ada [done]');
  assert.equal(formatEntry('  ', false), '(untitled) [pending]');
}

const checks = new Map([
  ['label', checkLabel],
  ['status', checkStatus],
  ['audit', checkAudit],
  ['entry', checkEntry],
]);

const requested = process.argv.slice(2);
assert.ok(requested.length, 'specify at least one check');
for (const name of requested) {
  const check = checks.get(name);
  assert.ok(check, 'unknown check: ' + name);
  await check();
  console.log('passed: ' + name);
}
```

## 確認する結果

- 実行開始後、`label` と `status` がどちらも着手可能で、同時に起動する。先に一方の候補を受理しても `audit` は待機する。
- 通常の保存はCoordinatorが行う。追加のGit承認が出ず、固定したローカル送信先から候補SHAを読み戻せる。最初の統合は `label` と `status` の二候補をまとめて取り込み、`node checks.mjs label status audit` を実行して、二つの必須検証と統合後の `integration` を同じSHAに紐付けて記録する。
- 両方の実装が統合された後に `audit` が始まる。対象SHAの監査をCoordinatorが受理すると `entry` が始まる。監査失敗の試験では `entry` は待機する。
- 最終統合で `node checks.mjs label status audit entry` が成功する。全タスクの検証と `integration` を最終SHAに紐付ける。開始後の「次へ」の手入力が0件で、工程表の進捗欄、最終SHA、Workerの終了結果が揃う。

<!-- chat-control:plan:start -->
schema_version: 2
run:
  repository: 'C:/meristem-test/pre-p6/repository'
  worktrees_root: 'C:/meristem-test/pre-p6/worktrees'
  integration_branch: meristem-pre-p6-integration
  max_parallel: 2
tasks:
  - id: label
    display_name: 表示ラベル
    depends_on: []
    scope: [src/label.mjs]
    conflicts_with: []
    agent: {model: gpt-6.2-sol, effort: medium, permissionProfileId: workspace}
    continuation: {mode: new}
    completion: [label]
  - id: status
    display_name: 状態表示
    depends_on: []
    scope: [src/status.mjs]
    conflicts_with: []
    agent: {model: gpt-6.2-sol, effort: medium, permissionProfileId: workspace}
    continuation: {mode: new}
    completion: [status]
  - id: audit
    display_name: 統合済みの二機能を監査
    depends_on: [label, status]
    scope: [src/label.mjs, src/status.mjs]
    conflicts_with: []
    agent: {model: gpt-6.2-sol, effort: medium, permissionProfileId: read-only}
    continuation: {mode: new}
    completion: [audit]
  - id: entry
    display_name: 一覧用の表示
    depends_on: [audit]
    scope: [src/entry.mjs]
    conflicts_with: []
    agent: {model: gpt-6.2-sol, effort: medium, permissionProfileId: workspace}
    continuation: {mode: new}
    completion: [entry]
<!-- chat-control:plan:end -->

<!-- chat-control:progress:start -->
<!-- chat-control:progress:end -->
