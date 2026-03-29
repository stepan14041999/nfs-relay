'use strict';

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const fuse = require('fuse-bindings');

const RELAY_HOST = process.env.RELAY_HOST || 'localhost';
const RELAY_PORT = parseInt(process.env.RELAY_PORT, 10) || 8443;
const AGENT_ID = process.env.AGENT_ID || 'pc1';
const MOUNT_POINT = process.env.MOUNT_POINT || 'Z:\\';

const clientOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'client2.key')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'client2.crt')),
  ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
  rejectUnauthorized: true,
  minVersion: 'TLSv1.3',
  ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
};

let socket = null;
let nextId = 1;
const pending = new Map(); // id → callback(err, result)
let mounted = false;

function send(obj) {
  if (socket && !socket.destroyed) {
    socket.write(JSON.stringify(obj) + '\n');
  }
}

function request(op, reqPath, extra, cb) {
  const id = nextId++;
  const msg = { id, op, path: reqPath, ...extra };
  pending.set(id, cb);
  send(msg);
}

function handleResponse(msg) {
  if (msg.type === 'disconnect') {
    console.log('Agent disconnected');
    // Reject all pending requests
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
  // FUSE paths come as /foo/bar, convert to relative
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
          mode: s.isDirectory ? 16877 : 33188, // drwxr-xr-x : -rw-r--r--
          uid: s.uid || process.getuid?.() || 0,
          gid: s.gid || process.getgid?.() || 0,
        });
      });
    },
    open(fusePath, flags, cb) {
      // Validate file exists via stat
      request('stat', toFusePath(fusePath), {}, (err, res) => {
        if (err) return cb(fuseErrno(err));
        cb(0, null); // no file descriptor needed — stateless reads
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

function doUnmountAndReconnect() {
  doUnmount(() => {
    console.log('Reconnecting in 5s...');
    setTimeout(connect, 5000);
  });
}

function connect() {
  socket = tls.connect(RELAY_PORT, RELAY_HOST, clientOptions, () => {
    console.log('Connected to relay server');
    send({ role: 'mounter', agentId: AGENT_ID });
    mountFuse();
  });

  const rl = readline.createInterface({ input: socket });
  rl.on('line', (line) => {
    try {
      handleResponse(JSON.parse(line));
    } catch {}
  });

  socket.on('close', () => {
    console.log('Disconnected from relay');
    // Reject all pending
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  doUnmount(() => process.exit(0));
});

console.log(`Mounter starting. Agent=${AGENT_ID}, Mount=${MOUNT_POINT}`);
connect();
