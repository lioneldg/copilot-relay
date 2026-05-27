# 📱 Copilot Remote Terminal

Access your Mac terminal (including GitHub Copilot CLI) from your phone — anywhere, anytime.

A lightweight WebSocket relay with **end-to-end AES-256-GCM encryption**. Your Mac connects outbound to the relay; your phone connects via Safari. The relay only sees encrypted blobs — it **never** has access to your terminal data.

## Architecture

```
Mac ──outbound WSS──▶  Relay (Render.com)  ◀──HTTPS── Phone (Safari)
       (host)          sees only encrypted         (viewer)
                          base64 blobs
```

- **No incoming connections needed** — works behind corporate firewalls, NAT, Zscaler, VPNs
- **No port forwarding, no ngrok, no SSH** — pure outbound HTTPS/WSS on port 443
- **E2E encrypted** — the relay is a dumb pipe, it cannot read your data
- **Mirrors a tmux session** — see your real terminal, not an isolated shell

## Quick Start

### 1. Deploy Your Own Relay (free, 2 minutes)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lioneldg/copilot-relay)

Or manually:

1. **Fork** this repo on GitHub
2. Go to [render.com](https://render.com) → Sign up with GitHub (free)
3. **New +** → **Web Service** → connect your forked repo
4. Configure:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node relay.js`
   - **Instance Type**: **Free**
5. Click **Deploy** → your relay is live at `https://YOUR-APP.onrender.com`

> 💡 The free tier sleeps after 15 min of inactivity (~60s cold start).
> Use [UptimeRobot](https://uptimerobot.com) (free) with an HTTP monitor every 5 min to keep it awake.

### 2. Set Up the Mac Client

```bash
# Clone and install the client
git clone https://github.com/lioneldg/copilot-relay.git
cd copilot-relay/client
npm install
```

> ⚠️ **node-pty prebuild fix** (macOS arm64): if you get a `posix_spawnp` error:
> ```bash
> chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
> ```

**Requirements**: Node.js ≥ 18, tmux (`brew install tmux`)

### 3. Connect

```bash
RELAY_URL=wss://YOUR-APP.onrender.com npm start
```

A QR code appears in your terminal. Scan it with your phone's camera → Safari opens a full interactive terminal.

That's it! 🎉

## How It Works

1. **Mac client** (`client/server.js`) attaches to a tmux session and spawns a PTY mirror
2. All terminal output is **encrypted** (AES-256-GCM) and sent to the relay via WebSocket
3. The **relay** (`relay.js`) forwards encrypted blobs between host and viewer(s) — it cannot decrypt them
4. The **phone viewer** (embedded HTML served by the relay) decrypts and renders the terminal using [xterm.js](https://xtermjs.org)
5. Keyboard input from the phone is encrypted and sent back the same way

The encryption key is shared via the **URL fragment** (`#key`), which is [never sent to the server](https://developer.mozilla.org/en-US/docs/Web/API/URL/hash) per HTTP standard.

## Environment Variables

### Mac Client

| Variable       | Default    | Description                                                        |
| -------------- | ---------- | ------------------------------------------------------------------ |
| `RELAY_URL`    | — (required) | WebSocket URL of your relay (`wss://YOUR-APP.onrender.com`)      |
| `ROOM`         | random     | Room ID (auto-generated, or set to reuse a room)                   |
| `TMUX_SESSION` | `main`     | Name of the tmux session to mirror                                 |
| `NODE_EXTRA_CA_CERTS` | —   | Path to custom CA cert (e.g. for Zscaler corporate proxy)         |

### Relay

| Variable | Default | Description        |
| -------- | ------- | ------------------ |
| `PORT`   | `3000`  | HTTP server port   |

## Corporate Proxy (Zscaler, etc.)

If your company uses a TLS-intercepting proxy (Zscaler, Netskope, etc.), WSS connections may fail with `unable to get local issuer certificate`.

Fix:
1. Export the proxy root CA from your system Keychain as a `.pem` file
2. Launch with: `NODE_EXTRA_CA_CERTS=./your-ca.pem RELAY_URL=wss://... npm start`

## Security

### What the relay sees
The relay only sees opaque base64 blobs. It has **zero knowledge** of your terminal content.

### Encryption details
- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key**: 256-bit random, generated fresh each session
- **IV**: 12-byte random per message
- **Wire format**: `base64(iv[12] + authTag[16] + ciphertext[N])`
- **Key exchange**: via URL fragment `#hexkey` — never sent to any server

### Access control
- **Room ID**: 128-bit random — impossible to guess
- **E2E key**: 256-bit random — impossible to decrypt without the QR code
- New key + room on every launch (by default)

### What could go wrong?
- If someone **physically sees your QR code**, they get access to that session
- The relay operator could theoretically **block or drop traffic** (DoS) but cannot **read** it
- If your phone is compromised, the attacker sees your terminal (same as shoulder-surfing)

## Project Structure

```
copilot-relay/
├── relay.js          # WebSocket relay server (deploy this)
├── package.json      # Relay dependencies (ws only)
├── render.yaml       # Render.com deployment config
├── client/
│   ├── server.js     # Mac client: tmux mirror + encryption + QR code
│   └── package.json  # Client dependencies (node-pty, ws, qrcode-terminal)
├── .gitignore
└── README.md
```

## Render.com Free Tier Limits

| Resource        | Limit                          |
| --------------- | ------------------------------ |
| Instance hours  | 750/month (~31 days continuous) |
| RAM             | 512 MB                         |
| Bandwidth       | 100 GB/month                   |
| Sleep           | After 15 min inactivity        |

Terminal relay uses minimal bandwidth (text only). 100 GB/month is more than enough.

## License

MIT
