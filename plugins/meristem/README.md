# Meristem for Codex on Windows x64

ZIP を新しいフォルダーに展開し、`.agents` と `plugins` があるフォルダーを開きます。次の PowerShell コマンドで、そのフォルダーをローカルカタログとして追加し、Meristem をインストールします。展開先は登録中も保持してください。

Extract the ZIP into a new directory. Run these commands from the directory containing `.agents` and `plugins`, and keep that directory in place while its marketplace is registered.

```powershell
codex plugin marketplace add .
codex plugin add meristem@meristem-local
codex plugin list --marketplace meristem-local --json
```

`codex` をシェルから直接起動できない場合は、公式 VS Code 拡張に同梱された `codex.exe` の絶対パスを PowerShell の `&` で呼び出します。If the shell cannot find `codex`, invoke the installed official extension’s `codex.exe` by its absolute path using PowerShell's `&`. Node.js and the Meristem Worker host are bundled.

Git リポジトリでの確認例は「Meristem で src/example.ts を確認して」です。`inspect` は読み取り専用 Worker 1人を利用するため、公式 Codex の ChatGPT ログインと利用可能なモデル枠が必要です。工程表に対する `run` は権限確認を伴う編集が利用可能になるまで検証結果のみを返します。

For a Git workspace, try “Use Meristem to inspect src/example.ts.” Inspection uses one read-only Worker and requires a ChatGPT login and available model usage. Plan validation currently reports the preview and leaves Worker editing disabled.

通常のサイドバーで実モデルから同じ会話に結果が戻るかは手動受入の対象です。The live round trip from the ordinary sidebar still needs manual validation.

## 削除 / Uninstall

```powershell
codex plugin remove meristem@meristem-local
codex plugin marketplace remove meristem-local
```

展開先の `plugins/meristem/runtime/LICENSE` と `plugins/meristem/runtime/THIRD_PARTY_NOTICES.md` にライセンスを収録しています。These files contain the project license and third-party notices.
