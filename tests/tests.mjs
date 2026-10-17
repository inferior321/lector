// Browser tests for lector.user.js in headless Brave (see harness.mjs).
// Run from the repo: node tests/tests.mjs [part of a test name]
// Google is faked (it answers '<tl>' + the text), so no network is needed; a screenshot of
// each test's last state is saved in tests/shots/.
import { startServer, openBrowser, Tab, pageUrl, sleep, nextNewTab } from './harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const filter = process.argv[2] || '';

// ---------- helpers evaluated in the page ----------
const HELPERS = `
  window.__ui = () => [...document.body.children].find((n) => n.shadowRoot)?.shadowRoot;
  window.__q = (sel) => __ui()?.querySelector(sel);
  window.__visible = (sel) => { const n = __q(sel); if (!n) return false; const r = n.getBoundingClientRect(); return n.checkVisibility() && r.width > 0 && r.height > 0; };
  window.__rect = (sel) => { const r = __q(sel)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
  // centre of the first occurrence of 'word' in root's text (page or our shadow root)
  window.__wordAt = (word, inUi) => {
    const root = inUi ? __ui() : document.body;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const i = n.data.indexOf(word);
      if (i < 0 || n.parentElement.closest('script,style,textarea')) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length);
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  };
  window.__tipVisible = () => { const t = __q('.tip'); return !!t && t.checkVisibility(); };
  window.__lastReq = (pred) => [...__requests].reverse().find(pred || (() => true));
`;

async function prep(tab) { await tab.eval(HELPERS); }

async function openPage(cdp, name = 'spanish.html') {
  const tab = await Tab.open(cdp, pageUrl(name));
  await prep(tab);
  return tab;
}

async function clickWord(tab, word, inUi = false) {
  const p = await tab.eval(`__wordAt(${JSON.stringify(word)}, ${inUi})`);
  if (!p) throw new Error(`word not found: ${word}`);
  await tab.click(p.x, p.y);
  await sleep(250);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- existing behaviour (regression) ----------
test('Alt+T turns reading mode on; clicking a word translates es→en', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  await clickWord(tab, 'banco');
  assert(await tab.eval('__tipVisible()'), 'popup should show');
  const r = await tab.eval(`__lastReq((r) => r.format === 'html')`);
  eq([r.sl, r.tl], ['es', 'en'], 'lookup direction');
  return tab;
});

// ---------- feature 1: direction pill ----------
test('pill hidden while reading mode is off, shown with ES → EN when on', async (cdp) => {
  const tab = await openPage(cdp);
  assert(!(await tab.eval(`__visible('.dirpill')`)), 'pill hidden when off');
  await tab.key('t', { alt: true });
  assert(await tab.eval(`__visible('.dirpill')`), 'pill visible when on');
  eq(await tab.eval(`__q('.dirlabel').textContent`), 'ES → EN', 'label');
  const r = await tab.eval(`__rect('.dirpill')`);
  assert(r.y < 30 && Math.abs(r.cx - 640) < 20, `pill at top centre, got ${JSON.stringify(r)}`);
  return tab;
});

test('pill stays at the top while scrolling', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  await tab.eval('window.scrollTo(0, 900)');
  await sleep(100);
  const r = await tab.eval(`__rect('.dirpill')`);
  assert(r.y < 30 && r.y >= 0, `pill still at top after scroll, got y=${r.y}`);
  return tab;
});

test('old badge and the Swap direction menu entry are gone', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  assert(!(await tab.eval(`__visible('.badge')`)), 'no badge');
  const menu = await tab.eval('__menu.map((m) => m.name)');
  assert(!menu.some((n) => /swap/i.test(n)), `menu still has swap: ${menu}`);
  return tab;
});

test('⇄ swaps to EN → ES and lookups follow', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  const s = await tab.eval(`__rect('.dirswap')`);
  await tab.click(s.cx, s.cy);
  eq(await tab.eval(`__q('.dirlabel').textContent`), 'EN → ES', 'label after swap');
  await clickWord(tab, 'banco');
  const r = await tab.eval(`__lastReq((r) => r.format === 'html')`);
  eq([r.sl, r.tl], ['en', 'es'], 'lookup direction after swap');
  return tab;
});

