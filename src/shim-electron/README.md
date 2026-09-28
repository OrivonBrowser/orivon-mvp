# `src/shim-electron/`: the `electron` module compatibility package

**What lives here.** Electron's `app`, `dialog`, `safeStorage`, `ipcRenderer`/`ipcMain`,
`BrowserWindow`, `Menu` and `Tray`, rebuilt (or refused by name) on `orivon.*`, so a ported app's
`require('electron')` resolves instead of failing to load. What each API maps to, and which
refuse, is [`compatibility-matrix.md`](../../docs/planning/compatibility-matrix.md) Table 2's
`electron` table; any other top-level name refuses as `'unimplemented'` (`index.ts`).

It is the second of the matrix's adapter families, a sibling of [`src/shim/`](../shim/README.md)
(the Node stdlib family), not part of it. One exception: `src/shim/` imports this package's
`unimplemented.ts` (`refusingProxy`) directly (A135, A160). The reverse must not happen.

**What it depends on.** [`src/contracts/`](../contracts/) (types only) and the `window.orivon`
global the preload installs before app code runs.

**What it must never import.** `electron`: this package *is* its replacement, and must never load
a native Electron binding (Rule 8). `src/broker/`: it runs entirely in the sandbox. `src/shim/`
or `src/preload/`: nothing here needs either; if something does, raise it as a design question.

**Owner stream.** No row in [`parallel-work.md`](../../docs/development/parallel-work.md)'s
ownership map yet. The `electron` alias entry lives in `src/shim/module-map.ts`, owned by `shim`.

## Design notes

**One `ElectronShimError` with a closed `reason` union** (`errors.ts`), not a class per refusal:
every refusal needs the same name, reason and message, and the package's exit criterion is that an
unsupported API throws an error naming why, never a bare `TypeError`. Keep the reasons distinct:
calling an undecided API `'not-built'` tells a porter it is coming when nobody agreed it is, and
calling it `'desktop-shell'` says it is impossible.

**`safeStorage`: `isEncryptionAvailable()` answers `false` on purpose.** The async trio is backed
by `orivon.secrets`
([`ADR-0033`](../../docs/decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md));
the sync trio cannot be (`safe-storage.ts` says why), and `false` is the signal Element Desktop's
and AirGap Vault's documented non-keyring fallbacks check for.

**`desktop-shell.ts` uses three small classes, not a `Proxy`.** Apps call statics
(`Menu.setApplicationMenu`, `BrowserWindow.getAllWindows`) before constructing one, and a few
named entry points read more plainly than `construct`/`get` traps.

**One refusal mechanism, `unimplemented.ts`'s `refusingProxy`**, reused for a whole missing module
(`shell`, `clipboard`, the rest of `index.ts`'s list), for one extra method (`dialog`'s others), and
for the default export (`withUnimplementedFallback`). `src/shim/` reuses it with its own error type.

**Why "total" stops at the default export.** An ES module namespace (`import * as electron`,
`await import('electron')`) cannot be intercepted: a name never declared as an export reads
`undefined`, by spec. Verified with a throwaway script: a `Proxy` exported as a named binding
leaves an undeclared name `undefined`; the same `Proxy` as `default` throws correctly. So
`import electron from 'electron'` refuses every unknown name, while `import { someNewApi }` fails
at bundle time, outside `ElectronShimError`. `index.ts`'s curated list closes this for the names
ported apps use most; naming every real Electron export is not this package's job.
