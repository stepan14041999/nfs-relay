# NFS Relay

Access a Windows machine's filesystem from another Windows machine through a WebSocket relay server behind nginx.

## Architecture

```
[Agent] --wss--> cdn.overlewd.com/nfrnc --wss--> [Mounter → Z:\]
                 (Cloudflare → nginx → relay)
```

## Prerequisites

- **Node.js 18+**
- **WebClient service** (on mounter machine, enabled by default on Windows)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start relay server (on the server)

```bash
node relay-server.js
```

Listens on `127.0.0.1:15240`. Nginx proxies from `/nfrnc`.

### 3. nginx configuration

```nginx
location /nfrnc {
    proxy_pass http://127.0.0.1:15240;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

### 4. Start agent (on Windows Client 1)

```bash
node agent.js
```

### 5. Start mounter (on Windows Client 2)

```bash
node mounter.js
```

The remote filesystem will appear at `Z:\`.

## Environment Variables

| Variable | Default | Component | Description |
|---|---|---|---|
| `RELAY_URL` | `wss://cdn.overlewd.com/nfrnc` | agent, mounter | Relay WebSocket URL |
| `RELAY_PORT` | `15240` | relay | Local listen port |
| `AGENT_ID` | `pc1` | agent, mounter | Agent identifier |
| `AGENT_ROOT` | `C:\Users\Stepa` | agent | Root directory to share |
| `MOUNT_POINT` | `Z:` | mounter | Drive letter to mount |
| `WEBDAV_PORT` | `18080` | mounter | Local WebDAV server port |

## Security

- TLS terminated by Cloudflare + nginx
- Path traversal protection on agent side
