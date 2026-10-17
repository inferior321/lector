# Lector

A reading assistant for Spanish learners: in-context translations, phrase detection, audio, and readers for PDFs, EPUB books and pasted text.

Lector is a userscript. Turn on reading mode on any web page, click a word (or drag across a phrase), and a popup shows what it means **in that sentence**, not just in the dictionary.

## Install

1. Install a userscript manager in your browser: [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
   - Tampermonkey in Chrome, Brave, Edge and other Chromium browsers also needs this: open the extensions page (`brave://extensions`, `chrome://extensions`, …), click **Details** on Tampermonkey and turn on **Allow User Scripts**.
2. Open **[lector.user.js](https://raw.githubusercontent.com/inferior321/lector/main/lector.user.js)**. The manager shows its install page; click **Install**.

The manager checks this address for new versions and updates the script by itself (about once a day; its dashboard can also check right away).

## Use

| | |
|---|---|
| **Alt+T** | Turn reading mode on/off (it starts off on every page) |
| **ES → EN ⇄ ✕** at the top | Shown while reading mode is on (in the book reader, at the end of its top bar). **⇄** swaps the direction to English → Spanish and back, for this tab only: reloading keeps it, a new tab starts Spanish → English. **✕** turns reading mode off. It turns amber with a countdown while Google is busy |
| **Alt+Shift+T** | The Lector panel, just under the direction pill (drag its header to move it; it reopens where you left it): <br>• **A quick translator** with its own direction, starting opposite to the tab's. Type or paste, **Enter** translates (**Shift+Enter** for a new line). Click a word in the translation for the usual popup, back in the language you typed in. **⇄** swaps the direction and translates the translation back; **📋** copies it and **🔊** reads it aloud. It keeps its text until you close the tab <br>• **📖 PDF/EPUB** and **📝 Pasted text** open those readers in a new tab; **Reading: on/off** turns reading mode on/off <br>• **Continue reading**: your last books, each reopens in a new tab where you left off <br>It stays open while you read and click; **Esc**, **✕** or Alt+Shift+T close it |
| **Click a word** | Translate it in context |
| **Drag across words** | Translate a phrase (the selection snaps to whole words) |
| **Esc** | Close the popup (then the Lector panel) |
| | Words and phrases you've looked up get a dotted purple underline everywhere they appear on the page (shown only in reading mode). On web pages they clear when you reload; in the reader tabs they last until you close the tab |
| Panel → **📖 PDF/EPUB** (also in the userscript menu) | Opens a reader tab: pick a PDF or EPUB book and read it with the same click-to-translate. Your last 5 books are listed under **Continue reading** and reopen with one click, at the same spot and zoom; reloading the tab reopens the book you were reading. A chapter list follows the book's own table of contents (or the PDF's outline), and ☾ switches to dark mode (PDF pages are shown with inverted colours) |
| Panel → **📝 Pasted text** (also in the userscript menu) | Opens a reader tab with a box at the top: paste or type any text (an email, a message, a site where clicking doesn't work) and it appears below, ready to click. Edits show up as soon as you pause typing; Ctrl+V anywhere on the page replaces the text |

### The popup

```
pasamos · pasar                ◐ from phrase
we had a great time
──────────────────────
phrase: pasamos genial
▸ sentence                              🔊
                          SpanishDict ↗
```

- **Status** (also the coloured left edge): ✓ *in context* · ◐ *from phrase* (idioms) · ? *not sure* (shows dictionary meanings) · ✕ *error*
- **Dictionary form** next to the word (*pasamos · pasar*)
- **▸ sentence** shows the original sentence above its translation, with the matching words highlighted
- **🔊** reads the word or sentence aloud (Google's voice)
- **SpanishDict ↗** opens the word in SpanishDict

## How the in-context translation works

Google translates whole sentences, so Lector works out which part of the translation belongs to your word:

1. It sends the sentence with your word marked, and Google carries the mark over to the matching words.
2. If that doesn't fit the word's dictionary meanings, it tries a second marking method and picks the more complete answer.
3. It looks for one of the word's dictionary meanings in the translated sentence.
4. For idioms, it widens the selection to neighbouring words until a phrase translates cleanly (*me importa un pepino* → *don't give a damn*).
5. Otherwise it shows the word on its own, its dictionary meanings and the whole sentence, marked *not sure*.

## Good to know

- **Privacy:** each lookup sends the sentence around the word to Google Translate, and the quick translator sends what you typed when you press Enter. Keep reading mode off on private pages (email, banking).
- Lector uses Google Translate's free, unofficial web addresses. Google may limit heavy use for a few minutes. Lector then switches to a second address, and the direction pill at the top turns amber with a countdown if both are busy.
- Translations are cached in the userscript manager's storage, so repeat lookups are instant.
- Your last 5 books are kept as files in the reader page's own browser storage (on this computer only), so they reopen without the file picker. Remove one with its ✕.
- The book and text readers run on `example.com`, a plain page that doesn't block them. The PDF reader uses [PDF.js](https://mozilla.github.io/pdf.js/) (downloaded once from cdnjs and cached).
- Doesn't work inside embedded frames, on text drawn as images (e.g. Google Docs), in scanned PDFs, or in copy-protected (DRM) ebooks such as Kindle books.

## Tests

`node tests/tests.mjs` runs the script in headless Brave (the Flatpak `com.brave.Browser`; needs Node 22+ and openssl) against a sample page, the text reader and a small EPUB, with Google faked so no network is needed. Add part of a test's name to run just those tests.

## License

[MIT](LICENSE)
