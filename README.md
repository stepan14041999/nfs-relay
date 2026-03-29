# NFS Relay

Access a Windows machine's filesystem from another Windows machine through a WebSocket relay server.

## Architecture

```
[Agent] --wss--> [cdn.overlewd.com/nrscn] <--wss-- [Mounter]
                  (relay-server.js)                  (Z:\)
```

Two deployment options: **standalone** (relay handles TLS directly) or **behind nginx** (nginx terminates TLS, proxies WebSocket).

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
- `server.crt` + `server.key` (relay server, standalone mode only)
- `client1.crt` + `client1.key` (agent)
- `client2.crt` + `client2.key` (mounter)

### 2. Install dependencies

```bash
npm install
```

### 3a. Standalone — relay handles TLS directly

```bash
# On the relay server (cdn.overlewd.com)
RELAY_PORT=8443 node relay-server.js
```

Clients connect to `wss://cdn.overlewd.com:8443/nrscn` with client certs.

### 3b. Behind nginx — nginx terminates TLS

Run relay on localhost without TLS exposure:

```bash
RELAY_PORT=9000 node relay-server.js
```

See [nginx configuration](#nginx-configuration) below.

### 4. Start agent

```bash
# On Windows Client 1 (the machine sharing files)
set RELAY_HOST=cdn.overlewd.com
set RELAY_PORT=8443
set AGENT_ID=pc1
set AGENT_ROOT=C:\Users\Stepa
node agent.js
```

### 5. Start mounter

```bash
# On Windows Client 2 (the machine mounting remote files)
set RELAY_HOST=cdn.overlewd.com
set RELAY_PORT=8443
set AGENT_ID=pc1
set MOUNT_POINT=Z:\
node mounter.js
```

The remote filesystem will appear at `Z:\`.

## Environment Variables

| Variable | Default | Component | Description |
|---|---|---|---|
| `RELAY_HOST` | `cdn.overlewd.com` | agent, mounter | Relay server hostname |
| `RELAY_PORT` | `8443` | all | Relay server port |
| `RELAY_PATH` | `/nrscn` | all | WebSocket endpoint path |
| `AGENT_ID` | `pc1` | agent, mounter | Agent identifier |
| `AGENT_ROOT` | `C:\Users\Stepa` | agent | Root directory to share |
| `MOUNT_POINT` | `Z:\` | mounter | Drive letter to mount |

## nginx Configuration

nginx terminates TLS (with Let's Encrypt or your own cert for `cdn.overlewd.com`), verifies client certificates via mTLS, and proxies WebSocket to the local relay.

```nginx
server {
    listen 443 ssl;
    server_name cdn.overlewd.com;

    # Public TLS cert (Let's Encrypt or your own)
    ssl_certificate     /etc/letsencrypt/live/cdn.overlewd.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cdn.overlewd.com/privkey.pem;

    # mTLS — verify client certs signed by our CA
    ssl_client_certificate /etc/nfs-relay/certs/ca.crt;
    ssl_verify_client optional;

    ssl_protocols TLSv1.3;
    ssl_ciphers TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256;

    # WebSocket relay
    location /nrscn {
        # Require valid client certificate
        if ($ssl_client_verify != SUCCESS) {
            return 403;
        }

        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Disable buffering for WebSocket
        proxy_buffering off;

        # Long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Other locations on this domain remain unaffected by mTLS
    # (ssl_verify_client is "optional", enforced only in /nrscn via if-check)
}
```

**Key points:**
- `ssl_verify_client optional` — TLS handshake doesn't require a cert globally, so other paths on `cdn.overlewd.com` work normally
- The `if ($ssl_client_verify != SUCCESS)` in `/nrscn` enforces mTLS only for the relay endpoint
- `proxy_read_timeout 86400s` — keeps the WebSocket connection alive for 24h
- Relay runs on `127.0.0.1:9000` (plain HTTPS locally, nginx handles public TLS)

**When using nginx**, clients still connect to `wss://cdn.overlewd.com:443/nrscn` with their client certs — nginx forwards the verified connection to the local relay.

Set client port to 443:
```bash
set RELAY_PORT=443
```

## Security

- TLS 1.3 with mutual authentication (mTLS)
- Ciphers: `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`
- Path traversal protection on agent side
- All certificates signed by a shared CA
- WebSocket on path `/nrscn` — no open ports beyond 443
