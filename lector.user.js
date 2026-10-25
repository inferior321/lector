// ==UserScript==
// @name         Lector
// @namespace    inferior321.lector
// @version      1.11.0
// @description  A reading assistant for Spanish learners: in-context translations, phrase detection, audio, and readers for PDFs, EPUB books and pasted text. Alt+T toggles reading mode; Alt+Shift+T opens a quick translator.
// @author       inferior321
// @license      MIT
// @homepageURL  https://github.com/inferior321/lector
// @updateURL    https://raw.githubusercontent.com/inferior321/lector/main/lector.user.js
// @downloadURL  https://raw.githubusercontent.com/inferior321/lector/main/lector.user.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      translate.googleapis.com
// @connect      clients5.google.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  // Embedded frames are skipped (ads, players, widgets…), except the ones whose text is worth
  // reading. Claude artifacts (e.g. a practice page) show their content in a frame on
  // <id>.frame.claudeusercontent.com, inside a claude.ai wrapper frame that stays skipped.
  // Lector then runs in that frame on its own: its shortcuts work while the frame has the focus.
  const READABLE_FRAME_HOSTS = [/\.claudeusercontent\.com$/];
  const inFrame = window.top !== window.self;
  if (inFrame && !READABLE_FRAME_HOSTS.some((host) => host.test(location.hostname))) return;

  // ---------- menu (registered first so it shows up even if a page breaks the UI code) ----------
  if (inFrame) { // the outer page has its own Lector and menu entries, so say which one this is
    GM_registerMenuCommand('Toggle reading mode (this artifact)', () => setEnabled(!enabled));
    GM_registerMenuCommand('Lector panel (this artifact)', () => toggleQuickBox());
  } else {
    GM_registerMenuCommand('Toggle reading mode (Alt+T)', () => setEnabled(!enabled));
    GM_registerMenuCommand('Lector panel (Alt+Shift+T)', () => toggleQuickBox());
    GM_registerMenuCommand('Open a PDF or EPUB to read…', () => (isReaderTab ? openBookReader() : openReaderTab(READER_URL)));
    GM_registerMenuCommand('Read pasted text…', () => (isTextTab ? openTextReader() : openReaderTab(TEXT_READER_URL)));
  }

  // The tab's own storage: kept across reloads, forgotten when the tab closes. Used by the
  // reader tabs (reload = back where you were); may be blocked, in which case nothing is kept.
  const tabStore = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* blocked */ } },
    remove(key) { try { sessionStorage.removeItem(key); } catch { /* blocked */ } },
  };

  // ---------- direction ----------
  // Each tab has its own direction (the ⇄ on the top pill), kept across reloads. A new tab
  // starts with the last one chosen anywhere (Spanish → English until you first swap); tabs
  // already open keep theirs. Every lookup takes a { source, target } pair along with it, so
  // a page lookup and a quick-translator lookup running at the same time can't mix them up.
  const DIRECTION_TAB_KEY = 'lector-reversed';
  const PAGE_DIRECTION_KEY = 'pageReversed';
  const langPair = (reversed) => (reversed ? { source: 'en', target: 'es' } : { source: 'es', target: 'en' });
  const savedTabDirection = tabStore.get(DIRECTION_TAB_KEY);
  let tabReversed = savedTabDirection ? savedTabDirection === '1' : GM_getValue(PAGE_DIRECTION_KEY, false);
  tabStore.set(DIRECTION_TAB_KEY, tabReversed ? '1' : '0'); // a reload keeps it, whatever other tabs choose
  const pageLang = () => langPair(tabReversed);

  const GOOGLE_BACKOFF_MS = 120_000;
  const MAX_SENTENCE_CHARS = 600;
  const HOTKEY = 't'; // with Alt

  // Reading mode always starts off on every page load; Alt+T turns it on/off.
  let enabled = false;

  // ---------- HTTP ----------
  function request(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        timeout: 15000,
        onload: resolve,
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });
  }

  // ---------- Google Translate (free, unofficial endpoint) ----------
  // Answers are kept across pages and restarts (in Tampermonkey's storage), newest last,
  // capped so it can't grow forever. Bump CACHE_KEY if the stored format changes.
  // Loaded on the first lookup, not on every page load (most pages never translate anything).
  const CACHE_KEY = 'translationCache-v1';
  const CACHE_MAX_ENTRIES = 5000;
  let googleCache = null;
  let googlePausedUntil = 0; // set only while every Google address is refusing (pill / popup countdown)
  let cacheSaveTimer = 0;

  const loadCache = () => (googleCache ??= new Map(GM_getValue(CACHE_KEY, [])));

  function cacheGet(key) {
    const cache = loadCache();
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    cache.delete(key); // move to the end: recently used
    cache.set(key, value);
    return value;
  }

  function cacheSet(key, value) {
    const cache = loadCache();
    cache.set(key, value);
    if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // oldest
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(saveCache, 1000); // one write per burst of lookups
  }

  // Merge with what other tabs saved meanwhile, then keep only the newest entries.
  function saveCache() {
    const merged = new Map(GM_getValue(CACHE_KEY, []));
    for (const [k, v] of googleCache) { merged.delete(k); merged.set(k, v); }
    GM_setValue(CACHE_KEY, [...merged].slice(-CACHE_MAX_ENTRIES));
  }

  // Two Google addresses give the same answers. When one says "too many requests" it's
  // paused for a while and the other is used; only when both refuse do we report "busy".
  const GOOGLE_HOSTS = [
    { name: 'primary', rewrite: (url) => url, pausedUntil: 0 },
    { name: 'backup', rewrite: (url) => url.replace('translate.googleapis.com', 'clients5.google.com').replace('client=gtx', 'client=dict-chrome-ex'), pausedUntil: 0 },
  ];

  async function fetchGoogle(url, key, parse) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
    for (const host of GOOGLE_HOSTS) {
      if (Date.now() < host.pausedUntil) continue;
      const res = await request({ method: 'GET', url: host.rewrite(url) });
      if (res.status === 429 || res.status === 403) {
        host.pausedUntil = Date.now() + GOOGLE_BACKOFF_MS;
        continue;
      }
      if (res.status !== 200) throw new Error(`Google HTTP ${res.status}`);
      googlePausedUntil = 0;
      const result = parse(JSON.parse(res.responseText));
      cacheSet(key, result);
      return result;
    }
    googlePausedUntil = Math.min(...GOOGLE_HOSTS.map((h) => h.pausedUntil)); // first one back
    updatePill();
    throw busyError();
  }

  // Google is refusing requests: the error says until when, so the popup and the pill can count down.
  function busyError() {
    const e = new Error('Google is busy (too many requests)');
    e.busyUntil = googlePausedUntil;
    return e;
  }

  const countdown = (until) => {
    const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  };

  // withDict also asks for dictionary meanings (only useful for a single word or short phrase).
  function google(text, lang, withDict = false) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
      + (withDict ? '&dt=bd' : '')
      + `&sl=${lang.source}&tl=${lang.target}&q=${encodeURIComponent(text)}`;
    return fetchGoogle(url, `${lang.source}|${lang.target}|${withDict}|${text}`, (data) => ({
      text: (data[0] || []).map((seg) => seg[0] || '').join(''),
      ...parseDictionary(withDict ? data[1] || [] : [], text),
    }));
  }

  // HTML mode (what Chrome's page translator uses): Google moves <b> tags onto the words
  // they correspond to, so "<b>La</b> vi en la tienda" → "I saw <b>her</b> in the store".
  // Returns the words inside the tag and the plain translated sentence.
  function googleTagged(html, lang) {
    const url = 'https://translate.googleapis.com/translate_a/t?client=gtx&format=html'
      + `&sl=${lang.source}&tl=${lang.target}&q=${encodeURIComponent(html)}`;
    return fetchGoogle(url, `${lang.source}|${lang.target}|html|${html}`, (data) => {
      const out = [data].flat(2).find((x) => typeof x === 'string') || '';
      const text = (t) => decodeEntities(t.replace(/<[^>]*>/g, '')).replace(/\s+([.,;:!?])/g, '$1').trim();
      return { inTag: text(out.match(/<b>([\s\S]*?)<\/b>/)?.[1] || ''), plain: text(out) };
    });
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(t) {
    return t.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }

  // Dictionary entries look like [partOfSpeech, [meaning, ...], [[meaning, [back-translations], _, score], ...], baseForm].
  // Returns the meanings for display (most common first, very rare ones dropped), every meaning
  // for matching against the sentence, and the base form ("pasamos" → "pasar").
  const RARE_MEANING_SCORE = 0.001;
  const MEANINGS_SHOWN = 5;

  function parseDictionary(allEntries, word) {
    // Google sometimes ignores accents and answers for a different word
    // ("tomó" → "tomo" = volume, "sé" → "se", "está" → "esta" = this): drop those entries.
    const entries = allEntries.filter((e) => !accentTwin(e[3], word));
    const meanings = entries.map(([pos, words = [], scored = []]) => {
      const ranked = scored.length
        ? scored.map((x) => ({ w: x[0], score: x[3] || 0 })).sort((a, b) => b.score - a.score)
        : words.map((w) => ({ w, score: 0 }));
      return {
        pos,
        top: ranked[0]?.score || 0,
        words: ranked.filter((x, i) => i < 3 || x.score >= RARE_MEANING_SCORE).slice(0, MEANINGS_SHOWN).map((x) => x.w),
      };
    }).sort((a, b) => b.top - a.top);
    return {
      meanings,
      allMeanings: entries.flatMap((e) => e[1] || []),
      base: entries.find((e) => typeof e[3] === 'string')?.[3] || '',
    };
  }

  const stripAccents = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  function accentTwin(base, word) {
    return typeof base === 'string' && base.toLowerCase() !== word.toLowerCase()
      && stripAccents(base) === stripAccents(word);
  }

  // ---------- meaning in context ----------
  // Google translates whole sentences, so we have to work out which part of the
  // translation belongs to the clicked word. Steps, cheapest first:
  //  1. HTML alignment: send the sentence with the word in <b> tags (Google moves the tag to
  //     the matching words) and look up the word's dictionary meanings at the same time.
  //     If the tagged answer is one of those meanings, done ("Pedimos la cuenta" → "bill").
  //  2. Otherwise it may be a function word or part of an idiom. Try [brackets] too; if both
  //     agree, take the more complete one ("vale" → "is worth" rather than "is").
  //  3. Look for a dictionary meaning in the sentence translation ("¿Qué tiempo hace?" → "weather").
  //  4. Idioms: grow the brackets to include neighbouring words until Google keeps them
  //     ("[lo pasamos genial]" → "we had a great time"). Brackets keep whole phrases together,
  //     where HTML alignment would pick a single word ("un ojo" → "arm").
  //     A phrase answer ending on a dangling word ("we had a") keeps growing if it can.
  //  5. Give up: the best guess, the word's dictionary meanings, and the whole sentence.
  // Brackets answers must appear in the plain translation: they can break idioms
  // ("un [ojo] de la cara" → "an [eye] of the face").
  const GROW_STEPS = [[1, 0], [0, 1], [1, 1], [2, 0], [0, 2], [2, 1], [1, 2], [2, 2]]; // [left, right] words

  async function translateInContext(phrase, ctx, lang) {
    const to = lang.target;
    if (!ctx) {
      const r = await google(phrase, lang, true);
      return { kind: 'fallback', text: tidy(r.text, phrase, true, to), meanings: r.meanings, sentence: '', base: r.base };
    }
    const bracketed = (a, b) => google(markedText(ctx, a, b), lang)
      .then((r) => r.text.match(/\[([^[\]]+)\]/)?.[1].trim() || null)
      .catch(() => null);
    // at the start of the sentence, or of a question/exclamation inside it (Dice "¿De verdad?")
    const atStart = /^[\s¿¡"'«“(]*$|[¿¡][\s"'«“(]*$/.test(ctx.full.slice(ctx.s, ctx.start));
    const answer = (kind, text, extra) => ({ kind, text: tidy(text, phrase, atStart, to), base: dict?.base || '', sentence: plain, ...extra });

    // 1.
    const [tagged, dict] = await Promise.all([
      googleTagged(taggedText(ctx), lang).catch(() => null),
      google(phrase, lang, true).catch(() => null),
    ]);
    const meanings = dict?.allMeanings || [];
    const inTag = tagged?.inTag || '';
    const plain = tagged?.plain || (await google(sentenceText(ctx), lang)).text;
    if (inTag && relatesTo(inTag, meanings, to)) return answer('context', inTag);

    // 2.
    const inBrackets = await bracketed(ctx.start, ctx.end);
    const bracketsOk = !!inBrackets && appearsIn(plain, inBrackets, to);
    if (bracketsOk && inTag) {
      const best = appearsIn(inBrackets, inTag, to) ? inBrackets
        : appearsIn(inTag, inBrackets, to) ? inTag
          : relatesTo(inBrackets, meanings, to) ? inBrackets : inTag;
      return answer('context', best);
    }

    // 3.
    const hit = meanings.find((w) => appearsIn(plain, w, to));
    if (hit) return answer('context', hit);
    if (bracketsOk) return answer('context', inBrackets);

    // 4. (tried in two parallel batches, smallest phrases first)
    const { left, right } = wordsAround(ctx);
    const spans = GROW_STEPS
      .filter(([l, r]) => l <= left.length && r <= right.length)
      .map(([l, r]) => ({ a: l ? left[left.length - l].a : ctx.start, b: r ? right[r - 1].b : ctx.end }));
    let cutOff = null; // first match that ends on a dangling word, used if nothing better turns up
    for (const batch of [spans.slice(0, 3), spans.slice(3)]) {
      const found = await Promise.all(batch.map((sp) => bracketed(sp.a, sp.b)));
      for (const [i, t] of found.entries()) {
        if (!t || !appearsIn(plain, t, to)) continue;
        if (!endsDangling(t, to)) return answer('phrase', t, { span: batch[i] });
        cutOff ??= { t, span: batch[i] };
      }
    }
    if (cutOff) return answer('phrase', cutOff.t, { span: cutOff.span });

    // 5.
    return { kind: 'fallback', text: tidy(inTag || dict?.text || '?', phrase, atStart, to), meanings: dict?.meanings || [], sentence: plain, base: dict?.base || '' };
  }

  // Is `answer` one of the dictionary meanings (sharing a real word, not just "the"/"is")?
  // With no dictionary data we can't tell, so trust it.
  const FILLER_WORDS = {
    en: 'a an the to of i you he she it we they is am are be do not have has will would',
    es: 'el la los las un una de a al del que y o se lo le me te es son ser estar no',
  };
  const fillerCache = {};
  // (`to`: the language the answer is in, here and in the helpers below)
  function relatesTo(answer, meanings, to) {
    if (!meanings.length) return true;
    const filler = (fillerCache[to] ??= new Set(normWords(FILLER_WORDS[to], to)));
    const known = new Set(meanings.flatMap((m) => normWords(m, to)));
    return normWords(answer, to).some((w) => !filler.has(w) && known.has(w));
  }

  // Small words a phrase translation shouldn't stop on.
  const DANGLING = {
    en: new Set(['a', 'an', 'the', 'to', 'of', 'very', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
      'at', 'in', 'on', 'for', 'with', 'and', 'or', 'but', 'is', 'are', 'was', 'were']),
    es: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'a', 'al', 'en', 'con',
      'por', 'para', 'muy', 'mi', 'tu', 'su', 'mis', 'tus', 'sus', 'y', 'o', 'que', 'es', 'son']),
  };

  function endsDangling(text, to) {
    const last = text.toLowerCase().match(/[\p{L}']+(?=[^\p{L}']*$)/u)?.[0];
    return !!last && DANGLING[to].has(last);
  }

  // Strip stray punctuation and the capital letter Google adds at the start of a sentence
  // ("You have to" → "you have to"), but keep "I"/"I'm" and capitals the original had (names).
  // A selection that ends with its own ? ! . or … keeps that mark, and the sentence's capital
  // if it starts the sentence too ("¿De verdad?" → "Really?"); Spanish gets its ¿ / ¡ back.
  function tidy(text, phrase, atSentenceStart, to) {
    let t = text.trim().replace(/^[\s.,;:!?¿¡"'“”«»()]+|[\s.,;:!?¿¡"'“”«»()]+$/g, '');
    if (!t) return text.trim();
    const ending = phrase.match(/[.?!…]+(?=[\s"'”»)]*$)/)?.[0];
    const nameLike = /^\p{Lu}/u.test(phrase) && !atSentenceStart;
    const startsSentence = atSentenceStart || /^[\s"'“«(]*[¿¡]/.test(phrase); // a quoted "¿…?" counts
    const keepsCapital = (to === 'en' && /^I(\b|')/.test(t)) || (ending && startsSentence);
    if (keepsCapital) t = t.charAt(0).toUpperCase() + t.slice(1);
    else if (!nameLike) t = t.charAt(0).toLowerCase() + t.slice(1);
    if (!ending) return t;
    // Spanish opens a whole question/exclamation with ¿ / ¡ (Google's were stripped above)
    const wholeClause = startsSentence || /^[\s"'“«(]*\p{Lu}/u.test(phrase);
    const opening = to === 'es' && wholeClause ? (ending.includes('?') ? '¿' : '') + (ending.includes('!') ? '¡' : '') : '';
    return opening + t + ending;
  }

  // Does `needle` appear (roughly, ignoring word endings) in `haystack`?
  function appearsIn(haystack, needle, to) {
    const have = new Set(normWords(haystack, to));
    const want = normWords(needle, to);
    return want.length > 0 && want.every((w) => have.has(w));
  }

  function normWords(text, to) {
    let t = text.toLowerCase().replace(/’/g, "'");
    if (to === 'en') {
      t = t.replace(/\bcan't\b/g, 'can not').replace(/\bwon't\b/g, 'will not').replace(/n't\b/g, ' not')
        .replace(/'re\b/g, ' are').replace(/'m\b/g, ' am').replace(/'ll\b/g, ' will')
        .replace(/'ve\b/g, ' have').replace(/'d\b/g, ' would').replace(/'s\b/g, ' is');
    }
    return (t.match(/[\p{L}\p{N}']+/gu) || []).map(stem);
  }

  // crude stem so "realized"/"realize", "hurts"/"hurt", "dolores"/"dolor" compare equal
  function stem(w) {
    w = w.normalize('NFD').replace(/\p{M}/gu, '');
    if (w.length > 4) w = w.replace(/(ies|es|s|ed|ing|ly)$/, '');
    return w.slice(0, 6);
  }

  // ---------- finding the word and its sentence ----------
  const wordChar = /[\p{L}\p{M}\p{N}'’-]/u;

  function caretAt(x, y) {
    if (quickOutAt(x, y)) { // the quick translator's output lives in our shadow root, out of the page's reach
      const p = document.caretPositionFromPoint?.(x, y, { shadowRoots: [shadow] });
      if (!p || !quick.out.contains(p.offsetNode)) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      return r;
    }
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const p = document.caretPositionFromPoint?.(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    return r;
  }

  function wordRangeAt(x, y) {
    const caret = caretAt(x, y);
    if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const node = caret.startContainer;
    const text = node.data;
    let start = caret.startOffset;
    let end = caret.startOffset;
    while (start > 0 && wordChar.test(text[start - 1])) start--;
    while (end < text.length && wordChar.test(text[end])) end++;
    // trim stray hyphens/apostrophes at the edges
    while (start < end && /['’-]/.test(text[start])) start++;
    while (end > start && /['’-]/.test(text[end - 1])) end--;
    if (start === end) return null;

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    // the caret API snaps to the nearest text, so make sure the click was really on the word
    const r = range.getBoundingClientRect();
    if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) return null;
    return range;
  }

  // Move a caret position outwards to the edge of the word it sits in (if any).
  function snapToWordEdge(node, offset, toEnd) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.data;
      if (toEnd) while (offset < t.length && wordChar.test(t[offset])) offset++;
      else while (offset > 0 && wordChar.test(t[offset - 1])) offset--;
    }
    return [node, offset];
  }

  // Range covering every whole word between two caret positions, in either drag direction.
  function wordSpan(a, b) {
    try {
      const probe = document.createRange();
      probe.setStart(a.startContainer, a.startOffset);
      const [first, last] = probe.comparePoint(b.startContainer, b.startOffset) < 0 ? [b, a] : [a, b];
      const range = document.createRange();
      range.setStart(...snapToWordEdge(first.startContainer, first.startOffset, false));
      range.setEnd(...snapToWordEdge(last.startContainer, last.startOffset, true));
      return range;
    } catch {
      return null; // points in different documents/shadow trees
    }
  }

  function blockAncestor(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const pdfPage = el?.closest('.textLayer'); // PDF reader: each page's text is one block
    if (pdfPage) return pdfPage;
    while (el && el !== document.body) {
      if (!getComputedStyle(el).display.startsWith('inline')) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  // Abbreviations that never end a sentence (lowercase, without the final period).
  const NON_FINAL_ABBREVIATIONS = {
    es: new Set(['sr', 'sra', 'srta', 'sres', 'sras', 'dr', 'dra', 'dres', 'don', 'dña', 'lic', 'lcdo',
      'lcda', 'ing', 'prof', 'profa', 'arq', 'gral', 'cnel', 'tte', 'cap', 'sto', 'sta', 'av', 'avda',
      'pza', 'núm', 'nro', 'pág', 'págs', 'tel', 'apdo', 'dpto', 'depto', 'ud', 'uds', 'vd', 'vds',
      'ee', 'ej', 'cía', 'fig', 'vol', 'art', 'admón', 'mr', 'mrs']),
    en: new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'sr', 'gen', 'col', 'capt', 'lt', 'sgt', 'rev',
      'hon', 'mt', 'vs', 'e.g', 'i.e', 'cf', 'fig', 'vol', 'pp', 'approx', 'dept', 'est']),
  };

  function endsWithNonFinal(sentence, abbrevs) {
    const m = sentence.trimEnd().match(/(\S+)\.$/);
    if (!m) return false;
    const token = m[1].replace(/^[([¿¡"'«“]+/, '').toLowerCase();
    if (/^\p{L}$/u.test(token)) return true; // single letters: "J. K. Rowling", "p. ej."
    return abbrevs.has(token);
  }

  // Sentence spans [{ start, end }] of `text`. The browser's segmenter already avoids
  // splitting before a lowercase word ("casa... y se durmió", "EE. UU. el lunes"), but it
  // doesn't know abbreviations, so pieces ending in one ("Sr.", "Dra.", "J.") get rejoined.
  // Text without sentence punctuation (tables of contents, lists, headings) gets extra breaks:
  // after dot leaders ("Capítulo 4 ........ 7"), and, in PDFs (pdfLines), at a real line end
  // ("\n", see joinPdfLines) when the next line starts with a capital or a number. Sentences
  // that merely wrapped onto the next line were already joined with a space.
  function splitSentences(text, lang, pdfLines = false) {
    const abbrevs = NON_FINAL_ABBREVIATIONS[lang];
    // same-length whitespace normalisation: line breaks in the HTML source aren't real breaks
    const flat = text.replace(/\s/g, ' ');
    const out = [];
    for (const seg of new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(flat)) {
      const prev = out.at(-1);
      const end = seg.index + seg.segment.length;
      if (prev && endsWithNonFinal(flat.slice(prev.start, prev.end), abbrevs)) prev.end = end;
      else out.push({ start: seg.index, end });
    }
    const hardBreaks = [...text.matchAll(/\.{4,}\s*\d*/g)].map((m) => m.index + m[0].length);
    if (pdfLines) {
      for (const m of text.matchAll(/\n(?=\s*[\p{Lu}\p{N}¿¡])/gu)) hardBreaks.push(m.index + 1);
    }
    return out.flatMap((p) => {
      const cuts = hardBreaks.filter((i) => i > p.start && i < p.end).sort((a, b) => a - b);
      return [p.start, ...cuts].map((start, i) => ({ start, end: cuts[i] ?? p.end }));
    });
  }

  // Where the word/phrase sits: its block element, the block's text, the sentence span
  // [s, e) and the word span [start, end), all as offsets into that text. null if unusable.
  function sentenceAround(range, source) {
    const block = blockAncestor(range.commonAncestorContainer);
    if (!block.contains(range.startContainer) || !block.contains(range.endContainer)) return null;

    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const full = block.textContent;
    const start = before.toString().length;
    const end = start + range.toString().length;
    if (!full.slice(start, end).trim()) return null;

    const hits = splitSentences(full, source, block.classList.contains('textLayer')).filter((p) => p.end > start && p.start < end);
    let s = hits.length ? hits[0].start : 0;
    let e = hits.length ? hits.at(-1).end : full.length;
    if (e - s > MAX_SENTENCE_CHARS) { // very long "sentence" (lists, no punctuation): keep a window
      s = Math.max(s, start - MAX_SENTENCE_CHARS / 2);
      e = Math.min(e, end + MAX_SENTENCE_CHARS / 2);
    }
    return { block, full, s, e, start, end };
  }

  const clean = (t) => t.replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')')).replace(/\s+/g, ' ');

  function sentenceText(ctx) {
    return clean(ctx.full.slice(ctx.s, ctx.e)).trim();
  }

  // The sentence with [a, b) wrapped in brackets.
  function markedText(ctx, a, b) {
    const { full, s, e } = ctx;
    return `${clean(full.slice(s, a)).trimStart()}[${clean(full.slice(a, b)).trim()}]${clean(full.slice(b, e)).trimEnd()}`.trim();
  }

  // The sentence as HTML with [start, end) wrapped in <b> tags.
  function taggedText(ctx) {
    const { full, s, e, start, end } = ctx;
    const esc = (t) => clean(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `${esc(full.slice(s, start)).trimStart()}<b>${esc(full.slice(start, end)).trim()}</b>${esc(full.slice(end, e)).trimEnd()}`.trim();
  }

  // Word spans before and after the clicked word/phrase, within the sentence.
  function wordsAround(ctx) {
    const words = [...ctx.full.slice(ctx.s, ctx.e).matchAll(/[\p{L}\p{M}\p{N}'’-]+/gu)]
      .map((m) => ({ a: ctx.s + m.index, b: ctx.s + m.index + m[0].length }));
    return { left: words.filter((w) => w.b <= ctx.start), right: words.filter((w) => w.a >= ctx.end) };
  }

  // DOM range for text offsets [a, b) inside `block`.
  function rangeFromOffsets(block, a, b) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let pos = 0;
    let started = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = n.data.length;
      if (!started && a <= pos + len) { range.setStart(n, a - pos); started = true; }
      if (started && b <= pos + len) { range.setEnd(n, b - pos); return range; }
      pos += len;
    }
    return null;
  }

  // ---------- UI ----------
  const pageStyle = document.createElement('style');
  pageStyle.textContent =
    '::highlight(lector-hover) { background-color: rgba(149, 102, 230, .25); }' +
    '::highlight(lector-word) { background-color: rgba(149, 102, 230, .5); }' +
    '::highlight(lector-seen) { text-decoration: underline dotted rgb(149, 102, 230); text-decoration-thickness: 2px; }';
  document.head.appendChild(pageStyle);

  // Popup lives in a shadow root so the page's CSS can't mess with it.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  // Built with DOM calls, not innerHTML: sites with Trusted Types (YouTube, Gmail…) block innerHTML.
  const shadowStyle = document.createElement('style');
  shadowStyle.textContent = `
      .tip { position: absolute; width: max-content; max-width: 320px; min-width: 120px; box-sizing: border-box;
        background: #1f2430; color: #f2f2f2; font: 14px/1.4 system-ui, sans-serif;
        padding: 8px 10px; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.35);
        border-left: 3px solid #4a5160; }
      .tip[data-kind="context"] { border-left-color: #81c784; }
      .tip[data-kind="phrase"] { border-left-color: #8fb4ff; }
      .tip[data-kind="fallback"] { border-left-color: #e0b25c; }
      .tip[data-kind="error"] { border-left-color: #ff8a80; }
      .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .orig { color: #9aa3b2; font-size: 12px; }
      .base { color: #c9cfda; font-style: italic; }
      .tag { font-size: 11px; white-space: nowrap; }
      .st-loading { color: #9aa3b2; }
      .st-context { color: #81c784; }
      .st-phrase { color: #8fb4ff; }
      .st-fallback { color: #e0b25c; }
      .st-error { color: #ff8a80; }
      .main { font-size: 16px; font-weight: 600; margin-top: 2px; }
      .details { margin-top: 6px; padding-top: 6px; border-top: 1px solid #343b4b;
        display: grid; gap: 2px; }
      .detail { color: #d6dbe4; font-size: 13px; }
      .label { color: #8fb4ff; }
      .err { color: #ff8a80; }
      .pair { display: grid; grid-template-columns: auto 1fr; gap: 3px 8px; font-size: 12px; line-height: 1.45; }
      .detail + .pair { margin-top: 4px; }
      .lang { color: #6f7a8c; font-size: 10px; padding-top: 2px; }
      .src { color: #9aa3b2; }
      .dst { color: #d6dbe4; }
      .hl { background: rgba(167, 125, 240, .4); color: inherit; border-radius: 3px; padding: 0 2px; }
      .toggle { margin-top: 6px; font-size: 12px; color: #9aa3b2; cursor: pointer; user-select: none; }
      .toggle:hover { color: #d6dbe4; }
      .say { all: unset; cursor: pointer; margin-left: 6px; padding: 0 3px; border-radius: 4px; font-size: 12px; opacity: .75; }
      .say:hover { opacity: 1; }
      .say.loading { animation: lector-pulse .9s ease-in-out infinite; }
      .say.playing { opacity: 1; background: rgba(167, 125, 240, .35); box-shadow: 0 0 6px rgba(167, 125, 240, .7); }
      .say.failed { opacity: .9; }
      @keyframes lector-pulse { 50% { opacity: .2; } }
      .retry { all: unset; cursor: pointer; display: inline-block; margin-top: 8px; padding: 2px 10px; border-radius: 5px;
        background: #343b4b; color: #f2f2f2; font-size: 12px; }
      .retry:hover { background: #46506a; }
      .retry:disabled { opacity: .4; cursor: default; }
      .dict { display: block; margin-top: 6px; text-align: right; font-size: 11px; color: #8fb4ff;
        text-decoration: none; }
      .dict:hover { text-decoration: underline; }
      .readerbar { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 1;
        background: #1f2430; color: #f2f2f2; font: 13px system-ui, sans-serif; padding: 5px 10px;
        border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
      .readerstatus { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
      .readerbar button { all: unset; cursor: pointer; padding: 1px 9px; border-radius: 5px; background: #343b4b; }
      .readerbar button:hover { background: #46506a; }
      .readerbar input, .readerbar select { width: 3.2em; background: #2a3040; color: #f2f2f2; border: 1px solid #46506a;
        border-radius: 4px; padding: 1px 4px; font: inherit; }
      .readerbar select { width: auto; max-width: 16em; }
      .recent { margin-top: 8px; padding-top: 6px; border-top: 1px solid #343b4b; min-width: 24em; }
      .recenthead { color: #9aa3b5; font-size: 12px; margin: 0 0 4px 8px; }
      .recentrow { display: flex; gap: 2px; }
      .readerbar .recentopen { flex: 1; display: flex; justify-content: space-between; gap: 16px; padding: 5px 8px; background: transparent; }
      .readerbar .recentopen:hover, .readerbar .recentremove:hover { background: #343b4b; }
      .recenttitle { max-width: 22em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .recentwhere { color: #9aa3b5; white-space: nowrap; }
      .readerbar .recentremove { background: transparent; color: #9aa3b5; }
      .pdfzoom { min-width: 3.2em; text-align: center; }
      .pdfsep { width: 10px; }
      [hidden] { display: none !important; } /* the display rules below would otherwise beat it */
      .tip { z-index: 3; }
      .dirpill { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 1;
        display: flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; border-radius: 8px;
        background: #6a3fb5; color: #fff; font: 12px system-ui, sans-serif; white-space: nowrap;
        box-shadow: 0 4px 14px rgba(0,0,0,.3); }
      .dirpill.busy { background: #b7791f; }
      .dirpill button { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; }
      .dirpill button:hover { background: rgba(255,255,255,.2); }
      .dirlabel { font-weight: 600; letter-spacing: .02em; }
      .readerbar .dirpill { position: static; transform: none; display: inline-flex; margin-left: 10px;
        padding: 0 0 0 8px; box-shadow: none; }
      .readerbar .dirpill button { padding: 0 6px; background: transparent; }
      .readerbar .dirpill button:hover { background: rgba(255,255,255,.2); }
      .qbox { position: fixed; z-index: 2;
        width: min(440px, calc(100vw - 32px)); box-sizing: border-box; overflow: hidden;
        background: #1f2430; color: #f2f2f2; font: 14px/1.4 system-ui, sans-serif;
        border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.45); }
      .qhead { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; cursor: move;
        background: #2a3040; user-select: none; }
      .qdir { font-size: 12px; font-weight: 600; color: #c9b8f0; letter-spacing: .02em; }
      .qhead button { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; color: #d6dbe4; }
      .qhead button:hover { background: #46506a; }
      .qspace { flex: 1; }
      .qin { display: block; box-sizing: border-box; width: calc(100% - 20px); margin: 10px; height: 4.6em;
        resize: vertical; padding: 6px 8px; font: inherit; color: #f2f2f2; background: #2a3040;
        border: 1px solid #46506a; border-radius: 6px; outline: none; }
      .qin:focus { border-color: #9566e6; }
      .qrow { display: flex; align-items: flex-start; gap: 4px; padding: 0 10px 10px 12px; }
      .qout { flex: 1; min-height: 1.4em; max-height: 40vh; overflow: auto; white-space: pre-wrap;
        font-size: 15px; cursor: default; }
      .qout:empty::before { content: 'Press Enter to translate'; color: #6f7a8c; font-size: 13px; }
      .qout.err { color: #ff8a80; font-size: 13px; }
      .qwords { padding: 6px 10px 10px 12px; border-top: 1px solid #343b4b; }
      .qwordshead { display: flex; align-items: center; color: #9aa3b5; font-size: 12px; margin-bottom: 2px; }
      .qwordsclear { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; }
      .qwordsclear:hover { background: #46506a; color: #d6dbe4; }
      .qwordrows { max-height: 30vh; overflow: auto; }
      .qwordrow { display: flex; align-items: baseline; gap: 2px; padding: 2px 0; }
      .qwordtext { flex: 1; overflow-wrap: anywhere; }
      .qword { font-weight: 600; }
      .qwordanswer { color: #d6dbe4; }
      .qactions { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid #343b4b; }
      .qactions button, .qbook { all: unset; cursor: pointer; border-radius: 6px; font-size: 13px; }
      .qactions button { padding: 4px 10px; background: #343b4b; }
      .qactions button:hover { background: #46506a; }
      .qbooks:empty { display: none; }
      .qbooks { padding: 0 6px 8px; }
      .qbookshead { color: #9aa3b5; font-size: 12px; margin: 0 0 2px 6px; }
      .qbook { display: flex; justify-content: space-between; gap: 16px; padding: 4px 6px; width: 100%; box-sizing: border-box; }
      .qbook:hover { background: #343b4b; }
      .qbooktitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .qbookwhere { color: #9aa3b5; white-space: nowrap; }
      ::highlight(lector-hover) { background-color: rgba(149, 102, 230, .35); }
      ::highlight(lector-word) { background-color: rgba(149, 102, 230, .6); }`;
  const tipEl = el('div', 'tip');
  tipEl.hidden = true;
  shadow.append(shadowStyle, tipEl);
  document.body.appendChild(host);

  let lookupId = 0;
  let tipFromQuickBox = false; // the popup is for a word in the quick translator (closes with it)

  function hideTip() {
    lookupId++;
    tipEl.hidden = true;
    if (window.CSS?.highlights) CSS.highlights.delete('lector-word');
  }

  function placeTip(rect) {
    const gap = 6;
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - 8);
    left = Math.max(8, left);
    let top = rect.bottom + gap;
    if (top + h > window.innerHeight && rect.top - gap - h > 0) top = rect.top - gap - h;
    tipEl.style.left = `${window.scrollX + left}px`;
    tipEl.style.top = `${window.scrollY + top}px`;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Strong purple on the word/phrase being translated (or being dragged over).
  function markWord(range) {
    if (!window.CSS?.highlights) return;
    const h = new Highlight(range);
    h.priority = 1; // paint over the light hover purple
    CSS.highlights.set('lector-word', h);
  }

  // Dotted underline on every word/phrase looked up since the page loaded, wherever it appears
  // on the page (capitals ignored, accents not). Kept in memory only (reader tabs: in the tab's
  // storage, so a reload keeps them) and shown only in reading mode; text added later (infinite scroll, PDF pages) gets marked too. In an EPUB only the
  // text around the screen is marked (redone as you scroll), so a long book costs no more than
  // a short one; a PDF only has text for the few pages currently drawn anyway.
  const seen = new Set();
  const SEEN_RESCAN_MS = 300;
  const SEEN_WINDOW_CHARS = 40_000; // EPUB: text marked on each side of the screen's middle
  const SEEN_TAB_KEY = 'lector-seen';
  const NO_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE']);
  let seenTimer = 0;
  const seenObserver = new MutationObserver(() => queueMarkSeen());

  function queueMarkSeen() {
    if (enabled && seen.size) seenTimer ||= setTimeout(markSeen, SEEN_RESCAN_MS);
  }

  function rememberSeen(phrase) {
    const key = phrase.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (seen.size === 1) seenObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    if (isReaderTab || isTextTab) tabStore.set(SEEN_TAB_KEY, JSON.stringify([...seen])); // reader tabs keep them across a reload
    markSeen();
  }

  function restoreSeen() {
    let saved = [];
    try { saved = JSON.parse(tabStore.get(SEEN_TAB_KEY)) || []; } catch { /* nothing usable saved */ }
    for (const key of saved) seen.add(key);
    if (seen.size) seenObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function seenTextNodes() {
    const root = epubReader?.container || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (NO_TEXT_TAGS.has(n.parentElement?.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const after = [];
    if (!epubReader) {
      for (let n; (n = walker.nextNode());) after.push(n);
      return after;
    }
    // start from the text in the middle of the screen (or the current chapter's first text)
    const caret = caretAt(window.innerWidth / 2, window.innerHeight / 2);
    const middle = caret?.startContainer;
    if (middle?.nodeType === Node.TEXT_NODE && root.contains(middle)) {
      walker.currentNode = middle;
    } else {
      walker.currentNode = epubReader.chapters[epubPlace().chapter];
      if (!walker.nextNode()) return after;
    }
    const start = walker.currentNode;
    const before = [];
    for (let n, chars = 0; chars < SEEN_WINDOW_CHARS && (n = walker.previousNode());) { before.push(n); chars += n.data.length; }
    walker.currentNode = start;
    after.push(start);
    for (let n, chars = 0; chars < SEEN_WINDOW_CHARS && (n = walker.nextNode());) { after.push(n); chars += n.data.length; }
    return before.reverse().concat(after);
  }

  function markSeen() {
    clearTimeout(seenTimer);
    seenTimer = 0;
    if (!enabled || !seen.size || !window.CSS?.highlights) return;
    // all page text as one string, '\u0001' between text nodes, so phrases can cross tags
    const nodes = [];
    const starts = [];
    let text = '';
    for (const n of seenTextNodes()) {
      nodes.push(n);
      starts.push(text.length);
      text += `${n.data}\u0001`;
    }
    // longest first, so a phrase wins over a word inside it
    const patterns = [...seen].sort((a, b) => b.length - a.length)
      .map((p) => p.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\u0001]+'));
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}]['’-]?)(?:${patterns.join('|')})(?!['’-]?[\\p{L}\\p{M}\\p{N}])`, 'giu');
    const highlight = new Highlight();
    let i = 0;
    for (const m of text.matchAll(re)) {
      const end = m.index + m[0].length;
      while (starts[i + 1] <= m.index) i++;
      let j = i;
      while (starts[j + 1] < end) j++;
      const range = document.createRange();
      range.setStart(nodes[i], m.index - starts[i]);
      range.setEnd(nodes[j], end - starts[j]);
      highlight.add(range);
    }
    CSS.highlights.set('lector-seen', highlight);
  }

  async function lookup(range, phrase) {
    const id = ++lookupId;
    const rect = range.getBoundingClientRect();
    // a word in the quick translator's output is looked up back into the box's input language
    const inQuickBox = quick.out.contains(range.startContainer);
    tipFromQuickBox = inQuickBox;
    const lang = inQuickBox ? langPair(!quick.reversed) : pageLang();
    const ctx = sentenceAround(range, lang.source);
    markWord(range);
    if (!inQuickBox) rememberSeen(phrase); // underlines are for the page's own text

    renderTip(phrase, 'loading', '…');
    tipEl.hidden = false;
    placeTip(rect);

    let result;
    try {
      result = await translateInContext(phrase, ctx, lang);
    } catch (e) {
      if (id !== lookupId) return;
      showError(e, id, rect, () => lookup(range, phrase), phrase);
      return;
    }
    if (id !== lookupId) return; // user clicked something else meanwhile

    const details = [];
    const phraseText = result.kind === 'phrase' ? clean(ctx.full.slice(result.span.a, result.span.b)).trim() : phrase;
    if (result.kind === 'phrase') {
      details.push(detail('phrase: ', phraseText));
      const phraseRange = rangeFromOffsets(ctx.block, result.span.a, result.span.b);
      if (phraseRange) markWord(phraseRange);
    }
    const span = result.span || (ctx && { a: ctx.start, b: ctx.end });
    const pair = () => sentencePair(ctx, span, result.sentence, result.text, lang);
    if (result.kind === 'fallback') {
      for (const { pos, words } of result.meanings) details.push(detail(`${pos}: `, words.join(', ')));
      if (ctx && result.sentence) details.push(pair());
    }
    const base = result.base && result.base.toLowerCase() !== phrase.toLowerCase() ? result.base : '';
    renderTip(phrase, result.kind, result.text, details, base);
    tipEl.querySelector('.orig').append(sayButton(phrase, lang.source));
    if (!inQuickBox) tipEl.querySelector('.orig').append(saveButton({ text: phraseText, base, answer: result.text, lang: lang.source }));
    if (result.kind !== 'fallback' && ctx && result.sentence) tipEl.append(sentenceToggle(pair, rect));
    tipEl.append(dictionaryLink(phraseText));
    placeTip(rect);
  }

  //   banco                        ✕ error
  //   Google is busy — try again in 1:42
  //   [ Retry ]          (enabled once the countdown ends)
  function showError(err, id, rect, retry, phrase) {
    const busy = err.busyUntil && err.busyUntil > Date.now();
    renderTip(phrase, 'error', busy ? `Google is busy — try again in ${countdown(err.busyUntil)}` : err.message);
    const btn = el('button', 'retry', 'Retry');
    btn.onclick = (e) => { e.stopPropagation(); retry(); };
    tipEl.append(btn);
    placeTip(rect);
    if (!busy) return;
    btn.disabled = true;
    const timer = setInterval(() => {
      if (id !== lookupId) { clearInterval(timer); return; } // popup moved on
      const main = tipEl.querySelector('.main');
      if (Date.now() >= err.busyUntil) {
        clearInterval(timer);
        main.textContent = 'Google should accept requests again.';
        btn.disabled = false;
      } else main.textContent = `Google is busy — try again in ${countdown(err.busyUntil)}`;
    }, 1000);
  }

  // Every popup has the same layout:
  //   [clicked text · base form]          [status tag]
  //   [answer]
  //   [details: phrase, then dictionary meanings, then the sentence — only those that apply]
  const STATUS = {
    loading: { label: '…', cls: 'st-loading' },
    context: { label: '✓ in context', cls: 'st-context' },
    phrase: { label: '◐ from phrase', cls: 'st-phrase' },
    fallback: { label: '? not sure', cls: 'st-fallback' },
    error: { label: '✕ error', cls: 'st-error' },
  };

  function renderTip(phrase, kind, answer, details = [], base = '') {
    const status = STATUS[kind];
    tipEl.dataset.kind = kind; // colours the left edge to match the status
    const head = el('div', 'head');
    const orig = el('span', 'orig', phrase);
    if (base) orig.append(el('span', 'base', ` · ${base}`));
    head.append(orig, el('span', `tag ${status.cls}`, status.label));
    tipEl.replaceChildren(head, el('div', kind === 'error' ? 'main err' : 'main', answer));
    if (details.length) {
      const box = el('div', 'details');
      box.append(...details);
      tipEl.append(box);
    }
  }

  // Collapsed "▸ sentence" row; clicking it shows the original and translated sentence
  // (the translation was already fetched while working out the word, so this costs nothing).
  function sentenceToggle(makePair, rect) {
    const row = el('div', 'toggle', '▸ sentence');
    row.onclick = () => {
      const box = el('div', 'details');
      box.append(makePair());
      row.replaceWith(box);
      placeTip(rect);
    };
    return row;
  }

  // Original sentence above its translation, with the clicked word/phrase highlighted in the
  // original and the matching words highlighted in the translation.
  //   ES  Me senté en el [banco] del parque.
  //   EN  I sat on the park [bench].
  function sentencePair(ctx, span, translated, answer, lang) {
    const { full, s, e } = ctx;
    const original = [clean(full.slice(s, span.a)).trimStart(), clean(full.slice(span.a, span.b)).trim(),
      clean(full.slice(span.b, e)).trimEnd()];
    const at = locate(translated, answer, lang.target);
    const english = at ? [translated.slice(0, at[0]), translated.slice(at[0], at[1]), translated.slice(at[1])] : [translated, '', ''];
    const src = marked('src', original);
    src.append(sayButton(original.join(''), lang.source));
    const pair = el('div', 'pair');
    pair.append(el('span', 'lang', lang.source.toUpperCase()), src,
      el('span', 'lang', lang.target.toUpperCase()), marked('dst', english));
    return pair;
  }

  function marked(cls, [before, hit, after]) {
    const line = el('span', cls);
    line.append(before);
    if (hit) line.append(el('mark', 'hl', hit));
    line.append(after);
    return line;
  }

  // Where `needle` sits in `haystack`: exact (ignoring case) if possible, otherwise the
  // shortest run of words that contains all its words ("it is" in "It's very cold").
  function locate(haystack, needle, to) {
    if (!needle) return null;
    const i = haystack.toLowerCase().indexOf(needle.toLowerCase());
    if (i >= 0) return [i, i + needle.length];
    const want = normWords(needle, to);
    const words = [...haystack.matchAll(/[\p{L}\p{N}'’]+/gu)];
    let best = null;
    for (let a = 0; a < words.length; a++) {
      for (let b = a; b < Math.min(words.length, a + want.length + 3); b++) {
        const got = new Set(normWords(words.slice(a, b + 1).map((m) => m[0]).join(' '), to));
        if (!want.every((w) => got.has(w))) continue;
        const range = [words[a].index, words[b].index + words[b][0].length];
        if (!best || range[1] - range[0] < best[1] - best[0]) best = range;
        break;
      }
    }
    return best;
  }

  // ---------- pronunciation ----------
  // Google Translate's voice, fetched through Tampermonkey: Google refuses audio requests that
  // carry a referring site, which a normal <audio> on the page would send. Nothing is fetched
  // until 🔊 is clicked; clips are kept in memory so replays are free. Google's limit is about
  // 200 characters per clip, so longer text is spoken in chunks.
  const TTS_MAX_CHARS = 190;
  const TTS_CACHE_MAX = 60;
  const ttsCache = new Map(); // text → blob URL
  let nowPlaying = null;

  // 🔊 states: idle → .loading (pulses while fetching) → .playing (purple glow; click to stop)
  // → back to idle. On failure it becomes 🔇; hover says why, click to try again.
  function sayButton(text, lang) {
    const btn = el('button', 'say', '🔊');
    btn.title = 'Listen';
    btn.onclick = (e) => {
      e.stopPropagation();
      if (btn.classList.contains('playing')) { nowPlaying?.pause(); return; }
      btn.textContent = '🔊';
      btn.classList.remove('failed');
      btn.title = 'Listen';
      speak(text, lang, btn).catch((err) => {
        btn.textContent = '🔇';
        btn.classList.add('failed');
        btn.title = `No audio: ${err.message} (click to try again)`;
      });
    };
    return btn;
  }

  async function speak(text, lang, btn) {
    nowPlaying?.pause();
    btn.classList.add('loading');
    try {
      for (const chunk of speechChunks(text.trim())) {
        const audio = new Audio(await ttsClip(chunk, lang));
        nowPlaying = audio;
        btn.classList.replace('loading', 'playing');
        await new Promise((resolve, reject) => {
          audio.onpause = resolve; // also fires at the natural end
          audio.onerror = () => reject(new Error('this page blocks the audio'));
          audio.play().catch(reject);
        });
        if (!audio.ended) return; // stopped by a click or a newer 🔊
      }
    } finally {
      btn.classList.remove('loading', 'playing');
    }
  }

  async function ttsClip(text, lang) {
    const key = `${lang}|${text}`;
    if (ttsCache.has(key)) return ttsCache.get(key);
    const res = await request({
      method: 'GET',
      url: `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=${lang}&q=${encodeURIComponent(text)}`,
      responseType: 'arraybuffer',
    });
    if (res.status !== 200) throw new Error(`Google voice HTTP ${res.status}`);
    const url = URL.createObjectURL(new Blob([res.response], { type: 'audio/mpeg' }));
    ttsCache.set(key, url);
    if (ttsCache.size > TTS_CACHE_MAX) {
      const [oldKey, oldUrl] = ttsCache.entries().next().value;
      URL.revokeObjectURL(oldUrl);
      ttsCache.delete(oldKey);
    }
    return url;
  }

  // Split at spaces into pieces Google will accept.
  function speechChunks(text) {
    const chunks = [];
    let current = '';
    for (const word of text.split(/\s+/)) {
      if (current && (current + ' ' + word).length > TTS_MAX_CHARS) { chunks.push(current); current = word; }
      else current = current ? `${current} ${word}` : word;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // SpanishDict covers both directions and recognises conjugated forms ("pasamos" → pasar).
  function dictionaryLink(text) {
    const a = el('a', 'dict', 'SpanishDict ↗');
    a.href = `https://www.spanishdict.com/translate/${encodeURIComponent(text)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function detail(label, text) {
    const line = el('div', 'detail');
    line.append(el('span', 'label', label), text);
    return line;
  }

  function setEnabled(on) {
    enabled = on;
    if (on) markSeen();
    else { hideTip(); clearHover(); CSS.highlights?.delete('lector-seen'); }
    pill.el.hidden = !on;
    updatePill();
    showReadingButton();
  }

  // ---------- direction pill ----------
  // Fixed at the top centre while reading mode is on (in the book reader it sits at the end
  // of the reader bar instead):
  //   [ ES → EN   ⇄   ✕ ]              ⇄ swaps this tab's direction, ✕ turns reading mode off
  //   [ ⚠ Google busy · 1:42   ⇄   ✕ ]  while Google refuses requests (amber, counts down)
  const pill = (() => {
    const box = el('div', 'dirpill');
    box.hidden = true;
    const label = el('span', 'dirlabel');
    const swap = el('button', 'dirswap', '⇄');
    swap.title = 'Swap direction (this tab)';
    swap.onclick = () => {
      tabReversed = !tabReversed;
      tabStore.set(DIRECTION_TAB_KEY, tabReversed ? '1' : '0');
      GM_setValue(PAGE_DIRECTION_KEY, tabReversed);
      hideTip();
      updatePill();
    };
    const off = el('button', 'diroff', '✕');
    off.title = 'Turn reading mode off (Alt+T)';
    off.onclick = () => setEnabled(false);
    box.append(label, swap, off);
    shadow.append(box);
    return { el: box, label };
  })();

  let pillTimer = 0;
  function updatePill() {
    clearTimeout(pillTimer);
    const busy = Date.now() < googlePausedUntil;
    const { source, target } = pageLang();
    pill.el.classList.toggle('busy', busy);
    pill.label.textContent = busy ? `⚠ Google busy · ${countdown(googlePausedUntil)}` : `${source.toUpperCase()} → ${target.toUpperCase()}`;
    if (busy) pillTimer = setTimeout(updatePill, 1000);
  }

  // ---------- Lector panel (Alt+Shift+T) ----------
  // Opens centered under the direction pill (drag its header to move it; every tab reopens it
  // where it was left). A quick translator on top, then shortcuts:
  //   ┌ EN → ES   ⇄                          ✕ ┐
  //   │ [ how do I say this?                 ] │   Enter translates, Shift+Enter starts a new line
  //   │ ¿cómo digo esto?                 📋 🔊 │   click a word for the popup (back into the input language)
  //   │ Word list                    Clear all │   words saved with + on the popup, newest first
  //   │   como · comer — I eat           🔊 ✕ │   (hidden while empty)
  //   ├──────────────────────────────────────────┤
  //   │ [📖 PDF/EPUB] [📝 Pasted text] [Reading: off] │   the first two open new tabs
  //   │ Continue reading                         │   the last books, each reopens in a new tab
  //   │   Cien años de soledad      Capítulo 4   │
  //   └──────────────────────────────────────────┘
  // The translator's direction is the last one chosen in it anywhere (English → Spanish until
  // you first swap: reading Spanish → write in Spanish). Its text, and the direction that text
  // was translated in, are kept in the tab's storage (back after closing the panel or reloading). It stays open until Esc, ✕ or Alt+Shift+T (or a button that opens a
  // new tab).
  const QUICK_TAB_KEY = 'lector-quick';
  const PANEL_DIRECTION_KEY = 'panelReversed';
  const PANEL_POS_KEY = 'panelPos';
  const PANEL_TOP_PX = 48; // first-time spot: just under the direction pill
  const quick = (() => {
    const box = el('div', 'qbox');
    box.hidden = true;
    const head = el('div', 'qhead');
    const dir = el('span', 'qdir');
    const swap = el('button', 'qswap', '⇄');
    swap.title = 'Swap direction, and translate the translation back';
    const close = el('button', 'qclose', '✕');
    close.title = 'Close (Esc or Alt+Shift+T)';
    head.append(dir, swap, el('span', 'qspace'), close);
    const input = el('textarea', 'qin');
    input.spellcheck = false;
    input.placeholder = 'Type or paste, then press Enter';
    const row = el('div', 'qrow');
    const out = el('div', 'qout');
    row.append(out);
    const words = el('div', 'qwords');
    const wordsHead = el('div', 'qwordshead');
    const clearWords = el('button', 'qwordsclear', 'Clear all');
    wordsHead.append(el('span', 'qspace', 'Word list'), clearWords);
    const wordRows = el('div', 'qwordrows');
    words.append(wordsHead, wordRows);
    const actions = el('div', 'qactions');
    const openBook = el('button', 'qopenbook', '📖 PDF/EPUB');
    openBook.title = 'Open a PDF or EPUB to read (new tab)';
    const openText = el('button', 'qopentext', '📝 Pasted text');
    openText.title = 'Read pasted text (new tab)';
    const reading = el('button', 'qreading');
    reading.title = 'Turn reading mode on/off (Alt+T)';
    actions.append(openBook, openText, reading);
    const books = el('div', 'qbooks');
    box.append(head, input, row, words, actions, books);
    shadow.append(box);
    return { box, head, dir, swap, close, input, row, out, words, clearWords, wordRows, openBook, openText, reading, books, copy: null, say: null, reversed: false, opened: false };
  })();

  function toggleQuickBox() {
    if (!quick.box.hidden) { closeQuickBox(); return; }
    if (!quick.opened) restoreQuickBox();
    showPanelShortcuts();
    quick.box.hidden = false;
    placeQuickBox(GM_getValue(PANEL_POS_KEY, null));
    quick.input.focus();
  }

  function closeQuickBox() {
    if (tipFromQuickBox) hideTip();
    quick.box.hidden = true;
    clearHover();
  }

  // First opening in this tab: last text from the tab's storage, or empty in the last-chosen direction.
  function restoreQuickBox() {
    quick.opened = true;
    let saved = null;
    try { saved = JSON.parse(tabStore.get(QUICK_TAB_KEY)); } catch { /* nothing usable saved */ }
    quick.reversed = saved ? !!saved.reversed : GM_getValue(PANEL_DIRECTION_KEY, true);
    quick.input.value = saved?.input || '';
    showQuickOutput(saved?.output || '');
  }

  function saveQuickBox() {
    tabStore.set(QUICK_TAB_KEY, JSON.stringify({ reversed: quick.reversed, input: quick.input.value, output: quick.out.textContent }));
  }

  function showQuickOutput(text, isError = false) {
    const { source, target } = langPair(quick.reversed);
    quick.dir.textContent = `${source.toUpperCase()} → ${target.toUpperCase()}`;
    quick.out.textContent = text;
    quick.out.classList.toggle('err', isError);
    quick.copy?.remove();
    quick.say?.remove();
    quick.copy = quick.say = null;
    if (text && !isError && text !== '…') {
      quick.copy = copyButton(text);
      quick.say = sayButton(text, target);
      quick.say.classList.add('qsay');
      quick.row.append(quick.copy, quick.say);
    }
  }

  // 📋 → ✓ for a moment. The userscript manager's clipboard works on any page (the browser's
  // own needs https).
  const COPIED_SHOWN_MS = 1200;
  function copyButton(text) {
    const btn = el('button', 'say qcopy', '📋');
    btn.title = 'Copy the translation';
    btn.onclick = (e) => {
      e.stopPropagation();
      GM_setClipboard(text, 'text');
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '📋'; }, COPIED_SHOWN_MS);
    };
    return btn;
  }

  let quickId = 0;
  async function translateQuickBox() {
    const text = quick.input.value.trim();
    const id = ++quickId;
    hideTip();
    if (!text) { showQuickOutput(''); saveQuickBox(); return; }
    showQuickOutput('…');
    try {
      const r = await google(text, langPair(quick.reversed));
      if (id === quickId) showQuickOutput(r.text);
    } catch (e) {
      if (id !== quickId) return;
      showQuickOutput(e.busyUntil ? `Google is busy — try again in ${countdown(e.busyUntil)}` : e.message, true);
    }
    saveQuickBox();
  }

  // ---------- word list ----------
  // Words and phrases saved with + on the popup, for review in the panel. Kept in the tab's
  // storage like the translator's text: back after a reload, gone when the tab closes (and,
  // like all tab storage, separate for each site visited in the tab). Newest first; a word is
  // kept once per language, saving it again moves it to the top.
  const WORDS_TAB_KEY = 'lector-words';
  const wordKey = (w) => `${w.lang}:${w.text.toLowerCase()}`;

  function savedWords() {
    try { return JSON.parse(tabStore.get(WORDS_TAB_KEY)) || []; } catch { return []; }
  }

  function storeWords(words) {
    tabStore.set(WORDS_TAB_KEY, JSON.stringify(words));
    showWordList();
    tipEl.querySelector('.save')?.show(); // an open popup's +/✓ follows the panel's ✕ and Clear all
  }

  const isSaved = (w) => savedWords().some((s) => wordKey(s) === wordKey(w));
  const forgetWord = (w) => storeWords(savedWords().filter((s) => wordKey(s) !== wordKey(w)));

  // + on the popup: saves the word and becomes ✓; ✓ removes it again.
  function saveButton(word) {
    const btn = el('button', 'say save');
    const show = () => {
      const saved = isSaved(word);
      btn.textContent = saved ? '✓' : '+';
      btn.title = saved ? 'Saved to the word list (click to remove)' : 'Save to the word list (Alt+Shift+T)';
    };
    btn.show = show;
    btn.onclick = (e) => {
      e.stopPropagation();
      if (isSaved(word)) forgetWord(word);
      else storeWords([word, ...savedWords().filter((s) => wordKey(s) !== wordKey(word))]);
    };
    show();
    return btn;
  }

  //   Word list                    Clear all
  //   como · comer — I eat           🔊 ✕
  function showWordList() {
    const words = savedWords();
    quick.words.hidden = !words.length;
    quick.wordRows.replaceChildren(...words.map((w) => {
      const row = el('div', 'qwordrow');
      const text = el('span', 'qwordtext');
      text.append(el('span', 'qword', w.text));
      if (w.base) text.append(el('span', 'base', ` · ${w.base}`));
      text.append(el('span', 'qwordanswer', ` — ${w.answer}`));
      const say = sayButton(w.text, w.lang);
      say.classList.add('qwordsay');
      const remove = el('button', 'say qwordremove', '✕');
      remove.title = 'Remove from the list';
      remove.onclick = (e) => { e.stopPropagation(); forgetWord(w); };
      row.append(text, say, remove);
      return row;
    }));
  }

  // Reading mode button, the word list and the Continue reading list, as they are right now.
  function showPanelShortcuts() {
    showReadingButton();
    showWordList();
    quick.books.replaceChildren();
    const recent = GM_getValue(RECENT_LIST_KEY, []);
    if (!recent.length) return;
    quick.books.append(el('div', 'qbookshead', 'Continue reading'));
    for (const { key, title } of recent) {
      const open = el('button', 'qbook');
      open.append(el('span', 'qbooktitle', title), el('span', 'qbookwhere', savedPlace(key)?.label || ''));
      open.onclick = () => { closeQuickBox(); openReaderTab(`${READER_URL}?book=${encodeURIComponent(key)}`); };
      quick.books.append(open);
    }
  }

  function showReadingButton() {
    quick.reading.textContent = enabled ? 'Reading: on' : 'Reading: off';
  }

  // Centered under the pill unless it was dragged somewhere; always kept inside the window.
  function placeQuickBox(pos) {
    const { box } = quick;
    const maxLeft = Math.max(0, window.innerWidth - box.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - box.offsetHeight);
    const left = pos ? pos.left : maxLeft / 2;
    const top = pos ? pos.top : PANEL_TOP_PX;
    box.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    box.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
  }

  quick.head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const start = quick.box.getBoundingClientRect();
    const dx = e.clientX - start.left;
    const dy = e.clientY - start.top;
    quick.head.setPointerCapture(e.pointerId);
    const move = (m) => placeQuickBox({ left: m.clientX - dx, top: m.clientY - dy });
    const end = () => {
      quick.head.removeEventListener('pointermove', move);
      const r = quick.box.getBoundingClientRect();
      GM_setValue(PANEL_POS_KEY, { left: Math.round(r.left), top: Math.round(r.top) });
    };
    quick.head.addEventListener('pointermove', move);
    quick.head.addEventListener('pointerup', end, { once: true });
  });
  window.addEventListener('resize', () => { if (!quick.box.hidden) placeQuickBox(GM_getValue(PANEL_POS_KEY, null)); });

  quick.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); translateQuickBox(); }
  });
  quick.input.addEventListener('input', saveQuickBox);
  // Typing in the box is ours: the page doesn't get the keys (no "k" pausing a YouTube video).
  for (const type of ['keydown', 'keyup', 'keypress']) quick.box.addEventListener(type, (e) => e.stopPropagation());
  quick.close.onclick = closeQuickBox;
  quick.swap.onclick = () => {
    const translation = quick.out.classList.contains('err') ? '' : quick.out.textContent;
    quick.reversed = !quick.reversed;
    GM_setValue(PANEL_DIRECTION_KEY, quick.reversed);
    if (translation && translation !== '…') quick.input.value = translation;
    translateQuickBox();
    quick.input.focus();
  };
  // In a reader tab that hasn't opened anything yet, these show its file picker / paste box.
  quick.openBook.onclick = () => { closeQuickBox(); if (isReaderTab && !bookOpen) openBookReader(); else openReaderTab(READER_URL); };
  quick.openText.onclick = () => { closeQuickBox(); if (isTextTab) openTextReader(); else openReaderTab(TEXT_READER_URL); };
  quick.reading.onclick = () => setEnabled(!enabled);
  quick.clearWords.onclick = () => storeWords([]);

  // Is (x, y) over the quick translator's output text?
  function quickOutAt(x, y) {
    return !quick.box.hidden && !!shadow.elementFromPoint(x, y)?.closest('.qout');
  }

  // ---------- book reader (PDF / EPUB) ----------
  // Brave's own PDF viewer can't be reached by userscripts, so books are opened from the menu
  // ("Open a PDF or EPUB to read…"). That opens a reader tab on example.com: a plain page with
  // no security rules (many big sites, e.g. Google, block the code PDF.js needs). There you
  // pick a file and the tab becomes the reader; the normal hover/click/drag code works on it.
  const READER_URL = 'https://example.com/#lector-book';
  // '#lector-book?book=<key>' (from the panel's Continue reading list) opens that book.
  const isReaderTab = location.hostname === 'example.com' && /^#lector-book(\?|$)/.test(location.hash);
  const PDF_ZOOM_STEP = 1.15;
  const PDF_DRAW_MARGIN_PX = 1200; // pages are drawn when this close to the screen
  const PDF_KEEP_PAGES = 5; // drawings kept on each side of the current page (the rest are freed)
  // Where you were in each book, newest last; the oldest are dropped. Books are told apart by
  // the ID built into the file (PDF.js's fingerprint, the EPUB's identifier), so renaming a
  // file keeps its place.
  const READING_PLACES_KEY = 'readingPlaces';
  const MAX_READING_PLACES = 500;
  // The last few books opened are also kept as files in this page's own browser storage
  // (IndexedDB on example.com, on this computer only), so they reopen without the file picker.
  const BOOKS_DB = 'lector-books';
  const MAX_RECENT_BOOKS = 5;
  const TAB_BOOK_KEY = 'lector-book'; // the book open in this tab, so a reload reopens it
  if (isReaderTab && location.hash !== '#lector-book') { // opened the way a reload reopens a book
    const key = new URLSearchParams(location.hash.split('?')[1]).get('book');
    if (key) tabStore.set(TAB_BOOK_KEY, key);
    history.replaceState(null, '', '#lector-book');
  }

  // A normal browser tab: the file picker doesn't open in tabs made by Tampermonkey's
  // GM_openInTab, so don't switch to that.
  function openReaderTab(url) {
    if (!window.open(url, '_blank')) location.href = url; // popup blocked: use this tab
  }

  // The tab becomes a reader: drop the page's content and styles (not ours).
  function takeOverPage(title, css, background) {
    for (const n of [...document.body.childNodes]) if (n !== host) n.remove();
    document.querySelectorAll('style, link[rel~="stylesheet"]').forEach((n) => n !== pageStyle && n.remove());
    document.documentElement.style.cssText = 'height:auto;overflow:auto;';
    document.body.style.cssText = `margin:0;height:auto;overflow:auto;background:${background};`;
    document.title = title;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    window.scrollTo(0, 0);
  }

  function savedPlace(key) {
    return GM_getValue(READING_PLACES_KEY, {})[key];
  }

  function savePlace(key, place) {
    const all = GM_getValue(READING_PLACES_KEY, {});
    delete all[key];
    all[key] = place;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, keys.length - MAX_READING_PLACES)) delete all[k];
    GM_setValue(READING_PLACES_KEY, all);
  }

  // Runs `fn` on the stored books and resolves with the result of the request it returns.
  function booksStore(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(BOOKS_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('books', { keyPath: 'key' });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('books', mode);
        const req = fn(tx.objectStore('books'));
        tx.oncomplete = () => { db.close(); resolve(req?.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }

  // The book files can only be read on example.com, so the list itself ([{ key, title }],
  // newest first) is also copied to the userscript storage for the Lector panel on other sites.
  const RECENT_LIST_KEY = 'recentBookList';

  async function recentBooks() { // newest first
    try {
      const books = (await booksStore('readonly', (store) => store.getAll())).sort((a, b) => b.opened - a.opened);
      GM_setValue(RECENT_LIST_KEY, books.slice(0, MAX_RECENT_BOOKS).map(({ key, title }) => ({ key, title })));
      return books;
    } catch {
      return []; // storage blocked: just no list
    }
  }

  // Called once a book has opened: keep its file for the recent list, and note it as this
  // tab's book.
  async function rememberBook(key, title, blob) {
    tabStore.set(TAB_BOOK_KEY, key);
    try {
      await booksStore('readwrite', (store) => store.put({ key, title, blob, opened: Date.now() }));
      const extra = (await recentBooks()).slice(MAX_RECENT_BOOKS);
      if (extra.length) await booksStore('readwrite', (store) => { for (const b of extra) store.delete(b.key); });
    } catch { /* storage full or blocked: the book just isn't kept */ }
  }

  function forgetBook(key) {
    GM_setValue(RECENT_LIST_KEY, GM_getValue(RECENT_LIST_KEY, []).filter((b) => b.key !== key));
    booksStore('readwrite', (store) => store.delete(key)).catch(() => {});
  }

  let bookOpen = false;

  async function openBookReader() {
    if (bookOpen) return;
    bookOpen = true;
    const bar = readerBar();
    try {
      const recent = await recentBooks();
      const reloaded = recent.find((b) => b.key === tabStore.get(TAB_BOOK_KEY));
      const book = reloaded ? { name: reloaded.title, blob: reloaded.blob } : await chooseBook(bar, recent);
      bar.el.querySelector('.recent')?.remove();
      bar.status.textContent = `Loading ${book.name}…`;
      const data = new Uint8Array(await book.blob.arrayBuffer());
      const isZip = data[0] === 0x50 && data[1] === 0x4b; // "PK": EPUBs are zip files
      await (isZip ? openEpub : openPdf)(book, data, bar);
    } catch (e) {
      tabStore.remove(TAB_BOOK_KEY); // don't retry a broken book on every reload
      bar.el.querySelector('.recent')?.remove();
      bar.status.textContent = `Couldn't open the file: ${e.message}`;
      bookOpen = false;
      setTimeout(() => bar.el.remove(), 6000);
    }
  }

  //   Open a PDF or EPUB to read: [Choose another file…] [Cancel]
  //   Continue reading
  //   Cien años de soledad          Capítulo 4   ✕
  //   gramatica.pdf                p. 37 / 210   ✕
  // Resolves with { name, blob } for the book to open.
  function chooseBook(bar, recent) {
    return new Promise((resolve, reject) => {
      const input = el('input');
      input.type = 'file';
      input.accept = 'application/pdf,.pdf,application/epub+zip,.epub';
      input.onchange = () => (input.files[0] ? resolve({ name: input.files[0].name, blob: input.files[0] }) : reject(new Error('no file chosen')));
      const choose = el('button', null, recent.length ? 'Choose another file…' : 'Choose file…');
      const cancel = el('button', null, 'Cancel');
      choose.onclick = () => input.click();
      cancel.onclick = () => reject(new Error('cancelled'));
      bar.status.replaceChildren('Open a PDF or EPUB to read:', choose, cancel);
      if (!recent.length) return;
      const list = el('div', 'recent');
      list.append(el('div', 'recenthead', 'Continue reading'));
      for (const book of recent) {
        const row = el('div', 'recentrow');
        const open = el('button', 'recentopen');
        open.append(el('span', 'recenttitle', book.title), el('span', 'recentwhere', savedPlace(book.key)?.label || ''));
        open.onclick = () => resolve({ name: book.title, blob: book.blob });
        const remove = el('button', 'recentremove', '✕');
        remove.title = 'Remove from this list';
        remove.onclick = () => {
          forgetBook(book.key);
          row.remove();
          if (!list.querySelector('.recentrow')) list.remove();
        };
        row.append(open, remove);
        list.append(row);
      }
      bar.el.append(list);
    });
  }

  // Chapter dropdown from a book's table of contents ({ title, depth } entries, in reading
  // order); sub-sections are indented.
  function tocPicker(entries, onPick) {
    const select = el('select');
    entries.forEach((e, i) => {
      const label = '\u00a0\u00a0\u00a0'.repeat(e.depth) + (e.title.length > 70 ? `${e.title.slice(0, 69)}…` : e.title);
      select.append(Object.assign(el('option', null, label), { value: i }));
    });
    select.onchange = () => onPick(entries[+select.value]);
    return select;
  }

  // Dark mode for the book reader, one setting for all books; until you choose, it follows the
  // system's light/dark setting. PDF pages are drawings, so they're shown with their colours
  // inverted (photos and coloured figures look like negatives); EPUB text is light on dark.
  const READER_DARK_KEY = 'readerDark';
  const READER_BACKGROUNDS = { pdf: ['#525659', '#1f2023'], epub: ['#faf8f4', '#1c1b19'] }; // [light, dark]

  function readerDark() {
    return GM_getValue(READER_DARK_KEY, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  }

  function applyReaderTheme(kind) {
    const dark = readerDark();
    document.documentElement.classList.toggle('lector-dark', dark);
    document.body.style.background = READER_BACKGROUNDS[kind][dark ? 1 : 0];
  }

  function themeButton(kind) {
    const button = el('button');
    const show = () => {
      button.textContent = readerDark() ? '☀' : '☾';
      button.title = readerDark() ? 'Light mode' : 'Dark mode';
    };
    button.onclick = () => {
      GM_setValue(READER_DARK_KEY, !readerDark());
      applyReaderTheme(kind);
      show();
    };
    show();
    return button;
  }

  // Ctrl +/− zooms the book, not the browser.
  function zoomKeys(zoomOut, zoomIn) {
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !['+', '=', '-'].includes(e.key)) return;
      e.preventDefault();
      (e.key === '-' ? zoomOut : zoomIn).click();
    }, true);
  }

  // ---------- PDF ----------
  // PDF.js (downloaded once, then kept in Tampermonkey's storage) draws each page on a canvas
  // with an invisible text layer on top.
  let pdfjs = null;
  // pdfReader: { doc, scale, pages: [{ div, rendered }], sizes: [{ width, height } at zoom 1],
  //              observer, placeKey }
  let pdfReader = null;

  async function openPdf(book, data, bar) {
    pdfReader = { doc: null, scale: 1, pages: [], sizes: [] };
    // isEvalSupported: false closes CVE-2024-4367 (a crafted PDF could run code via font eval
    // in PDF.js ≤ 4.1.392, which includes the 3.11 build used here).
    pdfReader.doc = await (await loadPdfJs()).getDocument({ data, isEvalSupported: false }).promise;
    pdfReader.placeKey = pdfReader.doc.fingerprints[0];
    rememberBook(pdfReader.placeKey, book.name, book.blob);
    const place = savedPlace(pdfReader.placeKey) || {}; // { page, scale, label }
    const outline = await pdfOutline(pdfReader.doc);
    takeOverPage(book.name, PDF_PAGE_CSS, READER_BACKGROUNDS.pdf[0]);
    applyReaderTheme('pdf');
    const container = el('div', 'lector-pdf');
    document.body.prepend(container);

    const first = (await pdfReader.doc.getPage(1)).getViewport({ scale: 1 });
    pdfReader.sizes[0] = { width: first.width, height: first.height };
    pdfReader.scale = place.scale || Math.min(1.6, (window.innerWidth - 48) / first.width); // fit width, not huge
    for (let n = 1; n <= pdfReader.doc.numPages; n++) {
      const div = el('div', 'lector-page');
      div.dataset.page = n;
      container.append(div);
      pdfReader.pages.push({ div, rendered: false });
    }
    pdfReader.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) renderPdfPage(+entry.target.dataset.page);
    }, { rootMargin: `${PDF_DRAW_MARGIN_PX}px 0px` });
    layoutPdfPages();
    goToPdfPage(place.page || 1); // carry on where you left off
    pdfControls(bar, pdfReader.doc.numPages, outline);
    setEnabled(true);
  }

  // The PDF's built-in outline (the bookmarks panel in PDF viewers) as { title, depth, page }.
  async function pdfOutline(doc) {
    const entries = [];
    const walk = async (items, depth) => {
      for (const item of items || []) {
        try {
          const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
          const target = dest?.[0];
          if (target != null) {
            const page = (typeof target === 'number' ? target : await doc.getPageIndex(target)) + 1;
            entries.push({ title: item.title.replace(/\s+/g, ' ').trim() || `Page ${page}`, depth, page });
          }
        } catch { /* broken link in the outline: skip it */ }
        await walk(item.items, depth + 1);
      }
    };
    try { await walk(await doc.getOutline(), 0); } catch { /* no usable outline */ }
    return entries;
  }

  // Runs PDF.js inside the userscript. The worker code is loaded first so PDF.js runs it on
  // the main thread instead of starting a separate worker. PDF.js registers itself on the real
  // global object, which in Tampermonkey isn't the script's `window` (a stand-in), so it's
  // looked up explicitly.
  async function loadPdfJs() {
    if (pdfjs) return pdfjs;
    const codes = [await pdfJsCode('pdfjsWorker'), await pdfJsCode('pdfjs')];
    for (const code of codes) new Function(code)(); // eslint-disable-line no-new-func
    pdfjs = new Function('return this')().pdfjsLib; // eslint-disable-line no-new-func
    if (!pdfjs) throw new Error("PDF.js didn't start");
    return pdfjs;
  }

  // PDF.js is downloaded from cdnjs the first time (cdnjs allows any site to fetch it) and
  // kept in Tampermonkey's storage after that.
  const PDFJS_VERSION = '3.11.174';
  const PDFJS_FILES = { pdfjs: 'pdf.min.js', pdfjsWorker: 'pdf.worker.min.js' };

  async function pdfJsCode(name) {
    const key = `code-${name}-${PDFJS_VERSION}`;
    const saved = GM_getValue(key, '');
    if (saved) return saved;
    const res = await fetch(`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/${PDFJS_FILES[name]}`);
    if (!res.ok) throw new Error(`couldn't download PDF.js (HTTP ${res.status})`);
    const code = await res.text();
    GM_setValue(key, code);
    return code;
  }

  // Size every page placeholder for the current zoom; pages are only drawn near the screen.
  // Pages not drawn yet are assumed to be the size of page 1 (true for nearly every PDF) and
  // corrected when drawn, so opening and zooming don't have to read every page first.
  function layoutPdfPages() {
    pdfReader.observer.disconnect();
    for (const [i, p] of pdfReader.pages.entries()) {
      releasePdfPage(p);
      sizePdfPage(i);
      pdfReader.observer.observe(p.div);
    }
  }

  function sizePdfPage(i) {
    const { width, height } = pdfReader.sizes[i] || pdfReader.sizes[0];
    const { style } = pdfReader.pages[i].div;
    style.width = `${width * pdfReader.scale}px`;
    style.height = `${height * pdfReader.scale}px`;
  }

  function releasePdfPage(p) {
    for (const canvas of p.div.querySelectorAll('canvas')) canvas.width = 0; // frees its memory right away
    p.div.replaceChildren();
    p.rendered = false;
  }

  // Free the drawings of pages far from the current one (they're redrawn when scrolled back
  // to); a long PDF would otherwise keep every page it has shown in memory.
  function releaseFarPdfPages(current) {
    for (const [i, p] of pdfReader.pages.entries()) {
      if (!p.rendered || Math.abs(i + 1 - current) <= PDF_KEEP_PAGES) continue;
      const r = p.div.getBoundingClientRect();
      if (r.bottom > -PDF_DRAW_MARGIN_PX && r.top < window.innerHeight + PDF_DRAW_MARGIN_PX) continue; // still near
      releasePdfPage(p);
      pdfReader.doc.getPage(i + 1).then((page) => page.cleanup()).catch(() => {});
    }
  }

  async function renderPdfPage(n) {
    const p = pdfReader.pages[n - 1];
    if (p.rendered) return;
    p.rendered = true;
    const scale = pdfReader.scale;
    const page = await pdfReader.doc.getPage(n);
    if (!pdfReader.sizes[n - 1]) {
      const { width, height } = page.getViewport({ scale: 1 });
      pdfReader.sizes[n - 1] = { width, height };
      sizePdfPage(n - 1);
    }
    const vp = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const canvas = el('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    const text = el('div', 'textLayer');
    text.style.setProperty('--scale-factor', scale);
    p.div.replaceChildren(canvas, text);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] }).promise;
    if (scale !== pdfReader.scale) return; // zoom changed meanwhile
    await pdfjs.renderTextLayer({ textContentSource: await page.getTextContent(), container: text, viewport: vp, textDivs: [] }).promise;
    joinPdfLines(text);
  }

  // PDF.js marks line ends with <br>, which don't count as text, so the last word of a line
  // would run into the first word of the next ("parque.Fui"). Each <br> becomes:
  //   ''   after a hyphenated line end ("tra-" + "bajo")
  //   ' '  when the sentence just wrapped onto the next line
  //   '\n' at a real line end (heading, table-of-contents entry, list item, end of paragraph);
  //        splitSentences may end a sentence there if the next line starts with a capital.
  function joinPdfLines(layer) {
    const lines = [[]];
    const brs = [];
    for (const node of layer.childNodes) {
      if (node.nodeName === 'BR') { brs.push(node); lines.push([]); } else if (node.nodeType === Node.ELEMENT_NODE) lines.at(-1).push(node);
    }
    const boxes = lines.map((spans) => {
      if (!spans.length) return null;
      const rects = spans.map((sp) => sp.getBoundingClientRect());
      return {
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
        height: rects[0].height,
        text: spans.map((sp) => sp.textContent).join('').trimEnd(),
        first: spans[0],
      };
    });
    brs.forEach((br, i) => br.replaceWith(lineJoin(boxes[i], boxes[i + 1], boxes.slice(Math.max(0, i - 2), i + 3))));
  }

  function lineJoin(prev, next, nearby) {
    if (!prev || !next) return '\n';
    if (/\p{L}-$/u.test(prev.text)) return '';
    const lastWord = prev.text.toLowerCase().match(/[\p{L}']+$/u)?.[0];
    if (lastWord && DANGLING[pageLang().source].has(lastWord)) return ' '; // "…se lo dijo a" + "María…"
    if (/\d$/.test(prev.text)) return '\n'; // page numbers in a table of contents
    return wrapsOnto(prev, next, nearby) ? ' ' : '\n';
  }

  // The text wrapped if the space left on the line was too small for the next line's first
  // word. The right edge comes from the nearby lines (two above, two below) in the same column,
  // i.e. the paragraph's own width, not wider things elsewhere on the page.
  function wrapsOnto(prev, next, nearby) {
    const columnRight = Math.max(...nearby.filter((b) => b && b.left < prev.right && b.right > prev.left).map((b) => b.right));
    return columnRight - prev.right < firstWordWidth(next.first) + prev.height * 0.4;
  }

  function firstWordWidth(span) {
    const node = span.firstChild;
    const m = node?.nodeType === Node.TEXT_NODE && /\S+/.exec(node.data);
    if (!m) return 0;
    const range = document.createRange();
    range.setStart(node, m.index);
    range.setEnd(node, m.index + m[0].length);
    return range.getBoundingClientRect().width;
  }

  function zoomPdf(factor) {
    const current = currentPdfPage();
    pdfReader.scale = Math.min(4, Math.max(0.4, pdfReader.scale * factor));
    hideTip();
    layoutPdfPages();
    goToPdfPage(current);
  }

  function currentPdfPage() {
    const mid = window.innerHeight / 3;
    const hit = pdfReader.pages.find((p) => p.div.getBoundingClientRect().bottom > mid);
    return hit ? +hit.div.dataset.page : 1;
  }

  function goToPdfPage(n) {
    const p = pdfReader.pages[Math.min(Math.max(1, n), pdfReader.pages.length) - 1];
    window.scrollTo({ top: p.div.offsetTop - 56 });
  }

  // Floating bar at the top of a reader tab (inside our shadow root, so its labels aren't
  // translatable words).
  function readerBar() {
    const bar = el('div', 'readerbar');
    const status = el('span', 'readerstatus');
    bar.append(status);
    shadow.append(bar);
    return { el: bar, status };
  }

  //   [−] 110% [+]   Page [ 3 ] / 12   [ Capítulo 1 ▾ ]   (chapter list if the PDF has an outline)
  function pdfControls(bar, total, outline) {
    const zoomOut = el('button', null, '−');
    const zoomIn = el('button', null, '+');
    const zoomLabel = el('span', 'pdfzoom');
    const pageInput = el('input');
    pageInput.type = 'number';
    pageInput.min = 1;
    pageInput.max = total;
    const toc = outline.length ? tocPicker(outline, (entry) => goToPdfPage(entry.page)) : null;
    const save = (page) => savePlace(pdfReader.placeKey, { page, scale: Math.round(pdfReader.scale * 1000) / 1000, label: `p. ${page} / ${total}` });
    const zoom = (factor) => {
      zoomPdf(factor);
      zoomLabel.textContent = `${Math.round(pdfReader.scale * 100)}%`;
      save(currentPdfPage());
    };
    // the outline entry you're in: the last one starting on or before this page
    const showChapter = (page) => {
      let best = -1;
      outline.forEach((e, i) => { if (e.page <= page && (best < 0 || e.page >= outline[best].page)) best = i; });
      toc.selectedIndex = best;
    };
    zoomOut.onclick = () => zoom(1 / PDF_ZOOM_STEP);
    zoomIn.onclick = () => zoom(PDF_ZOOM_STEP);
    pageInput.onchange = () => goToPdfPage(+pageInput.value);
    zoomKeys(zoomOut, zoomIn);
    let queued = false;
    let lastPage = currentPdfPage();
    window.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const page = currentPdfPage();
        if (shadow.activeElement !== pageInput) pageInput.value = page;
        if (page === lastPage) return;
        save((lastPage = page));
        if (toc) showChapter(page);
        releaseFarPdfPages(page);
      });
    }, { passive: true });
    pageInput.value = lastPage;
    save(lastPage); // so the recent-books list shows it even before you scroll
    zoomLabel.textContent = `${Math.round(pdfReader.scale * 100)}%`;
    bar.status.replaceChildren(zoomOut, zoomLabel, zoomIn, el('span', 'pdfsep'), 'Page ', pageInput, ` / ${total}`);
    if (toc) {
      showChapter(lastPage);
      bar.status.append(el('span', 'pdfsep'), toc);
    }
    bar.status.append(el('span', 'pdfsep'), themeButton('pdf'), pill.el);
  }

  const PDF_PAGE_CSS = `
    .lector-pdf { padding: 56px 0 24px; }
    .lector-page { position: relative; margin: 0 auto 14px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    .lector-page canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .textLayer { position: absolute; inset: 0; overflow: hidden; line-height: 1; color: transparent;
      text-align: initial; -webkit-text-size-adjust: none; text-size-adjust: none; forced-color-adjust: none;
      transform-origin: 0 0; z-index: 2; }
    .textLayer span { position: absolute; white-space: pre; transform-origin: 0% 0%; cursor: text; color: transparent; }
    .textLayer ::selection { background: rgba(149, 102, 230, .35); }
    .lector-dark { color-scheme: dark; }
    .lector-dark .lector-page { background: #1a1a1a; box-shadow: 0 2px 8px rgba(0,0,0,.7); }
    .lector-dark .lector-page canvas { filter: invert(.9) hue-rotate(180deg); }`;

  // ---------- EPUB ----------
  // An EPUB is a zip of web pages (one or more per chapter) plus an index saying in which order
  // to read them. The zip is unpacked with the browser's own decompressor, and each chapter is
  // rebuilt from plain text-formatting tags only: no scripts, styles, links or event handlers,
  // so a book can't run code here or restyle the reader. All chapters go on one long page.
  const EPUB_FONT_PX = 20;
  const EPUB_ZOOM_STEP = 1.1;
  const EPUB_SAVE_DELAY_MS = 1000;
  const EPUB_TOP_PX = 80; // the reading line, just below the toolbar
  // Tags kept as they are; any other tag is dropped but its contents kept (links become text).
  const EPUB_TAGS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead',
    'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'figure', 'figcaption', 'pre', 'code', 'em', 'i', 'b',
    'strong', 'u', 's', 'small', 'sub', 'sup', 'span', 'abbr', 'cite', 'q', 'br', 'hr', 'img', 'ruby', 'rt', 'rp']);
  // Tags dropped together with their contents.
  const EPUB_DROP = new Set(['script', 'style', 'head', 'title', 'svg', 'math', 'iframe', 'object', 'embed',
    'video', 'audio', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'noscript', 'template', 'link', 'meta']);
  let epubReader = null; // { container, chapters: [section], scale, placeKey }

  async function openEpub(book, data, bar) {
    const zip = readZip(data);
    const rootfile = parseXml(await zipText(zip, 'META-INF/container.xml'), 'application/xml').querySelector('rootfile');
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath) throw new Error('not an EPUB (no book index)');
    const opf = parseXml(await zipText(zip, opfPath), 'application/xml');
    const byTag = (tag) => [...opf.getElementsByTagNameNS('*', tag)];
    const manifest = new Map(byTag('item').map((i) => [i.getAttribute('id'), i]));
    const types = new Map(byTag('item').map((i) => [zipPath(opfPath, i.getAttribute('href')), i.getAttribute('media-type')]));
    const spine = byTag('itemref').map((r) => manifest.get(r.getAttribute('idref')))
      .filter((i) => i && /html/.test(i.getAttribute('media-type')))
      .map((i) => zipPath(opfPath, i.getAttribute('href')));
    if (!spine.length) throw new Error('this EPUB has no readable chapters');

    const uniqueId = opf.documentElement.getAttribute('unique-identifier');
    const identifier = byTag('identifier').find((i) => i.getAttribute('id') === uniqueId) || byTag('identifier')[0];
    const id = identifier?.textContent.trim() || await sha256(data);
    const title = byTag('title')[0]?.textContent.trim() || book.name;
    const toc = await epubToc(zip, opfPath, byTag('item'));

    const container = el('div', 'lector-book');
    const chapters = [];
    for (const [i, path] of spine.entries()) {
      bar.status.textContent = `Loading chapter ${i + 1} of ${spine.length}…`;
      const doc = parseXml(await zipText(zip, path), 'application/xhtml+xml');
      const section = el('section', 'lector-chapter');
      section.dataset.path = path;
      const images = [];
      for (const n of [...(doc.body || doc.documentElement).childNodes]) {
        const copy = copyEpubNode(n, path, images);
        if (copy) section.append(copy);
      }
      await Promise.all(images.map(async ([img, src]) => {
        try {
          img.src = URL.createObjectURL(new Blob([await zipBytes(zip, src)], { type: types.get(src) || '' }));
        } catch { img.remove(); }
      }));
      if (section.textContent.trim() || section.querySelector('img')) chapters.push(section);
    }

    const placeKey = `epub:${id}`;
    rememberBook(placeKey, title, book.blob);
    const place = savedPlace(placeKey) || {}; // { chapter, at, scale, label }
    takeOverPage(title, EPUB_PAGE_CSS, READER_BACKGROUNDS.epub[0]);
    applyReaderTheme('epub');
    container.append(...chapters);
    document.body.prepend(container);
    epubReader = { container, chapters, scale: place.scale || 1, placeKey };
    container.style.fontSize = `${EPUB_FONT_PX * epubReader.scale}px`;
    // wait for images, so the page has its final height before jumping to the saved place
    await Promise.all([...container.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
    goToEpubPlace(place);
    epubControls(bar, epubTocTargets(toc));
    setEnabled(true);
  }

  // The book's own table of contents as { title, depth, path, anchor }: EPUB 3 keeps it in a
  // "nav" page, EPUB 2 in a .ncx file.
  async function epubToc(zip, opfPath, items) {
    const childrenNamed = (node, name) => [...node.children].filter((c) => c.localName === name);
    const entries = [];
    try {
      const nav = items.find((i) => /\bnav\b/.test(i.getAttribute('properties') || ''));
      if (nav) {
        const path = zipPath(opfPath, nav.getAttribute('href'));
        const doc = parseXml(await zipText(zip, path), 'application/xhtml+xml');
        const navs = [...doc.getElementsByTagNameNS('*', 'nav')];
        const isToc = (n) => (n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || n.getAttribute('epub:type')) === 'toc';
        const walk = (ol, depth) => {
          for (const li of childrenNamed(ol, 'li')) {
            const a = childrenNamed(li, 'a')[0];
            if (a?.getAttribute('href')) entries.push(tocEntry(path, a.getAttribute('href'), a.textContent, depth));
            for (const sub of childrenNamed(li, 'ol')) walk(sub, depth + 1);
          }
        };
        const list = childrenNamed(navs.find(isToc) || navs[0] || doc.documentElement, 'ol')[0];
        if (list) walk(list, 0);
      }
      const ncx = items.find((i) => i.getAttribute('media-type') === 'application/x-dtbncx+xml');
      if (!entries.length && ncx) {
        const path = zipPath(opfPath, ncx.getAttribute('href'));
        const doc = parseXml(await zipText(zip, path), 'application/xml');
        const walk = (parent, depth) => {
          for (const point of childrenNamed(parent, 'navPoint')) {
            const src = childrenNamed(point, 'content')[0]?.getAttribute('src');
            if (src) entries.push(tocEntry(path, src, childrenNamed(point, 'navLabel')[0]?.textContent || '', depth));
            walk(point, depth + 1);
          }
        };
        const navMap = doc.getElementsByTagNameNS('*', 'navMap')[0];
        if (navMap) walk(navMap, 0);
      }
    } catch { /* broken table of contents: fall back to headings */ }
    return entries;
  }

  function tocEntry(from, href, title, depth) {
    const [file, anchor = ''] = href.split('#');
    return { title: title.replace(/\s+/g, ' ').trim(), depth, path: file ? zipPath(from, file) : from, anchor: decodeURIComponent(anchor) };
  }

  // Table-of-contents entries with the element each one jumps to. Without a usable table of
  // contents, each chapter is an entry named after its first heading.
  function epubTocTargets(toc) {
    const sections = new Map(epubReader.chapters.map((c) => [c.dataset.path, c]));
    const entries = [];
    for (const e of toc) {
      const section = sections.get(e.path);
      if (!section) continue;
      const anchor = e.anchor && section.querySelector(`[data-anchor="${CSS.escape(e.anchor)}"]`);
      entries.push({ ...e, title: e.title || `Section ${entries.length + 1}`, target: anchor || section });
    }
    if (entries.length) return entries;
    return epubReader.chapters.map((c, i) => {
      const heading = c.querySelector('h1, h2, h3, h4')?.textContent.replace(/\s+/g, ' ').trim();
      return { title: heading || `Section ${i + 1}`, depth: 0, target: c };
    });
  }

  // Minimal zip reader: the index at the end of the file lists every file and where it starts.
  function readZip(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let end = data.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) throw new Error('damaged file (no zip index)');
    const entries = new Map();
    const decoder = new TextDecoder();
    let p = view.getUint32(end + 16, true);
    for (let i = view.getUint16(end + 10, true); i > 0; i--) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('damaged file (bad zip index)');
      const nameLength = view.getUint16(p + 28, true);
      entries.set(decoder.decode(data.subarray(p + 46, p + 46 + nameLength)), {
        method: view.getUint16(p + 10, true),
        size: view.getUint32(p + 20, true),
        header: view.getUint32(p + 42, true),
      });
      p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    return { data, view, entries };
  }

  async function zipBytes(zip, name) {
    const entry = zip.entries.get(name);
    if (!entry) throw new Error(`missing ${name}`);
    const { view } = zip;
    const start = entry.header + 30 + view.getUint16(entry.header + 26, true) + view.getUint16(entry.header + 28, true);
    const raw = zip.data.subarray(start, start + entry.size);
    if (entry.method === 0) return raw; // stored as is
    if (entry.method !== 8) throw new Error(`unsupported compression in ${name}`);
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function zipText(zip, name) {
    return new TextDecoder().decode(await zipBytes(zip, name));
  }

  // Path inside the zip of a link found in the file at `from` (links are relative and %-encoded).
  function zipPath(from, href) {
    return decodeURIComponent(new URL(href, `https://zip/${from}`).pathname.slice(1));
  }

  function parseXml(text, type) {
    const doc = new DOMParser().parseFromString(text, type);
    if (!doc.querySelector('parsererror')) return doc;
    return new DOMParser().parseFromString(text, 'text/html'); // sloppy XHTML: read it as HTML
  }

  async function sha256(data) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Copy of a chapter node made of safe tags only (see EPUB_TAGS); images are queued in
  // `images` to be filled in from the zip.
  function copyEpubNode(node, path, images) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.data);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = node.localName.toLowerCase();
    if (EPUB_DROP.has(tag)) return null;
    if (tag === 'img') {
      const src = node.getAttribute('src');
      if (!src) return null;
      const img = el('img');
      img.alt = node.getAttribute('alt') || '';
      images.push([img, zipPath(path, src)]);
      return img;
    }
    const copy = EPUB_TAGS.has(tag) ? document.createElement(tag) : document.createDocumentFragment();
    const id = node.getAttribute('id'); // kept as a jump target for the table of contents
    if (id) {
      const target = copy.dataset ? copy : copy.appendChild(el('span')); // unwrapped tag: empty marker
      target.dataset.anchor = id;
    }
    for (const child of node.childNodes) {
      const c = copyEpubNode(child, path, images);
      if (c) copy.append(c);
    }
    return copy;
  }

  // Where you are: { chapter: its number, at: how far through it (0–1) } at the reading line.
  // Stored this way (not as a scroll position) so it still fits after the text size or window
  // changes.
  function epubPlace() {
    const line = window.scrollY + EPUB_TOP_PX;
    const { chapters } = epubReader;
    let i = chapters.length - 1;
    while (i > 0 && chapters[i].offsetTop > line) i--;
    const c = chapters[i];
    return { chapter: i, at: Math.round(Math.min(1, Math.max(0, (line - c.offsetTop) / c.offsetHeight)) * 10000) / 10000 };
  }

  function goToEpubPlace(place) {
    if (place.chapter == null) return;
    const c = epubReader.chapters[Math.min(place.chapter, epubReader.chapters.length - 1)];
    window.scrollTo({ top: c.offsetTop + place.at * c.offsetHeight - EPUB_TOP_PX });
  }

  //   [−] 100% [+]   [ Capítulo 3: El viaje ▾ ]
  function epubControls(bar, toc) {
    const zoomOut = el('button', null, '−');
    const zoomIn = el('button', null, '+');
    const zoomLabel = el('span', 'pdfzoom');
    const picker = tocPicker(toc, (entry) => window.scrollTo({ top: entry.target.getBoundingClientRect().top + window.scrollY - EPUB_TOP_PX + 1 }));
    // the entry you're in: the last one starting above the reading line
    const currentEntry = () => {
      let best = 0;
      let bestTop = -Infinity;
      toc.forEach((e, i) => {
        const top = e.target.getBoundingClientRect().top;
        if (top <= EPUB_TOP_PX && top >= bestTop) { best = i; bestTop = top; }
      });
      return best;
    };
    const save = () => savePlace(epubReader.placeKey, { ...epubPlace(), scale: Math.round(epubReader.scale * 1000) / 1000, label: toc[currentEntry()].title });
    const zoom = (factor) => {
      const place = epubPlace();
      epubReader.scale = Math.min(2.5, Math.max(0.6, epubReader.scale * factor));
      epubReader.container.style.fontSize = `${EPUB_FONT_PX * epubReader.scale}px`;
      hideTip();
      goToEpubPlace(place);
      zoomLabel.textContent = `${Math.round(epubReader.scale * 100)}%`;
      save();
    };
    zoomOut.onclick = () => zoom(1 / EPUB_ZOOM_STEP);
    zoomIn.onclick = () => zoom(EPUB_ZOOM_STEP);
    zoomKeys(zoomOut, zoomIn);
    let queued = false;
    let saveTimer = 0;
    window.addEventListener('scroll', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, EPUB_SAVE_DELAY_MS);
      queueMarkSeen(); // underlines only cover the text around the screen
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; picker.selectedIndex = currentEntry(); });
    }, { passive: true });
    picker.selectedIndex = currentEntry();
    save(); // so the recent-books list shows it even before you scroll
    zoomLabel.textContent = `${Math.round(epubReader.scale * 100)}%`;
    bar.status.replaceChildren(zoomOut, zoomLabel, zoomIn, el('span', 'pdfsep'), picker, el('span', 'pdfsep'), themeButton('epub'), pill.el);
  }

  const EPUB_PAGE_CSS = `
    .lector-book { max-width: 38em; margin: 0 auto; padding: 64px 24px 48px; color: #222;
      font: ${EPUB_FONT_PX}px/1.6 Georgia, serif; }
    .lector-chapter + .lector-chapter { border-top: 1px solid #ddd; margin-top: 2em; padding-top: 2em; }
    .lector-book h1, .lector-book h2, .lector-book h3 { line-height: 1.3; }
    .lector-book img { max-width: 100%; height: auto; }
    .lector-book pre { white-space: pre-wrap; }
    .lector-book table { border-collapse: collapse; }
    .lector-book td, .lector-book th { border: 1px solid #ccc; padding: 4px 8px; }
    .lector-dark { color-scheme: dark; }
    .lector-dark .lector-book { color: #d9d4ca; }
    .lector-dark .lector-chapter + .lector-chapter { border-top-color: #3a3832; }
    .lector-dark .lector-book td, .lector-dark .lector-book th { border-color: #4a4740; }`;

  // ---------- text reader ----------
  // "Read pasted text…" opens a tab on example.com (like the book reader): a box at the top to
  // paste or type into, and the same text below as paragraphs with the usual click-to-translate.
  // The text below follows the box right after a paste, or once you pause typing, and only the
  // paragraphs that changed are redrawn, so your place, underlines and an open popup stay put.
  // Ctrl+V anywhere outside the box replaces the box's text. The text is kept in the tab's
  // storage: reloading brings it back, closing the tab forgets it.
  const TEXT_READER_URL = 'https://example.com/#lector-text';
  const isTextTab = location.hostname === 'example.com' && location.hash === '#lector-text';
  const TEXT_STORE_KEY = 'lector-text';
  const TEXT_TYPING_PAUSE_MS = 500;
  let textReader = null; // { box, view, paragraphs }

  function openTextReader() {
    if (textReader) { textReader.box.focus(); return; }
    takeOverPage('Lector: pasted text', TEXT_PAGE_CSS, '#faf8f4');
    const box = el('textarea', 'lector-paste');
    box.placeholder = 'Paste or type the text you want to read (Ctrl+V works anywhere on the page)';
    box.spellcheck = false; // the browser's checker would underline every Spanish word in red
    const top = el('div', 'lector-pastebar');
    top.append(box);
    const view = el('div', 'lector-text');
    document.body.prepend(top, view);
    textReader = { box, view, paragraphs: [] };

    let typingTimer = 0;
    box.addEventListener('input', (e) => {
      clearTimeout(typingTimer);
      if (/^insertFrom(Paste|Drop)/.test(e.inputType)) updateTextView();
      else typingTimer = setTimeout(updateTextView, TEXT_TYPING_PAUSE_MS);
    });
    document.addEventListener('paste', (e) => { // outside the box: replace the box's text
      if (e.target === box) return;
      const text = e.clipboardData?.getData('text/plain') || '';
      if (!text.trim()) return;
      e.preventDefault();
      box.value = text;
      updateTextView();
      window.scrollTo(0, 0);
    });
    box.value = tabStore.get(TEXT_STORE_KEY) || '';
    updateTextView();
    if (!box.value) box.focus();
  }

  function updateTextView() {
    const { box, view, paragraphs: old } = textReader;
    tabStore.set(TEXT_STORE_KEY, box.value);
    const next = textParagraphs(box.value);
    // the paragraphs that stayed the same at the start and at the end are left alone
    let same = 0;
    while (same < old.length && same < next.length && old[same] === next[same]) same++;
    let sameEnd = 0;
    while (sameEnd < old.length - same && sameEnd < next.length - same
      && old[old.length - 1 - sameEnd] === next[next.length - 1 - sameEnd]) sameEnd++;
    const shown = [...view.children];
    const gone = shown.slice(same, old.length - sameEnd);
    const added = next.slice(same, next.length - sameEnd).map((t) => el('p', null, t));
    const popupWord = window.CSS?.highlights?.get('lector-word');
    if (popupWord && gone.some((p) => [...popupWord].some((r) => p.contains(r.startContainer)))) hideTip();
    if (added.length) {
      const before = shown[old.length - sameEnd];
      if (before) before.before(...added); else view.append(...added);
    }
    for (const p of gone) p.remove();
    textReader.paragraphs = next;
    if (!old.length && next.length) setEnabled(true); // text arrived: ready to click
    if (old.length && !next.length) setEnabled(false);
  }

  // Blank lines separate paragraphs (lines inside one are joined back up). Text without any
  // blank lines is read one line per paragraph.
  function textParagraphs(text) {
    const blocks = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/).map((b) => b.replace(/\s*\n\s*/g, ' ')) : text.split('\n');
    return blocks.map((b) => b.trim()).filter(Boolean);
  }

  const TEXT_PAGE_CSS = `
    .lector-pastebar { position: sticky; top: 0; z-index: 1; padding: 44px 24px 12px; background: #faf8f4; /* room for the direction pill */
      border-bottom: 1px solid #e4dfd5; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .lector-paste { display: block; box-sizing: border-box; width: 100%; max-width: 40em; height: 7.5em;
      margin: 0 auto; padding: 10px 12px; resize: vertical; font: 15px/1.5 system-ui, sans-serif;
      color: #222; background: #fff; border: 1px solid #ccc; border-radius: 8px; }
    .lector-text { max-width: 40em; margin: 0 auto; padding: 24px 24px 48px; font: 20px/1.6 Georgia, serif; color: #222; }
    .lector-text p { margin: 0 0 1em; }
    .lector-text:empty::before { content: 'The text shows up here, ready to click.'; color: #999;
      font: 16px/1.5 system-ui, sans-serif; }`;

  // ---------- events ----------
  function isEditable(t) {
    return t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  }

  function inOurUi(e) {
    return e.composedPath().includes(host);
  }

  // Words can be clicked on the page in reading mode, and in the quick translator's output always.
  function clickableAt(e) {
    if (inOurUi(e)) return e.composedPath().includes(quick.out);
    return enabled && e.target instanceof Element && !isEditable(e.target);
  }

  // While reading mode is on we replace the browser's own (blue) selection:
  // press + release on a word = translate that word,
  // press + drag = purple selection snapped to whole words, translated on release.
  const DRAG_THRESHOLD_PX = 4;
  let drag = null;           // { x, y, caret, moved, range }
  let swallowClick = false;  // stops the click after our mouseup from opening links

  document.addEventListener('mousedown', (e) => {
    swallowClick = false;
    if (e.button !== 0 || !clickableAt(e)) return;
    const caret = caretAt(e.clientX, e.clientY);
    if (!caret) return;
    e.preventDefault(); // no native selection, no dragging links/images
    // preventDefault also keeps the focus where it was, so move it out of a text field the way a
    // normal click would: clearing the selection below while a field is focused makes the browser
    // scroll to the field's caret (for the pasted-text reader's sticky box, the top of the page).
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && isEditable(focused)) focused.blur();
    window.getSelection()?.removeAllRanges();
    drag = { x: e.clientX, y: e.clientY, caret, moved: false, range: null };
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!drag || e.button !== 0) return;
    const d = drag;
    drag = null;

    if (d.moved) {
      const end = caretAt(e.clientX, e.clientY);
      const range = (end && wordSpan(d.caret, end)) || d.range;
      const phrase = range ? range.toString().replace(/\s+/g, ' ').trim() : '';
      swallowClick = true;
      if (phrase) lookup(range, phrase); else hideTip();
      return;
    }

    const range = wordRangeAt(e.clientX, e.clientY);
    if (!range) { hideTip(); return; }
    swallowClick = true;
    lookup(range, range.toString());
  }, true);

  document.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault(); // links don't navigate while reading mode is on
    e.stopPropagation();
  }, true);

  // hover: light purple on the word under the mouse
  let hoverRange = null;
  let frameQueued = false;
  let hoverAllowed = false; // the mouse is over clickable text (see clickableAt)
  let mouseX = 0;
  let mouseY = 0;

  function clearHover() {
    hoverRange = null;
    if (window.CSS?.highlights) CSS.highlights.delete('lector-hover');
  }

  function sameRange(a, b) {
    return a && b && a.startContainer === b.startContainer
      && a.startOffset === b.startOffset && a.endOffset === b.endOffset;
  }

  function updateHover() {
    if (!window.CSS?.highlights) return;
    const range = wordRangeAt(mouseX, mouseY);
    if (sameRange(range, hoverRange)) return;
    if (!range) { clearHover(); return; }
    hoverRange = range;
    CSS.highlights.set('lector-hover', new Highlight(range));
  }

  function updateDrag() {
    const caret = caretAt(mouseX, mouseY);
    const range = caret && wordSpan(drag.caret, caret);
    if (!range) return;
    drag.range = range;
    markWord(range);
  }

  function onFrame() {
    frameQueued = false;
    if (drag) updateDrag(); else if (hoverAllowed) updateHover();
  }

  document.addEventListener('mousemove', (e) => {
    if (!enabled && quick.box.hidden) return;
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (drag && !drag.moved) {
      if (Math.hypot(mouseX - drag.x, mouseY - drag.y) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      hideTip();
      clearHover();
    }
    hoverAllowed = clickableAt(e);
    if (!drag && !hoverAllowed) {
      clearHover();
      return;
    }
    if (!frameQueued) { frameQueued = true; requestAnimationFrame(onFrame); } // at most once per frame
  }, { passive: true });

  document.addEventListener('mouseleave', clearHover);
  window.addEventListener('scroll', clearHover, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === HOTKEY) {
      e.preventDefault();
      if (e.shiftKey) toggleQuickBox(); else setEnabled(!enabled);
    } else if (e.key === 'Escape') {
      if (!tipEl.hidden) hideTip(); // a popup first, then the quick translator
      else if (!quick.box.hidden) closeQuickBox();
    }
  }, true);

  setEnabled(enabled);
  if (isReaderTab || isTextTab) restoreSeen();
  if (isReaderTab) openBookReader();
  if (isTextTab) openTextReader();
})();
