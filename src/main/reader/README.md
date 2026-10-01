# `src/main/reader/`: the reader view

**What lives here.** Reader view: an article taken from the tab in front, shown in the shell's own
`orivon://reader` page in a tab beside it.

| File | What it does |
|---|---|
| `reader-blocks.ts` | The block model (paragraph, heading, quote, code, list, picture, table, rule) and `validateArticle`, which keeps only that model, http(s) addresses and the size caps. Pure |
| `reader-walk.ts` | Turns the cleaned article HTML into raw blocks. Sent to the page's isolated world as source text, so it names nothing outside itself. Pure |
| `reader-extract.ts` | Runs `@mozilla/readability` and the walker in an isolated world of the page (out of reach of its scripts and its Content-Security-Policy) and validates the JSON that comes back |
| `reader-signal.ts` | A tab signal: asks each ordinary web page once per address whether it looks like an article, for the address bar's book button and the context menu |
| `reader-runner.ts` | The toggle: open the reader tab beside the article's, or close it and go back. One reader tab per window |
| `reader-command.ts` | The `page.reader` command with its Electron dependencies |
| `reader-domain.ts` | What the reader page may ask of main: the article, four reading settings, back, print, and a link by its index |
| `reader-images.ts` | Copies an article's pictures in the source tab's session, with caps, as `data:` URLs |
| `reader-store.ts` | The article each window's reader tab shows, in memory only |
| `install-reader.ts` | Publishes reading-setting changes to open reader pages and drops an article when its tab closes |

**What it depends on.** `electron`, [`../shell/`](../shell/) (tab types, signals, the installer type),
[`../pages/`](../pages/) (the internal-page channel) and `@mozilla/readability`, whose two files are read
as text and sent to a page, never bundled into one of Orivon's own pages.

**What it must never import.** The renderer, or a value from [`../shell/tabs.ts`](../shell/tabs.ts): the shell lists this
feature, not the other way round.

**Design notes.** The extraction result is untrusted. The reader page draws the validated model as text
nodes in a fixed element set and loads nothing from the network: pictures arrive as `data:` URLs main
fetched, and a link is opened by its index in the article's own link table, never by an address the page
sends. Only the command bus opens reader view; a website cannot.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron.
