# `test/apps/app-update/`: the app that a moved name leaves behind

**What lives here.** `site.mjs` builds the files an IPFS site holds for one build of a small app:
a version, a build label shown on the page and answered by its service worker, an optional `domain`
and one optional `net` capability. The update specs in [`test/web3/`](../../web3/) install one build
at a `.eth` name, move the name to another build and read which build each tab and its worker run.

**What it depends on.** Nothing at runtime beyond the page's own files.

**What it must never import.** Anything under `src/`.