test('direction is per tab: kept on reload, new tabs start ES → EN', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  const s = await tab.eval(`__rect('.dirswap')`);
  await tab.click(s.cx, s.cy);
  await tab.reload(); await prep(tab);
  await tab.key('t', { alt: true });
  eq(await tab.eval(`__q('.dirlabel').textContent`), 'EN → ES', 'kept after reload');
  const other = await openPage(cdp);
  await other.key('t', { alt: true });
  eq(await other.eval(`__q('.dirlabel').textContent`), 'ES → EN', 'new tab default');
  await other.close();
  return tab;
});

test('✕ on the pill turns reading mode off', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  const x = await tab.eval(`__rect('.diroff')`);
  await tab.click(x.cx, x.cy);
  assert(!(await tab.eval(`__visible('.dirpill')`)), 'pill hidden');
  await clickWord(tab, 'banco');
  assert(!(await tab.eval('__tipVisible()')), 'clicks no longer translate');
  return tab;
});

test('Google busy shows an amber countdown in the pill', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  await tab.eval('window.__fakeStatus = 429');
  await clickWord(tab, 'frío');
  await sleep(300);
  const text = await tab.eval(`__q('.dirpill').textContent`);
  assert(/Google busy · \d:\d\d/.test(text), `busy text, got ${text}`);
  assert(await tab.eval(`__q('.dirpill').classList.contains('busy')`), 'busy class');
  return tab;
});

// ---------- feature 2: quick translator box ----------
test('Alt+Shift+T opens the box without toggling reading mode, and closes it again', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  assert(await tab.eval(`__visible('.qbox')`), 'box open');
  assert(!(await tab.eval(`__visible('.dirpill')`)), 'reading mode still off');
  await tab.key('t', { alt: true, shift: true });
  assert(!(await tab.eval(`__visible('.qbox')`)), 'box closed');
  return tab;
});

test('panel opens centered under the pill, opposite direction of the tab, input focused', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  await tab.key('t', { alt: true, shift: true });
  eq(await tab.eval(`__q('.qdir').textContent`), 'EN → ES', 'box direction');
  const r = await tab.eval(`__rect('.qbox')`);
  const pill = await tab.eval(`__rect('.dirpill')`);
  assert(Math.abs(r.cx - 640) < 20, `centered, got ${JSON.stringify(r)}`);
  assert(r.y >= pill.y + pill.h && r.y < 110, `just under the pill, got y=${r.y}, pill bottom ${pill.y + pill.h}`);
  assert(await tab.eval(`__ui().activeElement === __q('.qin')`), 'input focused');
  return tab;
});

test('clicking the page leaves the panel open, and page words still translate', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true });
  await tab.key('t', { alt: true, shift: true });
  await tab.type('the bench');
  await clickWord(tab, 'banco');
  assert(await tab.eval('__tipVisible()'), 'page word translated');
  assert(await tab.eval(`__visible('.qbox')`), 'panel still open after a word click');
  await tab.click(900, 450);
  assert(await tab.eval(`__visible('.qbox')`), 'panel still open after a blank click');
  eq(await tab.eval(`__q('.qin').value`), 'the bench', 'text untouched');
  return tab;
});

test('Reading button switches reading mode, panel stays open, label follows (also Alt+T)', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  eq(await tab.eval(`__q('.qreading').textContent`), 'Reading: off', 'label off');
  const b = await tab.eval(`__rect('.qreading')`);
  await tab.click(b.cx, b.cy);
  assert(await tab.eval(`__visible('.dirpill')`), 'reading mode on');
  assert(await tab.eval(`__visible('.qbox')`), 'panel stays open');
  eq(await tab.eval(`__q('.qreading').textContent`), 'Reading: on', 'label on');
  await tab.key('t', { alt: true });
  eq(await tab.eval(`__q('.qreading').textContent`), 'Reading: off', 'label follows Alt+T');
  return tab;
});

test('the three buttons sit on one line', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  const rs = await tab.eval(`['.qopenbook', '.qopentext', '.qreading'].map(__rect)`);
  const box = await tab.eval(`__rect('.qbox')`);
  assert(rs.every((r) => Math.abs(r.y - rs[0].y) < 2), `same row: ${JSON.stringify(rs.map((r) => r.y))}`);
  assert(rs.every((r) => r.x >= box.x && r.x + r.w <= box.x + box.w), 'inside the panel');
  eq(await tab.eval(`[__q('.qopenbook').textContent, __q('.qopentext').textContent]`), ['📖 PDF/EPUB', '📝 Pasted text'], 'short labels');
  return tab;
});

