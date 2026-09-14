// Reuses src/shim-electron/unimplemented.ts's `refusingProxy` rather than a
// second copy (A135 -- PR #151's own "refuse by name, not absence" fix,
// extended here from the `electron` compatibility package to the Node-
// stdlib one). See node-dns.ts, node-fs.ts, node-http.ts, node-https.ts and
// node-net.ts for the module namespaces this wraps.
//
// WHY A DIRECT IMPORT, NOT src/shared/. That directory exists specifically
// for a helper needed on the src/broker/ <-> src/shim/ trust boundary
// (CLAUDE.md, src/shared/README.md) -- two directories that must never
// import each other because one holds main-process authority. src/shim-
// electron/ sits on the SAME side of that boundary as src/shim/: both are
// renderer-only, hold no broker access, and are already siblings under
// compatibility-matrix.md's Table 2 (families 1 and 2 of the same "present
// a familiar surface" problem). This is not the crossing src/shared/ was
// built for, so routing it through there would stretch that directory past
// its own stated bar ("two callers on opposite sides of a boundary") for no
// benefit. Nothing in either package's own "must never import" list (both
// READMEs) forbids this direction -- src/shim-electron/'s list forbids the
// reverse (importing src/shim/ back), which this does not do.

export { refusingProxy } from '../shim-electron/unimplemented.js'
