# `resources/`: files the browser ships beside its code

**What lives here.** Files the application reads at run time that are not source: today
[`default-profile/`](default-profile/), what a new profile starts with. `electron-builder.yml` copies each
folder here into the package's resources folder (`extraResources`); a run from source reads them from this
checkout.

**What it depends on.** Nothing: it holds data.

**What it must never contain.** Code, or a file fetched at install time that is not gitignored.
Fetched files go in a folder git ignores, and the script that fetches them names its pin
(`default-profile/bundled-extensions.json`).
