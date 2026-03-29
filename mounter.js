'use strict';

const net = require('net');
const path = require('path');
const readline = require('readline');
const fuse = require('fuse-bindings');
const { deriveKey, encrypt, decrypt } = require('./crypto-utils');

const RELAY_HOST = process.env.RELAY_HOST || '164.92.168.166';
const RELAY_PORT = parseInt(process.env.RELAY_PORT, 10) || 15240;
const AGENT_ID = process.env.AGENT_ID || 'pc1';
const MOUNT_POINT = process.env.MOUNT_POINT || 'Z:\\';

const key = deriveKey(
  path.join(__dirname, 'certs', 'client2.key'),
  path.join(__dirname, 'certs', 'server.crt'),
);

let socket = null;
let nextId = 1;
const pending = new Map();
let mounted = false;

function send(obj) {
  if (socket && !socket.destroyed) {
    socket.write(encrypt(key, JSON.stringify(obj)) + '\n');
  }
}

const REQUEST_TIMEOUT = 30000;

function request(op, reqPath, extra, cb) {
  const id = nextId++;
  const msg = { id, op, path: reqPath, ...extra };
  const timer = setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      cb(new Error('Request timed out'));
    }
  }, REQUEST_TIMEOUT);
  pending.set(id, (err, res) => {
    clearTimeout(timer);
    cb(err, res);
  });
  send(msg);
}

function handleResponse(msg) {
  if (msg.type === 'disconnect') {
    console.log('Agent disconnected');
    for (const [id, cb] of pending) {
      cb(new Error('Agent disconnected'));
    }
    pending.clear();
    doUnmountAndReconnect();
    return;
  }

  const { id } = msg;
  if (id == null) return;

  const cb = pending.get(id);
  if (!cb) return;
  pending.delete(id);

  if (msg.error) {
    cb(new Error(msg.error));
  } else {
    cb(null, msg);
  }
}

function fuseErrno(err) {
  if (!err) return 0;
  const msg = err.message || '';
  if (msg.includes('ENOENT') || msg.includes('no such file')) return fuse.ENOENT;
  if (msg.includes('EACCES') || msg.includes('permission')) return fuse.EACCES;
  if (msg.includes('ENOTDIR')) return fuse.ENOTDIR;
  return fuse.EIO;
}

function toFusePath(p) {
  return p.replace(/^\//, '').replace(/\//g, path.sep);
}

function mountFuse() {
  fuse.mount(MOUNT_POINT, {
    displayFolder: true,
    readdir(fusePath, cb) {
      request('readdir', toFusePath(fusePath), {}, (err, res) => {
        if (err) return cb(fuseErrno(err));
        cb(0, res.entries);
      });
    },
    getattr(fusePath, cb) {
      request('stat', toFusePath(fusePath), {}, (err, res) => {
        if (err) return cb(fuseErrno(err));
        const s = res.stat;
        cb(0, {
          mtime: new Date(s.mtime),
          atime: new Date(s.atime),
          ctime: new Date(s.mtime),
          nlink: s.nlink || 1,
          size: s.size,
          mode: s.isDirectory ? 16877 : 33188,
          uid: s.uid || process.getuid?.() || 0,
          gid: s.gid || process.getgid?.() || 0,
        });
      });
    },
    open(fusePath, flags, cb) {
      request('stat', toFusePath(fusePath), {}, (err, res) => {
        if (err) return cb(fuseErrno(err));
        cb(0, null);
      });
    },
    read(fusePath, fd, buf, len, pos, cb) {
      request('read', toFusePath(fusePath), { pos, len }, (err, res) => {
        if (err) return cb(fuseErrno(err));
        const data = Buffer.from(res.data, 'base64');
        data.copy(buf);
        cb(data.length);
      });
    },
  }, (err) => {
    if (err) {
      console.error('Mount error:', err.message);
      process.exit(1);
    }
    mounted = true;
    console.log(`Mounted at ${MOUNT_POINT}`);
  });
}

function doUnmount(cb) {
  if (!mounted) return cb?.();
  fuse.unmount(MOUNT_POINT, (err) => {
    if (err) console.error('Unmount error:', err.message);
    else console.log('Unmounted');
    mounted = false;
    cb?.();
  });
}

let reconnecting = false;
function doUnmountAndReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  doUnmount(() => {
    console.log('Reconnecting in 5s...');
    setTimeout(() => {
      reconnecting = false;
      connect();
    }, 5000);
  });
}

function connect() {
  socket = net.connect(RELAY_PORT, RELAY_HOST, () => {
    console.log('Connected to relay server');
    // Handshake is plaintext
    socket.write(JSON.stringify({ role: 'mounter', agentId: AGENT_ID }) + '\n');
    mountFuse();
  });

  const rl = readline.createInterface({ input: socket });
  rl.on('error', () => {});
  rl.on('line', (line) => {
    try {
      handleResponse(JSON.parse(decrypt(key, line)));
    } catch {}
  });

  socket.on('close', () => {
    console.log('Disconnected from relay');
    for (const [id, cb] of pending) {
      cb(new Error('Disconnected'));
    }
    pending.clear();
    doUnmountAndReconnect();
  });

  socket.on('error', (err) => {
    console.error('Connection error:', err.message);
  });
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  doUnmount(() => process.exit(0));
});

console.log(`Mounter starting. Agent=${AGENT_ID}, Mount=${MOUNT_POINT}`);
connect();