test('dragging the header moves the panel, and every tab reopens it there', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  const h = await tab.eval(`__rect('.qhead')`);
  await tab.drag(h.x + 60, h.cy, 300, 400);
  const r = await tab.eval(`__rect('.qbox')`);
  assert(Math.abs(r.x - (300 - 60)) < 6 && Math.abs(r.y - (400 - (h.cy - h.y))) < 6, `moved, got ${JSON.stringify(r)}`);
  await tab.key('t', { alt: true, shift: true });
  await tab.key('t', { alt: true, shift: true });
  const again = await tab.eval(`__rect('.qbox')`);
  assert(Math.abs(again.x - r.x) < 2 && Math.abs(again.y - r.y) < 2, 'reopens where it was left');
  const other = await openPage(cdp);
  await other.key('t', { alt: true, shift: true });
  const r2 = await other.eval(`__rect('.qbox')`);
  assert(Math.abs(r2.x - r.x) < 2 && Math.abs(r2.y - r.y) < 2, `remembered in other tab, got ${JSON.stringify(r2)}`);
  await other.eval(`GM_setValue('panelPos', null)`); // later tests expect the first-time spot
  await other.close();
  return tab;
});

for (const [btn, hash] of [['.qopenbook', '#lector-book'], ['.qopentext', '#lector-text']]) {
  test(`${btn} opens ${hash} in a new tab and closes the panel`, async (cdp) => {
    const tab = await openPage(cdp);
    await tab.key('t', { alt: true, shift: true });
    const opened = nextNewTab(cdp);
    const b = await tab.eval(`__rect('${btn}')`);
    await tab.click(b.cx, b.cy);
    const t = await Promise.race([opened, sleep(3000).then(() => null)]);
    assert(t, 'a new tab opened');
    const other = await Tab.attach(cdp, t.targetId);
    eq(await other.eval('location.hash'), hash, 'opened the right reader');
    await other.close();
    assert(!(await tab.eval(`__visible('.qbox')`)), 'panel closed');
    return tab;
  });
}

test('Enter translates, Shift+Enter adds a line', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  await tab.type('good morning');
  await tab.key('Enter', { shift: true });
  await tab.type('friend');
  eq(await tab.eval(`__q('.qin').value`), 'good morning\nfriend', 'shift+enter newline');
  eq(await tab.eval(`__requests.length`), 0, 'nothing translated yet');
  await tab.key('Enter');
  await sleep(200);
  eq(await tab.eval(`__q('.qin').value`), 'good morning\nfriend', 'enter adds no newline');
  const r = await tab.eval(`__lastReq()`);
  eq([r.sl, r.tl, r.q], ['en', 'es', 'good morning\nfriend'], 'request');
  assert((await tab.eval(`__q('.qout').textContent`)).includes('<es>good morning'), 'output shown');
  return tab;
});

test('keys typed in the box do not reach the page', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  await tab.eval('window.__pageKeys = []');
  await tab.key('k');
  await tab.key('f');
  eq(await tab.eval('__pageKeys'), [], 'page saw no keys');
  eq(await tab.eval(`__q('.qin').value`), 'kf', 'box got them');
  return tab;
});

test('clicking an output word looks it up back into the input language, reading mode off', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  await tab.type('the bench');
  await tab.key('Enter');
  await sleep(200);
  await clickWord(tab, 'bench', true);
  await sleep(200);
  assert(await tab.eval('__tipVisible()'), 'popup for output word');
  const r = await tab.eval(`__lastReq((r) => r.format === 'html')`);
  eq([r.sl, r.tl], ['es', 'en'], 'output lookup reversed (box is en→es)');
  assert(!(await tab.eval(`__visible('.dirpill')`)), 'reading mode still off');
  return tab;
});

test('Esc closes the popup first, then the box', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  await tab.type('the bench');
  await tab.key('Enter');
  await sleep(200);
  await clickWord(tab, 'bench', true);
  await sleep(200);
  await tab.key('Escape');
  assert(!(await tab.eval('__tipVisible()')), 'popup closed');
  assert(await tab.eval(`__visible('.qbox')`), 'box still open');
  await tab.key('Escape');
  assert(!(await tab.eval(`__visible('.qbox')`)), 'box closed');
  return tab;
});

