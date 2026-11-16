import net from 'node:net';

export function connect(pipe) {
  if (!/^meristem-cc00-[a-zA-Z0-9-]{1,100}$/.test(pipe)) throw Error('Invalid fixture pipe name');
  return new Promise((resolve, reject) => {
    const socket = net.connect('\\\\.\\pipe\\' + pipe);
    let buffer = '', seq = 0;
    const pending = new Map();
    socket.on('error', reject);
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 10 * 1024 * 1024) { socket.destroy(Error('management reply too large')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        let reply;
        try { reply = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(Error('invalid management reply')); return; }
        buffer = buffer.slice(end + 1);
        const p = pending.get(reply.id);
        if (p) { pending.delete(reply.id); p.resolve(reply); }
      }
    });
    socket.on('close', () => { for (const p of pending.values()) p.reject(Error('pipe closed; sent outcome unknown')); pending.clear(); });
    socket.on('connect', () => resolve({ socket, call(method, params = {}, id = ++seq) {
      return new Promise((resolve, reject) => {
        if (pending.has(id)) { reject(Error('duplicate outstanding client ID')); return; }
        const timer = setTimeout(() => { pending.delete(id); reject(Error('management timeout; sent outcome unknown')); }, 20000);
        pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
        socket.write(JSON.stringify({ id, method, params }) + '\n');
      });
    } }));
  });
}
