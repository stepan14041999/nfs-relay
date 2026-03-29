'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const fuse = require('fuse-bindings');

const RELAY_HOST = process.env.RELAY_HOST || 'cdn.overlewd.com';
const RELAY_PORT = parseInt(process.env.RELAY_PORT, 10) || 8443;
const RELAY_PATH = process.env.RELAY_PATH || '/nrscn';
const AGENT_ID = process.env.AGENT_ID || 'pc1';
const MOUNT_POINT = process.env.MOUNT_POINT || 'Z:\\';

const tlsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'client2.key')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'client2.crt')),
  ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
  rejectUnauthorized: true,
  minVersion: 'TLSv1.3',
  ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
};

let ws = null;
let nextId = 1;
const pending = new Map();
let mounted = false;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
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
  const url = `wss://${RELAY_HOST}:${RELAY_PORT}${RELAY_PATH}`;
  ws = new WebSocket(url, { ...tlsOptions });

  ws.on('open', () => {
    console.log('Connected to relay server');
    send({ role: 'mounter', agentId: AGENT_ID });
    mountFuse();
  });

  ws.on('message', (data) => {
    try {
      handleResponse(JSON.parse(data.toString()));
    } catch {}
  });

  ws.on('close', () => {
    console.log('Disconnected from relay');
    for (const [id, cb] of pending) {
      cb(new Error('Disconnected'));
    }
    pending.clear();
    doUnmountAndReconnect();
  });

  ws.on('error', (err) => {
    console.error('Connection error:', err.message);
  });
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  doUnmount(() => process.exit(0));
});

console.log(`Mounter starting. Agent=${AGENT_ID}, Mount=${MOUNT_POINT}`);
connect();
