// Copilot Remote — WebSocket Relay
// Deploy on Glitch.com, Render.com, or any Node.js host
// Both Mac (terminal host) and iPhone (viewer) connect here outbound.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Store active sessions: room -> { host: ws, clients: Set<ws> }
const rooms = new Map();

// Terminal viewer HTML (served to iPhone) — with E2E decryption via Web Crypto API
const VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Copilot Remote</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#1a1a2e;overflow:hidden}
#terminal{height:100%;width:100%}
.xterm{height:100%;padding:4px}
#status{position:fixed;top:8px;right:8px;padding:4px 10px;border-radius:8px;font-size:11px;font-family:-apple-system,sans-serif;z-index:99}
.ok{background:rgba(74,222,128,0.2);color:#4ade80}
.ko{background:rgba(248,113,113,0.2);color:#f87171}
.enc{background:rgba(96,165,250,0.2);color:#60a5fa}
</style>
</head>
<body>
<div id="status" class="ko">Connexion...</div>
<div id="terminal"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<script>
const params = new URLSearchParams(location.search);
const room = params.get('room');
const keyHex = location.hash.slice(1); // E2E key from URL fragment (never sent to server)
const st = document.getElementById('status');

// --- E2E Crypto (AES-256-GCM via Web Crypto API) ---
let cryptoKey = null;

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i/2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function initCrypto() {
  if (!keyHex || keyHex.length !== 64) {
    st.textContent = '🔑 Clé E2E manquante';
    st.className = 'ko';
    return false;
  }
  cryptoKey = await crypto.subtle.importKey('raw', hexToBytes(keyHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return true;
}

async function decrypt(b64) {
  const buf = base64ToBytes(b64);
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ciphertext = buf.slice(28);
  // AES-GCM expects ciphertext+tag concatenated
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, cryptoKey, combined);
  return new TextDecoder().decode(plain);
}

async function encrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, cryptoKey, encoded);
  const encBytes = new Uint8Array(encrypted);
  // Web Crypto appends tag (16 bytes) to ciphertext
  const ciphertext = encBytes.slice(0, encBytes.length - 16);
  const tag = encBytes.slice(encBytes.length - 16);
  // Format: base64(iv + tag + ciphertext) — same as server
  const out = new Uint8Array(12 + 16 + ciphertext.length);
  out.set(iv);
  out.set(tag, 12);
  out.set(ciphertext, 28);
  return bytesToBase64(out);
}

// --- Terminal setup ---
const term = new Terminal({fontSize:14,fontFamily:'Menlo,Monaco,monospace',theme:{background:'#1a1a2e'},cursorBlink:true});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

let ws;
async function connect(){
  if (!(await initCrypto())) return;
  const proto = location.protocol==='https:'?'wss:':'ws:';
  ws = new WebSocket(proto+'//'+location.host+'/ws?room='+room+'&role=client');
  ws.onopen=()=>{st.textContent='🔒 E2E chiffré';st.className='enc';};
  ws.onmessage=async(e)=>{
    try {
      const plain = await decrypt(e.data);
      term.write(plain);
    } catch(err) { /* ignore malformed */ }
  };
  ws.onclose=()=>{st.textContent='● Déconnecté';st.className='ko';setTimeout(connect,2000);};
}

term.onData(async d=>{if(ws&&ws.readyState===1){const enc=await encrypt(d);ws.send(enc);}});
term.onResize(async({cols,rows})=>{if(ws&&ws.readyState===1){const enc=await encrypt(JSON.stringify({type:'resize',cols,rows}));ws.send(enc);}});
window.addEventListener('resize',()=>fit.fit());

// iOS Safari: force focus on textarea for keyboard input
document.querySelector('#terminal').addEventListener('touchstart',()=>{
  const ta=document.querySelector('.xterm-helper-textarea');
  if(ta){ta.focus();ta.click();}
});

if(room&&keyHex)connect();
else if(!room)term.write('\\x1b[31mRoom manquant\\x1b[0m');
else term.write('\\x1b[31mClé E2E manquante (fragment URL)\\x1b[0m');
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/view' && url.searchParams.get('room')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(VIEWER_HTML);
  } else if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Copilot Relay OK. Active rooms: ' + rooms.size);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const room = url.searchParams.get('room');
  const role = url.searchParams.get('role'); // 'host' or 'client'

  if (!room || !role) {
    ws.close(4000, 'Missing room or role param');
    return;
  }

  if (!rooms.has(room)) {
    rooms.set(room, { host: null, clients: new Set() });
  }

  const session = rooms.get(room);

  if (role === 'host') {
    session.host = ws;
    ws.on('message', (data, isBinary) => {
      for (const client of session.clients) {
        if (client.readyState === client.OPEN) client.send(data, { binary: isBinary });
      }
    });
    ws.on('close', () => {
      session.host = null;
      for (const client of session.clients) client.close(4001, 'Host disconnected');
      rooms.delete(room);
    });
  } else {
    session.clients.add(ws);
    // Notify host that a client joined (so it can resend prompt)
    if (session.host?.readyState === session.host?.OPEN) {
      session.host.send(JSON.stringify({ type: 'client_joined' }));
    }
    ws.on('message', (data, isBinary) => {
      if (session.host?.readyState === session.host?.OPEN) {
        session.host.send(data, { binary: isBinary });
      }
    });
    ws.on('close', () => session.clients.delete(ws));
  }
});

server.listen(PORT, () => {
  console.log(`Copilot Relay running on port ${PORT}`);
});

