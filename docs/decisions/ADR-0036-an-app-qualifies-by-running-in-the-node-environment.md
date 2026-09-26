# ADR-0036: An app qualifies by running in the Node environment, not by being written in JavaScript

- **Status:** accepted
- **Date:** 2026-09-26
- **Type:** product / architecture
- **Decided by:** owner

## Decision

This build runs apps whose code runs in the Node environment. It does not require them to be
JavaScript. Node's engine, V8, executes two kinds of code, JavaScript and WebAssembly, and an
Orivon app's renderer runs the same engine. So an app whose components are compiled to
WebAssembly, from Rust, C, Go or anything else, is accepted on the same terms as one written in
JavaScript.

Where Orivon's Node environment falls short of real Node, the gap is listed in
[`compatibility-matrix.md`](../planning/compatibility-matrix.md) and taken case by case, as a real
app reaches it. A gap is a limit of this build. It is never a rule about which apps may exist.

**A native addon does not carry over**: machine code built for one operating system and loaded
into a Node process (`.node`, N-API). An Orivon app has no Node process of its own (`ADR-0005`),
so there is nothing to load it into. It is replaced per library, often by a WebAssembly build of
the same code (`compatibility-matrix.md` Table 5), which then qualifies under this ADR.

This bounds the apps Orivon runs. It leaves Rule 8, which bounds this repository's own
dependencies, and `ADR-0002`'s TypeScript-only rule for code written here, as they are, and it
does not bring forward `orivon-runtime`, the deferred WebAssembly *host* (`ADR-0002`).

## Context

No page said whether an app's code has to be JavaScript, and three passages read as if it
did:

- Rule 8 was titled "Pure-JS dependencies only". It governs Orivon's own `npm install` and says
  nothing about apps, but it was the only rule anywhere near the question.
- `ADR-0002`'s "all app code is renderer JS" names *where* app code runs, the renderer rather
  than the broker, not the language it is written in.
- `compatibility-matrix.md` listed "app logic is not JavaScript" as a blocker on which "nothing
  works today, WASM included".

The third was wrong on the evidence. The served CSP carries `'wasm-unsafe-eval'` (d-0046), and
`test/e2e-served-csp.test.ts` proves a pinned bundle compiles WebAssembly, inline and streamed
from a `.wasm` asset. Three of the four apps build step 5 ports run WebAssembly: AirGap Vault
signs Sapling and Polkadot transactions in it, Element bundles its end-to-end encryption as
WebAssembly, and most of ASGARDEX's 31 MB largest chunk is WebAssembly (`ADR-0009`).
`ADR-0031` already admits a Rust program compiled to WebAssembly into Orivon itself, on the
ground that WebAssembly compiles nothing at install time and runs wherever Node runs.

## Alternatives considered

**Leave it implicit.** The behaviour exists and a test guards it. Rejected because every written
statement near the question pointed the other way, and a porter reading Rule 8's title or the
matrix would rule out a candidate that runs today.

**Accept only JavaScript apps.** It would disqualify three of the four current ports. It would
also reject the cheapest candidates in `orivon-ports`'s list, such as Threema Desktop and
MyMonero, which are cheap because their protocol core is already WebAssembly.

**Accept WebAssembly only through a WASI host.** That host is `orivon-runtime`, deferred by
`ADR-0002`, and a WASI program needing both threads and sockets is blocked upstream anyway.
WebAssembly with JavaScript bindings (wasm-bindgen, Emscripten, Go's `js/wasm`) needs no host of
Orivon's, because the renderer already is one.

## Reasoning

The thesis is that a desktop app becomes a URL (`mvp-scope.md` journey 1). What decides whether
an app can make that move is whether its code executes where Orivon puts it, and WebAssembly
executes there exactly as it executes in Node. A source language makes no difference to how an
app runs. Running in the Node environment does: it is the environment the shim reproduces and
the one `ADR-0002` shaped the API to mirror.

## Consequences

- **Every engine beneath the API must run WebAssembly in app code.** This binds the project, not
  only this build: `ADR-0002` promises that an app keeps working when the engine beneath it
  changes, and an app with a WebAssembly component is now such an app. The CSP's
  `'wasm-unsafe-eval'`, `.wasm` served as `application/wasm`, and `WebAssembly.instantiateStreaming`
  are part of what an app can rely on. `test/e2e-served-csp.test.ts` guards all three.
- **A standalone WASI program qualifies but does not run yet.** WebAssembly that imports WASI
  instead of calling JavaScript has nothing to satisfy those imports: the shim maps no
  `node:wasi`, and nothing implements WASI over `orivon.*`. That is a matrix row, taken case by
  case like every other gap.
- **WebAssembly adds no containment.** A WebAssembly component runs with its app's grants and
  inside its app's renderer sandbox, like the JavaScript around it. The containment
  `orivon-runtime` would add is a separate question, still deferred.
- **Rule 8 is retitled after what it enforces**: no native modules in Orivon's own dependencies.
  WebAssembly passes it, as `ADR-0031` already argued.

## Reversibility

- **Cost to reverse:** expensive. Reversing it would break every app with a WebAssembly
  component, three of the four current ports among them.
- **What would make us revisit:** an engine beneath the API that cannot run WebAssembly in app
  code, or a class of WebAssembly exploit that the renderer sandbox and the grant model cannot
  bound.
