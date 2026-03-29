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
