'use strict';

const net = require('net');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { deriveKey, encrypt, decrypt, keyFingerprint } = require('./crypto-utils');

const RELAY_HOST = process.env.RELAY_HOST || '164.92.168.166';
const RELAY_PORT = parseInt(process.env.RELAY_PORT, 10) || 15240;
const AGENT_ID = process.env.AGENT_ID || 'pc1';
const ROOT = path.resolve(process.env.AGENT_ROOT || 'C:\\Users\\Stepa');

const key = deriveKey(
  path.join(__dirname, 'certs', 'client1.key'),
  path.join(__dirname, 'certs', 'server.crt'),
);

function connect() {
  const socket = net.connect(RELAY_PORT, RELAY_HOST, () => {
    console.log('Connected to relay server');
    // Handshake is plaintext
    socket.write(JSON.stringify({ role: 'agent', id: AGENT_ID }) + '\n');
  });

  const rl = readline.createInterface({ input: socket });
  rl.on('error', () => {});

  rl.on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(decrypt(key, line));
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
        send(socket, { id, error: 'Path traversal denied' });
        return;
      }

      switch (op) {
        case 'readdir': {
          const entries = await fsp.readdir(resolved);
          send(socket, { id, entries });
          break;
        }
        case 'stat': {
          const st = await fsp.stat(resolved);
          send(socket, {
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
            send(socket, {
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
          send(socket, { id, error: `Unknown op: ${op}` });
      }
    } catch (err) {
      send(socket, { id, error: err.message });
    }
  });

  socket.on('close', () => {
    console.log('Disconnected from relay. Reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  socket.on('error', (err) => {
    console.error('Connection error:', err.code || err.message, err);
  });
}

function send(socket, obj) {
  if (!socket.destroyed) {
    socket.write(encrypt(key, JSON.stringify(obj)) + '\n');
  }
}

console.log(`Agent starting. ROOT=${ROOT}, ID=${AGENT_ID}, key=${keyFingerprint(key)}`);
connect();
