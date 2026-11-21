import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { localPath } from './install.js';

type InspectState = 'starting' | 'running' | 'completed' | 'failed';
const execute = promisify(execFile);

export function connectInspectDisplay(directory: string, ownerPid: string): Socket | undefined {
  if (!/^[1-9][0-9]{0,9}$/.test(ownerPid)) return;
  const descriptor = path.join(directory, ownerPid + '.txt');
  localPath(descriptor);
  const file = lstatSync(descriptor, { throwIfNoEntry: false });
  if (!file?.isFile() || file.size !== 36) return;
  const nonce = readFileSync(descriptor, 'utf8');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) return;
  const socket = createConnection('\\\\.\\pipe\\meristem-inspect-display-' + nonce);
  socket.setTimeout(1000, () => socket.destroy());
  socket.once('connect', () => socket.setTimeout(0));
  socket.once('error', () => socket.destroy());
  // This socket carries display events in one direction. It cannot drive the Worker.
  socket.once('data', () => socket.destroy());
  return socket;
}

async function findDisplay(hostExe: string, realExe: string) {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local || !/^[a-z]:[\\/]/i.test(local)) return;
  const directory = path.join(local, 'Meristem', 'inspect-display');
  if (!existsSync(directory)) return;
  const { stdout } = await execute(hostExe, ['--display-owner', realExe], { windowsHide: true, timeout: 1000, maxBuffer: 4096 });
  return connectInspectDisplay(directory, stdout.trim());
}

export function inspectDisplay(hostExe: string, realExe: string) {
  // Worker startup runs independently of this optional UI, including an absent
  // extension, an old helper, a closed terminal or a disappearing VS Code window.
  const display = findDisplay(hostExe, realExe).catch(() => undefined);
  return (state: InspectState) => {
    void display.then(socket => {
      if (!socket || socket.destroyed) return;
      if (state === 'completed' || state === 'failed') {
        socket.end(state + '\n', () => socket.destroy());
      } else {
        socket.write(state + '\n');
      }
    }).catch(() => {});
  };
}
