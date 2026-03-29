'use strict';

const fsp = require('fs/promises');
const path = require('path');
const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 'wss://cdn.overlewd.com/nfrnc';
const AGENT_ID = process.env.AGENT_ID || 'pc1';
const ROOT = path.resolve(process.env.AGENT_ROOT || 'C:\\Users\\Stepa');

function connect() {
  const ws = new WebSocket(RELAY_URL);

  ws.on('open', () => {
    console.log('Connected to relay');
    ws.send(JSON.stringify({ role: 'agent', id: AGENT_ID }));
  });

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'disconnect') {
      console.log('Mounter disconnected');
      return;
    }

    const { id, op, path: reqPath } = msg;
    if (id == null || !op) return;

    try {
      const resolved = path.resolve(ROOT, reqPath || '');
      if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
        send(ws, { id, error: 'Path traversal denied' });
        return;
      }

      switch (op) {
        case 'readdir': {
          const entries = await fsp.readdir(resolved);
          send(ws, { id, entries });
          break;
        }
        case 'stat': {
          const st = await fsp.stat(resolved);
          send(ws, {
            id,
            stat: {
              size: st.size,
              mode: st.mode,
              mtime: st.mtimeMs,
              atime: st.atimeMs,
              nlink: st.nlink,
              uid: st.uid,
              gid: st.gid,
              isDirectory: st.isDirectory(),
            },
          });
          break;
        }
        case 'read': {
          const MAX_READ_LEN = 4 * 1024 * 1024;
          const { pos } = msg;
          const len = Math.min(msg.len, MAX_READ_LEN);
          const fh = await fsp.open(resolved, 'r');
          try {
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, pos);
            send(ws, {
              id,
              data: buf.slice(0, bytesRead).toString('base64'),
              pos,
              len: bytesRead,
            });
          } finally {
            await fh.close();
          }
          break;
        }
        default:
          send(ws, { id, error: `Unknown op: ${op}` });
      }
    } catch (err) {
      send(ws, { id, error: err.message });
    }
  });

  ws.on('close', () => {
    console.log('Disconnected. Reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('Connection error:', err.code || err.message);
  });
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

console.log(`Agent starting. ROOT=${ROOT}, ID=${AGENT_ID}`);
connect();
