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

  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !role || !peerId) return;
    cleaned = true;

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
