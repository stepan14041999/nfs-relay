'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.RELAY_PORT, 10) || 15240;

const agents = new Map();   // id → ws
const mounters = new Map(); // agentId → ws

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let identified = false;
  let role = null;
  let peerId = null;

  ws.on('message', (data) => {
    const line = data.toString();

    if (!identified) {
      identified = true;
      try {
        const msg = JSON.parse(line);
        if (msg.role === 'agent' && msg.id) {
          role = 'agent';
          peerId = msg.id;
          const prev = agents.get(peerId);
          if (prev && prev.readyState === prev.OPEN) prev.close();
          agents.set(peerId, ws);
          console.log(`Agent registered: ${peerId}`);
        } else if (msg.role === 'mounter' && msg.agentId) {
          role = 'mounter';
          peerId = msg.agentId;
          const prev = mounters.get(peerId);
          if (prev && prev.readyState === prev.OPEN) prev.close();
          mounters.set(peerId, ws);
          console.log(`Mounter registered for agent: ${peerId}`);
        } else {
          console.error('Invalid handshake:', line);
          ws.close();
        }
      } catch (e) {
        console.error('Handshake parse error:', e.message);
        ws.close();
      }
      return;
    }

    // Forward as-is
    if (role === 'mounter') {
      const agentWs = agents.get(peerId);
      if (agentWs && agentWs.readyState === agentWs.OPEN) {
        agentWs.send(line);
      }
    } else if (role === 'agent') {
      const mounterWs = mounters.get(peerId);
      if (mounterWs && mounterWs.readyState === mounterWs.OPEN) {
        mounterWs.send(line);
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
      const mounterWs = mounters.get(peerId);
      if (mounterWs && mounterWs.readyState === mounterWs.OPEN) {
        mounterWs.send(JSON.stringify({ type: 'disconnect' }));
      }
    } else if (role === 'mounter') {
      mounters.delete(peerId);
      console.log(`Mounter disconnected for agent: ${peerId}`);
      const agentWs = agents.get(peerId);
      if (agentWs && agentWs.readyState === agentWs.OPEN) {
        agentWs.send(JSON.stringify({ type: 'disconnect' }));
      }
    }
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.error(`WS error (${role}/${peerId}):`, err.message);
    cleanup();
  });
});

server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