test('⇄ in the box flips direction, moves the translation up and translates it', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  await tab.type('hello');
  await tab.key('Enter');
  await sleep(200);
  const s = await tab.eval(`__rect('.qswap')`);
  await tab.click(s.cx, s.cy);
  await sleep(200);
  eq(await tab.eval(`__q('.qdir').textContent`), 'ES → EN', 'flipped');
  eq(await tab.eval(`__q('.qin').value`), '<es>hello', 'translation moved to input');
  const r = await tab.eval(`__lastReq()`);
  eq([r.sl, r.tl, r.q], ['es', 'en', '<es>hello'], 'translated right away');
  return tab;
});

test('🔊 reads the output in the output language', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  await tab.type('hello');
  await tab.key('Enter');
  await sleep(200);
  const s = await tab.eval(`__rect('.qsay')`);
  await tab.click(s.cx, s.cy);
  await sleep(200);
  const r = await tab.eval(`__lastReq((r) => r.path.includes('translate_tts'))`);
  assert(r, 'tts requested');
  eq(r.tl, 'es', 'speech language');
  return tab;
});

test('📋 copies the translation, and only shows when there is one', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  assert(!(await tab.eval(`__visible('.qcopy')`)), 'no copy button before translating');
  await tab.type('good morning');
  await tab.key('Enter');
  await sleep(200);
  const c = await tab.eval(`__rect('.qcopy')`);
  await tab.click(c.cx, c.cy);
  eq(await tab.eval('window.__clipboard'), '<es>good morning', 'copied text');
  eq(await tab.eval(`__q('.qcopy').textContent`), '✓', 'confirms');
  await sleep(1600);
  eq(await tab.eval(`__q('.qcopy').textContent`), '📋', 'back to 📋');
  await tab.eval('window.__fakeStatus = 429');
  await tab.type(' again');
  await tab.key('Enter');
  await sleep(200);
  assert(!(await tab.eval(`__visible('.qcopy')`)), 'no copy button for an error');
  return tab;
});

test('✕ closes the box; reopening (and reloading) keeps text and direction in this tab', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  await tab.type('hello');
  await tab.key('Enter');
  await sleep(200);
  const s = await tab.eval(`__rect('.qswap')`);
  await tab.click(s.cx, s.cy); // now ES → EN with '<es>hello'
  await sleep(200);
  const x = await tab.eval(`__rect('.qclose')`);
  await tab.click(x.cx, x.cy);
  assert(!(await tab.eval(`__visible('.qbox')`)), 'closed by ✕');
  await tab.key('t', { alt: true, shift: true });
  eq(await tab.eval(`__q('.qin').value`), '<es>hello', 'text kept on reopen');
  await tab.reload(); await prep(tab);
  await tab.key('t', { alt: true, shift: true });
  eq(await tab.eval(`__q('.qin').value`), '<es>hello', 'text kept on reload');
  eq(await tab.eval(`__q('.qdir').textContent`), 'ES → EN', 'direction kept on reload');
  assert((await tab.eval(`__q('.qout').textContent`)).includes('<en><es>hello'), 'output kept');
  const other = await openPage(cdp);
  await other.key('t', { alt: true, shift: true });
  eq(await other.eval(`__q('.qin').value`), '', 'new tab starts empty');
  await other.close();
  return tab;
});

test('Alt+Shift+T works while typing in a page field', async (cdp) => {
  const tab = await openPage(cdp);
  await tab.eval(`document.getElementById('field').focus()`);
  await tab.key('t', { alt: true, shift: true });
  assert(await tab.eval(`__visible('.qbox')`), 'box open');
  return tab;
});

// ---------- pasted-text reader ----------
test('pasted-text reader: pill at top doesn\'t cover the paste box', async (cdp) => {
  const tab = await Tab.open(cdp, 'https://example.com/#lector-text');
  await prep(tab);
  await tab.type('Me senté en el banco.');
  await sleep(700);
  assert(await tab.eval(`__visible('.dirpill')`), 'pill shown once text is in');
  const pill = await tab.eval(`__rect('.dirpill')`);
  const box = await tab.eval(`(() => { const r = document.querySelector('.lector-paste').getBoundingClientRect(); return { y: r.y }; })()`);
  assert(box.y >= pill.y + pill.h, `paste box (y=${box.y}) below pill (bottom=${pill.y + pill.h})`);
  return tab;
});

