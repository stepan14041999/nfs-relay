# Relay File Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a three-component relay system that lets a Windows machine mount another Windows machine's filesystem as a local drive via TLS-secured relay.

**Architecture:** Agent on Client 1 serves local files over TLS/NDJSON. Relay server forwards packets between agent and mounter by matching IDs. Mounter on Client 2 presents the remote files as a FUSE-mounted drive letter.

**Tech Stack:** Node.js 18+, native `tls`/`fs`/`readline` modules, `fuse-bindings` npm package, WinFsp, OpenSSL for certs.

---

### Task 1: Project Scaffolding — package.json

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "nfs-relay",
  "version": "1.0.0",
  "description": "Relay File Agent — access remote Windows filesystem via TLS relay and FUSE mount",
  "private": true,
  "scripts": {
    "server": "node relay-server.js",
    "agent": "node agent.js",
    "mounter": "node mounter.js",
    "certs": "bash gen-certs.sh"
  },
  "dependencies": {
    "fuse-bindings": "^3.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated, `fuse-bindings` installed.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add package.json with fuse-bindings dependency"
```

---

### Task 2: Certificate Generation Script — gen-certs.sh

**Files:**
- Create: `gen-certs.sh`

- [ ] **Step 1: Create gen-certs.sh**

This script generates a self-signed CA, then signs three certificate pairs (server, client1, client2). All output goes to `certs/`.

```bash
#!/usr/bin/env bash
set -euo pipefail

DIR="certs"
rm -rf "$DIR"
mkdir -p "$DIR"

# CA
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
  -days 3650 -nodes -keyout "$DIR/ca.key" -out "$DIR/ca.crt" \
  -subj "/CN=NFS-Relay CA"

# Function: generate key + CSR, sign with CA
gen_cert() {
  local name="$1" cn="$2"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -nodes -keyout "$DIR/${name}.key" -out "$DIR/${name}.csr" \
    -subj "/CN=${cn}"
  openssl x509 -req -in "$DIR/${name}.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
    -CAcreateserial -out "$DIR/${name}.crt" -days 3650
  rm -f "$DIR/${name}.csr"
}

gen_cert "server"  "relay-server"
gen_cert "client1" "agent"
gen_cert "client2" "mounter"

rm -f "$DIR/ca.srl"
echo "Certificates generated in $DIR/"
```

- [ ] **Step 2: Make executable and run**

Run: `chmod +x gen-certs.sh && bash gen-certs.sh`
Expected: `certs/` directory with `ca.crt`, `ca.key`, `server.crt`, `server.key`, `client1.crt`, `client1.key`, `client2.crt`, `client2.key`.

- [ ] **Step 3: Verify certs were created**

Run: `ls certs/`
Expected: 7 files — `ca.crt`, `ca.key`, `server.crt`, `server.key`, `client1.crt`, `client1.key`, `client2.crt`, `client2.key`.

- [ ] **Step 4: Commit**

```bash
git add gen-certs.sh
git commit -m "feat: add certificate generation script for mTLS"
```

Note: Do NOT commit `certs/` — these are generated artifacts. A `.gitignore` entry will be added with README.

---

### Task 3: Relay Server — relay-server.js

**Files:**
- Create: `relay-server.js`

- [ ] **Step 1: Create relay-server.js**

The relay server is a TLS 1.3 server that:
1. Accepts connections, reads the first NDJSON line to identify role (agent or mounter)
2. Registers agents by their `id` and mounters by their `agentId`
3. Forwards all subsequent lines between matched agent↔mounter pairs
4. Sends `{"type":"disconnect"}` when one side drops

```javascript
'use strict';

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PORT = parseInt(process.env.RELAY_PORT, 10) || 8443;

const agents = new Map();   // id → socket
const mounters = new Map(); // agentId → socket

const serverOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'server.key')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'server.crt')),
  ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.3',
  ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
};

