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
html,body{height:100%;background:#1a1a2e;overflow:hidden;touch-action:manipulation}
#terminal{height:calc(100% - 88px);width:100%}
.xterm{height:100%;padding:4px}
#status{position:fixed;top:8px;right:8px;padding:4px 10px;border-radius:8px;font-size:11px;font-family:-apple-system,sans-serif;z-index:99}
.ok{background:rgba(74,222,128,0.2);color:#4ade80}
.ko{background:rgba(248,113,113,0.2);color:#f87171}
.enc{background:rgba(96,165,250,0.2);color:#60a5fa}

/* --- Toolbar --- */
#toolbar{
  position:fixed;bottom:0;left:0;right:0;
  background:#0d0d1a;border-top:1px solid #333;
  display:flex;flex-direction:column;gap:4px;padding:6px 4px;
  z-index:100;-webkit-user-select:none;user-select:none;
}
#toolbar .row{display:flex;gap:4px;justify-content:center;flex-wrap:nowrap;overflow-x:auto}
#toolbar button{
  min-width:38px;height:36px;border:none;border-radius:6px;
  font-size:13px;font-family:-apple-system,SF Mono,Menlo,monospace;font-weight:500;
  background:#2a2a3e;color:#e0e0e0;
  display:flex;align-items:center;justify-content:center;
  padding:0 8px;flex-shrink:0;
  -webkit-tap-highlight-color:transparent;
  transition:background .1s,color .1s;
}
#toolbar button:active{background:#4a4a6e}
#toolbar button.mod{background:#1e1e3a;color:#8b8bab;border:1px solid #3a3a5a}
#toolbar button.mod.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
#toolbar button.sym{background:#1a2a1a;color:#6ee76e}
#toolbar button.arrow{font-size:16px;min-width:42px}
</style>
</head>
<body>
<div id="status" class="ko">Connexion...</div>
<div id="terminal"></div>
<div id="toolbar">
  <div class="row">
    <button class="mod" data-mod="ctrl">Ctrl</button>
    <button class="mod" data-mod="alt">Opt</button>
    <button class="mod" data-mod="meta">Cmd</button>
    <button data-key="escape">Esc</button>
    <button data-key="tab">Tab</button>
    <button class="arrow" data-key="up">↑</button>
    <button class="arrow" data-key="down">↓</button>
    <button class="arrow" data-key="left">←</button>
    <button class="arrow" data-key="right">→</button>
  </div>
  <div class="row">
    <button class="sym" data-char="|">|</button>
    <button class="sym" data-char="~">~</button>
    <button class="sym" data-char="/">/ </button>
    <button class="sym" data-char="-">-</button>
    <button class="sym" data-char="_">_</button>
    <button class="sym" data-char="\`">\`</button>
    <button class="sym" data-char="\\"">\\</button>
    <button class="sym" data-char="{">{</button>
    <button class="sym" data-char="}">}</button>
    <button class="sym" data-char="[">[</button>
    <button class="sym" data-char="]">]</button>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<script>
const params = new URLSearchParams(location.search);
const room = params.get('room');
const keyHex = location.hash.slice(1);
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
  const ciphertext = encBytes.slice(0, encBytes.length - 16);
  const tag = encBytes.slice(encBytes.length - 16);
  const out = new Uint8Array(12 + 16 + ciphertext.length);
  out.set(iv);
  out.set(tag, 12);
  out.set(ciphertext, 28);
  return bytesToBase64(out);
}

// --- Terminal setup ---
const term = new Terminal({fontSize:13,fontFamily:'Menlo,Monaco,monospace',theme:{background:'#1a1a2e'},cursorBlink:true});
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
    } catch(err) {}
  };
  ws.onclose=()=>{st.textContent='● Déconnecté';st.className='ko';setTimeout(connect,2000);};
}

// Send data to remote terminal
async function sendInput(data) {
  if (ws && ws.readyState === 1) {
    const enc = await encrypt(data);
    ws.send(enc);
  }
}

term.onData(async d => { await sendInput(d); });
term.onResize(async({cols,rows})=>{if(ws&&ws.readyState===1){const enc=await encrypt(JSON.stringify({type:'resize',cols,rows}));ws.send(enc);}});
window.addEventListener('resize',()=>fit.fit());

// iOS Safari: force focus on textarea for keyboard input
document.querySelector('#terminal').addEventListener('touchstart',(e)=>{
  if(e.target.closest('#toolbar')) return;
  const ta=document.querySelector('.xterm-helper-textarea');
  if(ta){ta.focus();ta.click();}
});

// --- Toolbar: Sticky Modifiers + Special Keys ---
const modState = { ctrl: false, alt: false, meta: false };

function updateModButtons() {
  document.querySelectorAll('#toolbar button.mod').forEach(btn => {
    const mod = btn.dataset.mod;
    btn.classList.toggle('active', modState[mod]);
  });
}

function resetMods() {
  modState.ctrl = false;
  modState.alt = false;
  modState.meta = false;
  updateModButtons();
}

// Apply active modifiers to a character and return the sequence to send
function applyModifiers(char) {
  let seq = char;
  if (modState.ctrl && char.length === 1) {
    const code = char.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      seq = String.fromCharCode(code - 64);
    } else if (code >= 97 && code <= 122) {
      seq = String.fromCharCode(code - 96);
    }
  }
  if (modState.alt) {
    seq = '\\x1b' + seq;
  }
  // meta (Cmd) — treated as ESC prefix in most terminals (same as alt)
  if (modState.meta && !modState.alt) {
    seq = '\\x1b' + seq;
  }
  resetMods();
  return seq;
}

// Arrow key sequences with modifiers
function arrowSeq(dir) {
  const base = {up:'A',down:'B',right:'C',left:'D'}[dir];
  const hasMod = modState.ctrl || modState.alt || modState.meta;
  if (!hasMod) { resetMods(); return '\\x1b[' + base; }
  // CSI 1;mod code: 2=Shift,3=Alt,5=Ctrl,7=Ctrl+Alt
  let mod = 1;
  if (modState.ctrl) mod += 4;
  if (modState.alt || modState.meta) mod += 2;
  resetMods();
  return '\\x1b[1;' + mod + base;
}

// Handle toolbar button taps
document.getElementById('toolbar').addEventListener('touchstart', (e) => {
  e.preventDefault();
  const btn = e.target.closest('button');
  if (!btn) return;

  // Modifier toggle
  if (btn.dataset.mod) {
    modState[btn.dataset.mod] = !modState[btn.dataset.mod];
    updateModButtons();
    return;
  }

  // Special keys
  if (btn.dataset.key) {
    let seq;
    switch(btn.dataset.key) {
      case 'escape': seq = '\\x1b'; resetMods(); break;
      case 'tab': seq = '\\x09'; resetMods(); break;
      case 'up': seq = arrowSeq('up'); break;
      case 'down': seq = arrowSeq('down'); break;
      case 'left': seq = arrowSeq('left'); break;
      case 'right': seq = arrowSeq('right'); break;
    }
    if (seq) sendInput(seq);
    return;
  }

  // Symbol characters
  if (btn.dataset.char) {
    const seq = applyModifiers(btn.dataset.char);
    sendInput(seq);
    return;
  }
});

// Intercept keyboard input to apply modifiers from toolbar
const origAttachCustomKeyEventHandler = term.attachCustomKeyEventHandler;
term.attachCustomKeyEventHandler((ev) => {
  if (ev.type === 'keydown' && (modState.ctrl || modState.alt || modState.meta)) {
    if (ev.key.length === 1) {
      ev.preventDefault();
      const seq = applyModifiers(ev.key);
      sendInput(seq);
      return false;
    }
  }
  return true;
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

