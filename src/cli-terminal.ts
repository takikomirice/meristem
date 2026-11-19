import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function startCliTerminal(helper: string, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(helper, [executable, ...args], { cwd, env, stdio: 'pipe', windowsHide: true });
  child.stdout.resume();
  const metadata = createInterface({ input: child.stderr });
  const identity = new Promise<{ pid: number; created: string }>((resolve, reject) => {
    const fail = () => reject(new Error('公式TUIの起動を確認できません。'));
    child.once('error', fail);
    metadata.once('close', fail);
    metadata.once('line', line => {
      try {
        const parsed = JSON.parse(line);
        if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.created !== 'string' || !/^\d+$/.test(parsed.created)) return fail();
        resolve({ pid: parsed.pid, created: parsed.created });
      } catch { fail(); }
    });
  });
  return { process: child, identity, close: () => child.stdin.end() };
}