const server = tls.createServer(serverOptions, (socket) => {
  let identified = false;
  let role = null;
  let peerId = null;

  const rl = readline.createInterface({ input: socket });

  rl.on('line', (line) => {
    if (!identified) {
      identified = true;
      try {
        const msg = JSON.parse(line);
        if (msg.role === 'agent' && msg.id) {
          role = 'agent';
          peerId = msg.id;
          agents.set(peerId, socket);
          console.log(`Agent registered: ${peerId}`);

          // If a mounter is already waiting for this agent, notify nothing special —
          // packets will just start flowing.
        } else if (msg.role === 'mounter' && msg.agentId) {
          role = 'mounter';
          peerId = msg.agentId;
          mounters.set(peerId, socket);
          console.log(`Mounter registered for agent: ${peerId}`);
        } else {
          console.error('Invalid handshake:', line);
          socket.destroy();
        }
      } catch (e) {
        console.error('Handshake parse error:', e.message);
        socket.destroy();
      }
      return;
    }

    // Forward to the other side
    if (role === 'mounter') {
      const agentSocket = agents.get(peerId);
      if (agentSocket && !agentSocket.destroyed) {
        agentSocket.write(line + '\n');
      }
    } else if (role === 'agent') {
      const mounterSocket = mounters.get(peerId);
      if (mounterSocket && !mounterSocket.destroyed) {
        mounterSocket.write(line + '\n');
      }
    }
  });

  const cleanup = () => {
    if (!role || !peerId) return;

    if (role === 'agent') {
      agents.delete(peerId);
      console.log(`Agent disconnected: ${peerId}`);
      const mounterSocket = mounters.get(peerId);
      if (mounterSocket && !mounterSocket.destroyed) {
        mounterSocket.write(JSON.stringify({ type: 'disconnect' }) + '\n');
      }
    } else if (role === 'mounter') {
      mounters.delete(peerId);
      console.log(`Mounter disconnected for agent: ${peerId}`);
      const agentSocket = agents.get(peerId);
      if (agentSocket && !agentSocket.destroyed) {
        agentSocket.write(JSON.stringify({ type: 'disconnect' }) + '\n');
      }
    }
  };

  socket.on('close', cleanup);
  socket.on('error', (err) => {
    console.error(`Socket error (${role}/${peerId}):`, err.message);
    cleanup();
  });
});

server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
```

- [ ] **Step 2: Smoke test — start the server**

Run: `node relay-server.js`
Expected: `Relay server listening on port 8443` (requires certs to exist — run gen-certs.sh first if not done).
Stop with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add relay-server.js
git commit -m "feat: add TLS relay server with agent/mounter forwarding"
```

---

### Task 4: Agent — agent.js

**Files:**
- Create: `agent.js`

- [ ] **Step 1: Create agent.js**

The agent connects to the relay, registers itself, and responds to filesystem requests (`readdir`, `stat`, `read`). It validates all paths against `AGENT_ROOT` to prevent traversal.

```javascript
'use strict';

const tls = require('tls');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const RELAY_HOST = process.env.RELAY_HOST || 'localhost';
const RELAY_PORT = parseInt(process.env.RELAY_PORT, 10) || 8443;
const AGENT_ID = process.env.AGENT_ID || 'pc1';
const ROOT = path.resolve(process.env.AGENT_ROOT || 'C:\\Users\\Stepa');

const clientOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'client1.key')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'client1.crt')),
  ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
  rejectUnauthorized: true,
  minVersion: 'TLSv1.3',
  ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
};

function connect() {
  const socket = tls.connect(RELAY_PORT, RELAY_HOST, clientOptions, () => {
    console.log('Connected to relay server');
    socket.write(JSON.stringify({ role: 'agent', id: AGENT_ID }) + '\n');
  });

  const rl = readline.createInterface({ input: socket });

  rl.on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
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
      if (!resolved.startsWith(ROOT)) {
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
          const { pos, len } = msg;
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
    console.error('Connection error:', err.message);
  });
}

function send(socket, obj) {
  if (!socket.destroyed) {
    socket.write(JSON.stringify(obj) + '\n');
  }
}

console.log(`Agent starting. ROOT=${ROOT}, ID=${AGENT_ID}`);
connect();
```

