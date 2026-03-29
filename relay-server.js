'use strict';

const net = require('net');
const path = require('path');
const readline = require('readline');
const { deriveKey, encrypt, decrypt } = require('./crypto-utils');

const PORT = parseInt(process.env.RELAY_PORT, 10) || 15240;

const agents = new Map();   // id → { socket, key }
const mounters = new Map(); // agentId → { socket, key }

// Precompute ECDH keys for each client type
const serverKeyPath = path.join(__dirname, 'certs', 'server.key');
const client1CertPath = path.join(__dirname, 'certs', 'client1.crt');
const client2CertPath = path.join(__dirname, 'certs', 'client2.crt');
const agentKey = deriveKey(serverKeyPath, client1CertPath);
const mounterKey = deriveKey(serverKeyPath, client2CertPath);

const server = net.createServer((socket) => {
  let identified = false;
  let role = null;
  let peerId = null;
  let myKey = null;
  let peerKey = null;

  const rl = readline.createInterface({ input: socket });
  rl.on('error', () => {});

  rl.on('line', (line) => {
    if (!identified) {
      // Handshake is plaintext
      identified = true;
      try {
        const msg = JSON.parse(line);
        if (msg.role === 'agent' && msg.id) {
          role = 'agent';
          peerId = msg.id;
          myKey = agentKey;
          peerKey = mounterKey;
          const prev = agents.get(peerId);
          if (prev && !prev.socket.destroyed) prev.socket.destroy();
          agents.set(peerId, { socket, key: myKey });
          console.log(`Agent registered: ${peerId}`);
        } else if (msg.role === 'mounter' && msg.agentId) {
          role = 'mounter';
          peerId = msg.agentId;
          myKey = mounterKey;
          peerKey = agentKey;
          const prev = mounters.get(peerId);
          if (prev && !prev.socket.destroyed) prev.socket.destroy();
          mounters.set(peerId, { socket, key: myKey });
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

    // Decrypt from sender, re-encrypt for receiver
    try {
      const plaintext = decrypt(myKey, line);

      if (role === 'mounter') {
        const agent = agents.get(peerId);
        if (agent && !agent.socket.destroyed) {
          agent.socket.write(encrypt(agent.key, plaintext) + '\n');
        }
      } else if (role === 'agent') {
        const mounter = mounters.get(peerId);
        if (mounter && !mounter.socket.destroyed) {
          mounter.socket.write(encrypt(mounter.key, plaintext) + '\n');
        }
      }
    } catch (err) {
      console.error(`Decrypt error (${role}/${peerId}):`, err.message);
    }
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !role || !peerId) return;
    cleaned = true;

    if (role === 'agent') {
      agents.delete(peerId);
      console.log(`Agent disconnected: ${peerId}`);
      const mounter = mounters.get(peerId);
      if (mounter && !mounter.socket.destroyed) {
        mounter.socket.write(encrypt(mounter.key, JSON.stringify({ type: 'disconnect' })) + '\n');
      }
    } else if (role === 'mounter') {
      mounters.delete(peerId);
      console.log(`Mounter disconnected for agent: ${peerId}`);
      const agent = agents.get(peerId);
      if (agent && !agent.socket.destroyed) {
        agent.socket.write(encrypt(agent.key, JSON.stringify({ type: 'disconnect' })) + '\n');
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
