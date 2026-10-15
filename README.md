# Lector

A reading assistant for Spanish learners: in-context translations, phrase detection, audio, and readers for PDFs, EPUB books and pasted text.

Lector is a userscript. Turn on reading mode on any web page, click a word (or drag across a phrase), and a popup shows what it means **in that sentence**, not just in the dictionary.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Chrome, Brave, Edge and other Chromium browsers: open the extensions page (`brave://extensions`, `chrome://extensions`, …), click **Details** on Tampermonkey and turn on **Allow User Scripts**.
3. Open **[lector.user.js](https://raw.githubusercontent.com/inferior321/lector/main/lector.user.js)**. Tampermonkey shows its install page; click **Install**.

Tampermonkey checks this address for new versions and updates the script by itself (about once a day, or right away with *Tampermonkey → Utilities → Check for userscript updates*).

## Use

| | |
|---|---|
| **Alt+T** | Turn reading mode on/off (it starts off on every page) |
| **Click a word** | Translate it in context |
| **Drag across words** | Translate a phrase (the selection snaps to whole words) |
| **Esc** | Close the popup |
| | Words and phrases you've looked up get a dotted purple underline everywhere they appear on the page, until you reload (shown only in reading mode) |
| Tampermonkey menu → **Open a PDF or EPUB to read…** | Opens a reader tab: pick a PDF or EPUB book and read it with the same click-to-translate. Each book reopens where you left off. EPUBs get a chapter list and a text-size control |
| Tampermonkey menu → **Read pasted text…** | Opens a reader tab: press Ctrl+V and the text (an email, a message, a site where clicking doesn't work) is ready to click right away. A new paste replaces it; reloading the tab keeps it |
| Tampermonkey menu → **Swap direction** | Spanish → English (default) or English → Spanish |

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

- **Privacy:** each lookup sends the sentence around the word to Google Translate. Keep reading mode off on private pages (email, banking).
- Lector uses Google Translate's free, unofficial web addresses. Google may limit heavy use for a few minutes. Lector then switches to a second address, and the corner badge turns amber with a countdown if both are busy.
- Translations are cached in Tampermonkey's storage, so repeat lookups are instant.
- The book and text readers run on `example.com`, a plain page that doesn't block them. The PDF reader uses [PDF.js](https://mozilla.github.io/pdf.js/) (downloaded once from cdnjs and cached).
- Doesn't work inside embedded frames, on text drawn as images (e.g. Google Docs), in scanned PDFs, or in copy-protected (DRM) ebooks such as Kindle books.

## License

[MIT](LICENSE)
