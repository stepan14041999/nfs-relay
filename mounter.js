'use strict';

const net = require('net');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { deriveKey, encrypt, decrypt, keyFingerprint } = require('./crypto-utils');

const RELAY_HOST = process.env.RELAY_HOST || '164.92.168.166';
const RELAY_PORT = parseInt(process.env.RELAY_PORT, 10) || 15240;
const AGENT_ID = process.env.AGENT_ID || 'pc1';
const MOUNT_POINT = process.env.MOUNT_POINT || 'Z:';
const WEBDAV_PORT = parseInt(process.env.WEBDAV_PORT, 10) || 18080;

const key = deriveKey(
  path.join(__dirname, 'certs', 'client2.key'),
  path.join(__dirname, 'certs', 'server.crt'),
);

let socket = null;
let nextId = 1;
const pending = new Map();
let mounted = false;

function sendRelay(obj) {
  if (socket && !socket.destroyed) {
    socket.write(encrypt(key, JSON.stringify(obj)) + '\n');
  }
}

const REQUEST_TIMEOUT = 30000;

function request(op, reqPath, extra) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const msg = { id, op, path: reqPath, ...extra };
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Request timed out'));
      }
    }, REQUEST_TIMEOUT);
    pending.set(id, (err, res) => {
      clearTimeout(timer);
      if (err) reject(err); else resolve(res);
    });
    sendRelay(msg);
  });
}

function handleResponse(msg) {
  if (msg.type === 'disconnect') {
    console.log('Agent disconnected');
    for (const [, cb] of pending) {
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

// --- WebDAV server ---

function davPath(url) {
  // URL decode and normalize: /foo/bar → foo\bar (relative to agent ROOT)
  const decoded = decodeURIComponent(url.replace(/\/$/, '') || '/');
  return decoded.replace(/^\//, '').replace(/\//g, '\\');
}

function toISO(ms) {
  return new Date(ms).toUTCString();
}

function multistatus(items) {
  const responses = items.map(({ href, props, status }) => {
    if (status) {
      return `<D:response><D:href>${href}</D:href><D:status>HTTP/1.1 ${status}</D:status></D:response>`;
    }
    const p = Object.entries(props).map(([k, v]) => `<D:${k}>${v}</D:${k}>`).join('');
    return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${p}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }).join('');
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`;
}

function propXml(stat, href) {
  const props = {
    getlastmodified: toISO(stat.mtime),
    creationdate: toISO(stat.mtime),
  };
  if (stat.isDirectory) {
    props.resourcetype = '<D:collection/>';
  } else {
    props.resourcetype = '';
    props.getcontentlength = String(stat.size);
  }
  return { href, props };
}

const davServer = http.createServer(async (req, res) => {
  const reqPath = davPath(req.url);

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        DAV: '1',
        Allow: 'OPTIONS, PROPFIND, GET, HEAD',
        'MS-Author-Via': 'DAV',
      });
      res.end();
      return;
    }

    if (req.method === 'PROPFIND') {
      const depth = req.headers.depth || '1';
      const statRes = await request('stat', reqPath, {});
      const s = statRes.stat;
      const baseHref = req.url.endsWith('/') || req.url === '/' ? req.url : req.url + '/';
      const items = [propXml(s, req.url)];

      if (s.isDirectory && depth !== '0') {
        const dirRes = await request('readdir', reqPath, {});
        for (const name of dirRes.entries) {
          try {
            const childPath = reqPath ? reqPath + '\\' + name : name;
            const childStat = await request('stat', childPath, {});
            const childHref = baseHref + encodeURIComponent(name) +
              (childStat.stat.isDirectory ? '/' : '');
            items.push(propXml(childStat.stat, childHref));
          } catch {
            // Skip entries we can't stat
          }
        }
      }

      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(multistatus(items));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const statRes = await request('stat', reqPath, {});
      const s = statRes.stat;

      if (s.isDirectory) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (req.method === 'HEAD') { res.end(); return; }
        const dirRes = await request('readdir', reqPath, {});
        const html = dirRes.entries.map(n => `<a href="${encodeURIComponent(n)}">${n}</a>`).join('<br>');
        res.end(`<html><body>${html}</body></html>`);
        return;
      }

      // File — handle Range requests
      const size = s.size;
      const range = req.headers.range;
      let start = 0;
      let len = size;

      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : size - 1;
          len = end - start + 1;
        }
      }

      const readRes = await request('read', reqPath, { pos: start, len });
      const data = Buffer.from(readRes.data, 'base64');

      if (range) {
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': data.length,
          'Content-Range': `bytes ${start}-${start + data.length - 1}/${size}`,
          'Accept-Ranges': 'bytes',
        });
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': data.length,
          'Accept-Ranges': 'bytes',
        });
      }

      if (req.method === 'HEAD') { res.end(); return; }
      res.end(data);
      return;
    }

    // Method not allowed
    res.writeHead(405);
    res.end();
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      res.writeHead(404);
    } else {
      console.error(`WebDAV error [${req.method} ${req.url}]:`, msg);
      res.writeHead(500);
    }
    res.end();
  }
});

// --- Mount/unmount ---

function doMount() {
  try {
    execSync(`net use ${MOUNT_POINT} http://localhost:${WEBDAV_PORT}/ /persistent:no`, { stdio: 'pipe' });
    mounted = true;
    console.log(`Mounted ${MOUNT_POINT}`);
  } catch (err) {
    console.error('Mount failed:', err.stderr?.toString().trim() || err.message);
    console.log(`\nMount manually: net use ${MOUNT_POINT} http://localhost:${WEBDAV_PORT}/`);
  }
}

function doUnmount(cb) {
  if (!mounted) return cb?.();
  try {
    execSync(`net use ${MOUNT_POINT} /delete /y`, { stdio: 'pipe' });
    console.log('Unmounted');
  } catch {
    // Already unmounted
  }
  mounted = false;
  cb?.();
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

// --- Relay connection ---

function connect() {
  socket = net.connect(RELAY_PORT, RELAY_HOST, () => {
    console.log('Connected to relay server');
    socket.write(JSON.stringify({ role: 'mounter', agentId: AGENT_ID }) + '\n');
    doMount();
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
    for (const [, cb] of pending) {
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
  doUnmount(() => {
    davServer.close();
    process.exit(0);
  });
});

// Start WebDAV server first, then connect to relay
davServer.listen(WEBDAV_PORT, '127.0.0.1', () => {
  console.log(`WebDAV server on http://127.0.0.1:${WEBDAV_PORT}/`);
  console.log(`Mounter starting. Agent=${AGENT_ID}, Mount=${MOUNT_POINT}, key=${keyFingerprint(key)}`);
  connect();
});