// ---------- book reader ----------
// The Brave Flatpak can only read some folders (e.g. /tmp), so the picker gets a copy there.
function epubCopy() {
  const copy = path.join(fs.mkdtempSync('/tmp/lector-epub-'), 'libro.epub');
  fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'libro.epub'), copy);
  return copy;
}

// Opens the test EPUB in a book reader tab through its file picker.
async function openTestEpub(cdp) {
  const tab = await Tab.open(cdp, 'https://example.com/#lector-book');
  await prep(tab);
  await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
  const chosen = new Promise((resolve) => cdp.on((m) => {
    if (m.sessionId === tab.sessionId && m.method === 'Page.fileChooserOpened') resolve(m.params.backendNodeId);
  }));
  const choose = await tab.eval(`(() => { const b = [...__ui().querySelectorAll('.readerbar button')].find((b) => /Choose/.test(b.textContent)); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await tab.click(choose.x, choose.y);
  const copy = epubCopy();
  await tab.send('DOM.setFileInputFiles', { files: [copy], backendNodeId: await chosen });
  for (let i = 0; i < 40 && !(await tab.eval(`!!document.querySelector('.lector-chapter')`)); i++) await sleep(100);
  await sleep(300);
  fs.rmSync(path.dirname(copy), { recursive: true, force: true });
  return tab;
}

test('Continue reading in the panel opens that book in a new reader tab', async (cdp) => {
  const reader = await openTestEpub(cdp);
  await reader.close();
  const tab = await openPage(cdp);
  await tab.key('t', { alt: true, shift: true });
  const titles = await tab.eval(`[...__ui().querySelectorAll('.qbook')].map((b) => b.textContent)`);
  assert(titles.some((t) => t.includes('Libro de prueba')), `book listed, got ${JSON.stringify(titles)}`);
  const opened = nextNewTab(cdp);
  const b = await tab.eval(`(() => { const r = [...__ui().querySelectorAll('.qbook')].find((b) => b.textContent.includes('Libro de prueba')).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await tab.click(b.x, b.y);
  const t = await Promise.race([opened, sleep(3000).then(() => null)]);
  assert(t, 'a new tab opened');
  const book = await Tab.attach(cdp, t.targetId);
  for (let i = 0; i < 40 && !(await book.eval(`!!document.querySelector('.lector-chapter')`)); i++) await sleep(100);
  assert(await book.eval(`document.body.textContent.includes('Me senté en el banco del parque')`), 'the book is open, no file picker');
  eq(await book.eval('location.hash'), '#lector-book', 'address tidied back');
  await book.close();
  assert(!(await tab.eval(`__visible('.qbox')`)), 'panel closed');
  return tab;
});

test('EPUB reader: the direction controls sit at the end of the reader bar', async (cdp) => {
  const tab = await openTestEpub(cdp);
  assert(await tab.eval(`__visible('.readerbar .dirpill')`), 'pill inside the reader bar, visible');
  eq(await tab.eval(`__ui().querySelectorAll('.dirpill').length`), 1, 'only one pill');
  const bar = await tab.eval(`__rect('.readerbar')`);
  const p = await tab.eval(`__rect('.dirpill')`);
  assert(p.y >= bar.y && p.y + p.h <= bar.y + bar.h + 1 && p.x + p.w <= bar.x + bar.w + 1, `pill within the bar: ${JSON.stringify({ bar, p })}`);
  const s = await tab.eval(`__rect('.dirswap')`);
  await tab.click(s.cx, s.cy);
  eq(await tab.eval(`__q('.dirlabel').textContent`), 'EN → ES', 'swap works in the reader');
  await tab.key('t', { alt: true });
  assert(!(await tab.eval(`__visible('.dirpill')`)), 'hidden when reading mode is off');
  assert(await tab.eval(`__visible('.readerbar')`), 'reader bar itself stays');
  return tab;
});

// ---------- run ----------
const server = await startServer();
const { brave, cdp } = await openBrowser();
let failed = 0;
for (const t of tests.filter((t) => t.name.includes(filter))) {
  let tab;
  try {
    tab = await t.fn(cdp);
    const errs = tab?.errors || [];
    if (errs.length) throw new Error(`page errors: ${errs.join(' | ')}`);
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${t.name}\n      ${e.message.split('\n')[0]}`);
  }
  try { if (tab) { await tab.screenshot(path.join(SHOTS, `${tests.indexOf(t)}.png`)); await tab.close(); } } catch {}
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
await brave.close();
server.close();
process.exit(failed ? 1 : 0);
