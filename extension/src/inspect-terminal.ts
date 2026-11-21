import type * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';

const messages = {
  starting: '読み取り専用 Worker を起動しています。',
  running: 'Worker がファイルを確認しています。',
  completed: 'Worker の終了を確認しました。結果は依頼元のチャットに表示されます。',
  failed: '検査を完了できませんでした。詳細は依頼元のチャットで確認してください。'
};

// The socket carries fixed lifecycle labels only. Terminal input never reaches inspect.
export function showInspection(api: typeof vscode, socket: Socket, number: () => number) {
  let terminal: vscode.Terminal | undefined, ready = false, finished = false, running = false;
  let partial = '';
  const pending: string[] = [];
  const output = new api.EventEmitter<string>();
  function print(message: string) {
    const line = message + '\r\n';
    if (ready) output.fire(line);
    else pending.push(line);
  }
  function state(value: string) {
    if (finished) return;
    if (!terminal) {
      if (value !== 'starting') { socket.destroy(); return; }
      terminal = api.window.createTerminal({
        name: 'Worker inspect #' + number(), isTransient: true,
        pty: {
          onDidWrite: output.event,
          open() { ready = true; for (const line of pending.splice(0)) output.fire(line); },
          close() { finished = true; socket.destroy(); output.dispose(); }
        }
      });
      print(messages.starting);
      terminal.show(true);
    } else if (value === 'running' && !running) {
      running = true;
      print(messages.running);
    } else if (value === 'completed' || value === 'failed') {
      finished = true;
      print(messages[value]);
      socket.end();
    } else socket.destroy();
  }
  socket.setTimeout(2000, () => socket.destroy());
  socket.on('data', (data: Buffer) => {
    if (partial.length + data.length > 128) { socket.destroy(); return; }
    const lines = (partial + data.toString('latin1')).split('\n');
    partial = lines.pop()!;
    for (const line of lines) { if (socket.destroyed) break; state(line); }
    if (terminal && !finished) socket.setTimeout(660_000);
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    if (terminal && !finished) print('表示接続が切れました。実行結果は依頼元のチャットで確認してください。');
    if (!terminal) output.dispose();
  });
}

export function listenForInspections(api: typeof vscode, localAppData: string): vscode.Disposable {
  const directory = path.join(localAppData, 'Meristem', 'inspect-display');
  const descriptor = path.join(directory, process.pid + '.txt');
  const id = randomUUID();
  const sockets = new Set<Socket>();
  let sequence = 0, disposed = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    showInspection(api, socket, () => ++sequence);
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const socket of sockets) socket.destroy();
    server.close();
    try { if (readFileSync(descriptor, 'utf8') === id) rmSync(descriptor); } catch { /* absent or replaced */ }
  }
  server.on('error', dispose);
  server.listen('\\\\.\\pipe\\meristem-inspect-display-' + id, () => {
    if (disposed) return;
    const temporary = descriptor + '.' + id;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temporary, id, { flag: 'wx' });
      renameSync(temporary, descriptor);
    } catch {
      dispose();
    } finally {
      try { rmSync(temporary, { force: true }); } catch { /* display is optional */ }
    }
  });
  return { dispose };
}