- [ ] **Step 2: Smoke test — start agent (will fail without relay running, that's expected)**

Run: `node agent.js`
Expected: `Agent starting. ROOT=C:\Users\Stepa, ID=pc1` followed by a connection error and reconnect message. Stop with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add agent.js
git commit -m "feat: add filesystem agent with readdir/stat/read and path traversal protection"
```

---

### Task 5: Mounter — mounter.js

**Files:**
- Create: `mounter.js`

- [ ] **Step 1: Create mounter.js**

The mounter connects to the relay, then mounts a FUSE filesystem. Each FUSE callback sends a request through the relay and waits for the response via a pending-requests map.

```javascript
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
```

- [ ] **Step 2: Verify syntax**

Run: `node -c mounter.js`
Expected: No output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add mounter.js
git commit -m "feat: add FUSE mounter with relay-backed readdir/stat/read"
```

---

### Task 6: .gitignore

**Files:**
- Create: `.gitignore`

- [ ] **Step 1: Create .gitignore**

```
node_modules/
certs/
.idea/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore for node_modules, certs, .idea"
```

---

### Task 7: README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

````markdown
# NFS Relay

Access a Windows machine's filesystem from another Windows machine through a TLS relay server.

## Architecture

```
[Agent (Client 1)] <--TLS 1.3--> [Relay Server] <--TLS 1.3--> [Mounter (Client 2)]
```

## Prerequisites

- **Node.js 18+**
- **OpenSSL** (for certificate generation)
- **WinFsp** (on the mounter machine) — download from https://winfsp.dev

## Setup

### 1. Generate certificates

```bash
bash gen-certs.sh
```

Copy the `certs/` folder to all three machines. Each machine needs:
- `ca.crt` (all)
- `server.crt` + `server.key` (relay server)
- `client1.crt` + `client1.key` (agent)
- `client2.crt` + `client2.key` (mounter)

### 2. Install dependencies

```bash
npm install
```

### 3. Start relay server

```bash
# On the relay server machine
RELAY_PORT=8443 node relay-server.js
```

### 4. Start agent

```bash
# On Windows Client 1 (the machine sharing files)
set RELAY_HOST=relay.example.com
set RELAY_PORT=8443
set AGENT_ID=pc1
set AGENT_ROOT=C:\Users\Stepa
node agent.js
```

### 5. Start mounter

```bash
# On Windows Client 2 (the machine mounting remote files)
set RELAY_HOST=relay.example.com
set RELAY_PORT=8443
set AGENT_ID=pc1
set MOUNT_POINT=Z:\
node mounter.js
```

The remote filesystem will appear at `Z:\`.

## Environment Variables

| Variable | Default | Component | Description |
|---|---|---|---|
| `RELAY_HOST` | `localhost` | agent, mounter | Relay server hostname |
| `RELAY_PORT` | `8443` | all | Relay server port |
| `AGENT_ID` | `pc1` | agent, mounter | Agent identifier |
| `AGENT_ROOT` | `C:\Users\Stepa` | agent | Root directory to share |
| `MOUNT_POINT` | `Z:\` | mounter | Drive letter to mount |

## Security

- TLS 1.3 with mutual authentication (mTLS)
- Ciphers: `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`
- Path traversal protection on agent side
- All certificates signed by a shared CA
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup instructions"
```

---

### Task 8: Integration Test — Manual End-to-End

This task is a manual verification checklist, not automated tests. Run on a single machine with localhost.

- [ ] **Step 1: Generate certs**

Run: `bash gen-certs.sh`

- [ ] **Step 2: Start relay in terminal 1**

Run: `node relay-server.js`
Expected: `Relay server listening on port 8443`

- [ ] **Step 3: Start agent in terminal 2**

Run: `node agent.js`
Expected: `Agent starting. ROOT=C:\Users\Stepa, ID=pc1` then `Connected to relay server`

- [ ] **Step 4: Verify relay logs agent connection**

Expected in terminal 1: `Agent registered: pc1`

- [ ] **Step 5: Start mounter in terminal 3 (requires WinFsp installed)**

Run: `node mounter.js`
Expected: `Mounter starting. Agent=pc1, Mount=Z:\` then `Connected to relay server` then `Mounted at Z:\`

- [ ] **Step 6: Browse Z:\ in Explorer or terminal**

Run: `ls Z:/` or `dir Z:\`
Expected: Contents of `C:\Users\Stepa` appear.

- [ ] **Step 7: Read a file**

Run: `cat Z:/some-file.txt` (pick any small file in AGENT_ROOT)
Expected: File contents displayed.
