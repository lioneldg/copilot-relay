const crypto = require('crypto');
const WebSocket = require('ws');
const pty = require('node-pty');
const qrcode = require('qrcode-terminal');
const { execSync } = require('child_process');

// Configuration
const RELAY_URL = process.env.RELAY_URL;
const ROOM = process.env.ROOM || crypto.randomBytes(8).toString('hex');
const SESSION = process.env.TMUX_SESSION || 'main';
// E2E encryption key (256-bit AES-GCM) — shared only via QR code fragment
const E2E_KEY = crypto.randomBytes(32);

if (!RELAY_URL) {
  console.error('');
  console.error('❌ RELAY_URL manquant !');
  console.error('');
  console.error('   RELAY_URL=wss://YOUR-APP.onrender.com npm start');
  console.error('');
  process.exit(1);
}

// --- E2E Encryption (AES-256-GCM) ---
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', E2E_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', E2E_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// --- Ensure tmux session exists ---
try {
  execSync(`tmux has-session -t ${SESSION} 2>/dev/null`);
} catch {
  console.log(`  Creating tmux session "${SESSION}"...`);
  execSync(`tmux new-session -d -s ${SESSION} -x 120 -y 50`);
}

// Attach to tmux session via PTY (mirror + input relay)
const term = pty.spawn('tmux', ['attach-session', '-t', SESSION], {
  name: 'xterm-256color',
  cols: 120,
  rows: 50,
  env: { ...process.env, TERM: 'xterm-256color' },
});

// Connect to relay as host
let ws;

function connectToRelay() {
  const url = `${RELAY_URL}/ws?room=${ROOM}&role=host`;
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('\x1b[32m  ● Connected to relay (E2E encrypted)\x1b[0m');
  });

  ws.on('message', (data) => {
    const str = data.toString();
    try {
      const ctrl = JSON.parse(str);
      if (ctrl.type === 'client_joined') {
        term.write('\x0c'); // Ctrl+L = force redraw for new viewer
        return;
      }
    } catch {}
    try {
      const decrypted = decrypt(str);
      try {
        const parsed = JSON.parse(decrypted);
        if (parsed.type === 'resize') {
          term.resize(parsed.cols, parsed.rows);
          return;
        }
      } catch {}
      term.write(decrypted);
    } catch {
      // Ignore malformed
    }
  });

  ws.on('close', () => {
    console.log('\x1b[31m  ● Disconnected — reconnecting in 3s...\x1b[0m');
    setTimeout(connectToRelay, 3000);
  });

  ws.on('error', (err) => {
    console.error('  Error:', err.message);
  });
}

// PTY output → encrypt → relay
term.onData((data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(encrypt(data));
  }
});

term.onExit(() => {
  console.log('\ntmux session detached.');
  process.exit(0);
});

// iPhone URL with E2E key in fragment
const relayHttp = RELAY_URL.replace('wss://', 'https://').replace('ws://', 'http://');
const keyHex = E2E_KEY.toString('hex');
const viewURL = `${relayHttp}/view?room=${ROOM}#${keyHex}`;

// Display
connectToRelay();

console.log('');
console.log('\x1b[1;34m╔═══════════════════════════════════════════════════╗\x1b[0m');
console.log('\x1b[1;34m║       📱 Copilot Remote Terminal (E2E encrypted)  ║\x1b[0m');
console.log('\x1b[1;34m╚═══════════════════════════════════════════════════╝\x1b[0m');
console.log('');
console.log(`\x1b[32m  🔒 Mirroring tmux session "${SESSION}"\x1b[0m`);
console.log('\x1b[32m     End-to-end AES-256-GCM encryption.\x1b[0m');
console.log('');
console.log('\x1b[1;32m  Scan this QR code with your phone:\x1b[0m');
console.log('');
qrcode.generate(viewURL, { small: true }, (code) => {
  console.log(code);
  console.log('');
  console.log(`\x1b[1;33m  URL: ${viewURL}\x1b[0m`);
  console.log('');
  console.log('  Ctrl+C to stop mirroring');
  console.log('');
});
