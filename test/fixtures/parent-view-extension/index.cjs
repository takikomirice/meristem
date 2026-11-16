const vscode = require('vscode');
exports.activate = async (context) => {
  const thread = process.env.MERISTEM_CC02_PARENT_ID;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(thread ?? '')) return;
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(`openai-codex://route/local/${thread}`), 'chatgpt.conversationEditor');
  // Observe only the dedicated parent. Human UI actions remain manual.
  const viewLog = process.env.MERISTEM_CC03_VIEW_LOG;
  if (viewLog) {
    const fs = require('node:fs');
    const record = () => {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === `openai-codex://route/local/${thread}`);
      fs.appendFileSync(viewLog, JSON.stringify({ at: new Date().toISOString(), threadId: thread, state: tabs.some(tab => tab.isActive) ? 'visible' : tabs.length ? 'hidden' : 'closed', windowFocused: vscode.window.state.focused }) + '\n');
    };
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(record), vscode.window.tabGroups.onDidChangeTabGroups(record), vscode.window.onDidChangeWindowState(record));
    record();
  }
  // Explicit live-test setup only: open the production managed terminal command
  // with its chosen discovery file, avoiding a platform file-picker dependency.
  const discovery = process.env.MERISTEM_CC02_DISCOVERY;
  if (discovery) {
    const fs = require('node:fs');
    for (let i = 0; i < 120 && !fs.existsSync(discovery); i++) await new Promise(resolve => setTimeout(resolve, 500));
    if (fs.existsSync(discovery)) await vscode.commands.executeCommand('meristem.chatControl.openManaged', vscode.Uri.file(discovery));
  }
};
