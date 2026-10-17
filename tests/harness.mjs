// Headless Brave + CDP harness for lector.user.js (needs Node 22+, the Brave Flatpak and openssl).
// The userscript is injected after each page load together with GM_* stand-ins:
// GM storage lives in a Node-side map (shared by all tabs, like the real manager), and
// GM_xmlhttpRequest answers with a fake Google so tests are offline and deterministic.
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT_PATH = process.env.LECTOR_SCRIPT || path.join(HERE, '..', 'lector.user.js');
const PORT = 9341;
const WEB_PORT = 8771;
const TLS_PORT = 8772; // example.com (the reader tabs are https), self-signed certificate

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- local web server (also answers for example.com, mapped to it) ----------
export function startServer() {
  const handler = (req, res) => {
    const file = path.join(HERE, 'pages', req.url.split(/[?#]/)[0] === '/' ? 'blank.html' : req.url.split(/[?#]/)[0]);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>Placeholder.</p></body></html>'); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      res.end(data);
    });
  };
  const plain = http.createServer(handler);
  const tls = https.createServer(throwawayCertificate(), handler);
  return Promise.all([
    new Promise((r) => plain.listen(WEB_PORT, '127.0.0.1', r)),
    new Promise((r) => tls.listen(TLS_PORT, '127.0.0.1', r)),
  ]).then(() => ({ close: () => { plain.close(); tls.close(); } }));
}
// Self-signed certificate for example.com, made fresh for each run (Brave is told to accept it).
function throwawayCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lector-cert-'));
  const [key, cert] = [path.join(dir, 'key.pem'), path.join(dir, 'cert.pem')];
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=example.com', '-addext', 'subjectAltName=DNS:example.com'], { stdio: 'ignore' });
  const pair = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true });
  return pair;
}
export const pageUrl = (name) => `http://127.0.0.1:${WEB_PORT}/${name}`;

// ---------- browser ----------
export async function launchBrave() {
  const profile = fs.mkdtempSync('/tmp/lector-brave-');
  const proc = spawn('flatpak', ['run', 'com.brave.Browser', '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,800',
    `--host-resolver-rules=MAP example.com 127.0.0.1:${TLS_PORT}`, '--ignore-certificate-errors', 'about:blank'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 40; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const close = async () => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
        spawn('pkill', ['-f', `remote-debugging-port=${PORT}`]);
        await sleep(500); // let Brave let go of its profile
        fs.rmSync(profile, { recursive: true, force: true });
      };
      return { proc, wsUrl: v.webSocketDebuggerUrl, close };
    } catch { await sleep(250); }
  }
  throw new Error('Brave did not start');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      } else if (msg.method) for (const h of this.handlers) h(msg);
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
}

// ---------- GM stand-ins (run in the page before the userscript) ----------
export const gmStore = new Map(); // shared by every tab, like the userscript manager's storage
function shimSource() {
  return `
    window.__menu = [];
    window.__requests = [];
    window.__fakeStatus = window.__fakeStatus || 200;
    const __store = ${JSON.stringify(Object.fromEntries([...gmStore].filter(([k]) => !k.startsWith('translationCache'))))}; // each tab starts uncached, so tests can see requests
    function GM_getValue(k, d) { return k in __store ? __store[k] : d; }
    function GM_setValue(k, v) { __store[k] = v; window.__gmSet && window.__gmSet(JSON.stringify([k, v])); }
    function GM_registerMenuCommand(name, fn) { window.__menu.push({ name, fn }); }
    function GM_setClipboard(text) { window.__clipboard = text; }
    function GM_xmlhttpRequest(o) {
      const u = new URL(o.url);
      const q = u.searchParams.get('q') || '';
      const sl = u.searchParams.get('sl'); const tl = u.searchParams.get('tl');
      window.__requests.push({ path: u.pathname, sl, tl, q, format: u.searchParams.get('format') });
      setTimeout(() => {
        if (u.pathname.includes('translate_tts')) { o.onload({ status: 200, response: new ArrayBuffer(8) }); return; }
        const status = window.__fakeStatus;
        if (status !== 200) { o.onload({ status, responseText: '' }); return; }
        const out = '<' + tl + '>' + q;
        const body = u.pathname.endsWith('/t') ? [out] : [[[out, q]]];
        o.onload({ status: 200, responseText: JSON.stringify(body) });
      }, 20);
    }
  `;
}

// ---------- a tab ----------
export async function openBrowser() {
  const brave = await launchBrave();
  const cdp = await Cdp.connect(brave.wsUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  return { brave, cdp };
}

// Resolves with { targetId, url } of the next page tab created after this call.
export function nextNewTab(cdp) {
  return new Promise((resolve) => cdp.on((m) => {
    if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && m.params.targetInfo.openerId) {
      resolve({ targetId: m.params.targetInfo.targetId, url: m.params.targetInfo.url });
    }
  }));
}

export class Tab {
  static async open(cdp, url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, targetId);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Runtime.addBinding', { name: '__gmSet' });
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.bindingCalled' && m.params.name === '__gmSet') {
        const [k, v] = JSON.parse(m.params.payload); gmStore.set(k, v);
      }
      if (m.method === 'Runtime.exceptionThrown') tab.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Page.loadEventFired') tab.loaded = true;
    });
    if (url) await tab.goto(url);
    return tab;
  }
  // A tab the page opened itself (window.open): attach, wait for it to load, inject.
  static async attach(cdp, targetId) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, targetId);
    await tab.send('Runtime.enable');
    await tab.send('Runtime.addBinding', { name: '__gmSet' });
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.bindingCalled' && m.params.name === '__gmSet') {
        const [k, v] = JSON.parse(m.params.payload); gmStore.set(k, v);
      }
      if (m.method === 'Runtime.exceptionThrown') tab.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    for (let i = 0; i < 100; i++) {
      const r = await tab.send('Runtime.evaluate', { expression: `location.href !== 'about:blank' && document.readyState === 'complete'`, returnByValue: true });
      if (r.result.value) break;
      await sleep(50);
    }
    await tab.inject();
    return tab;
  }
  constructor(cdp, sessionId, targetId) { this.cdp = cdp; this.sessionId = sessionId; this.targetId = targetId; this.errors = []; this.loaded = false; }
  send(method, params) { return this.cdp.send(method, params, this.sessionId); }
  async waitLoad() { for (let i = 0; i < 100 && !this.loaded; i++) await sleep(50); }
  async inject() {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const r = await this.send('Runtime.evaluate', { expression: `${shimSource()}\n${src}\n;'ok'` });
    if (r.exceptionDetails) throw new Error(`inject: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    await sleep(100);
  }
  async goto(url) { this.loaded = false; await this.send('Page.navigate', { url }); await this.waitLoad(); await this.inject(); }
  async reload() { this.loaded = false; await this.send('Page.reload'); await this.waitLoad(); await this.inject(); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${expr.slice(0, 80)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async key(key, { alt = false, shift = false, ctrl = false, code } = {}) {
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const k = shift && key.length === 1 ? key.toUpperCase() : key;
    code ??= key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const text = !alt && !ctrl && key.length === 1 ? k : key === 'Enter' ? '\r' : undefined;
    const vk = key === 'Enter' ? 13 : key === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0);
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, modifiers, text, windowsVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
    await sleep(60);
  }
  async type(text) { await this.send('Input.insertText', { text }); await sleep(60); }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(80);
  }
  async drag(x1, y1, x2, y2) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i++) await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + (x2 - x1) * i / 5, y: y1 + (y2 - y1) * i / 5, button: 'left', buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(80);
  }
  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  async close() { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); }
}

export { sleep };
