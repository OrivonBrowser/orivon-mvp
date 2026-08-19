# Inventory of pre-existing Orivon materials

Status: complete as of 2026-08-18. This file records **where the prior art lives and what
it contains**, so no future contributor (human or AI) has to rediscover it.

Nothing in this file is a decision. Decisions live in `docs/decisions/`.

---

## 1. Public documentation — PRIMARY SOURCE OF TRUTH for the long-term vision

**`/home/jhon/Desktop/Develop/orivon-docs`** — Docusaurus site, deployed to
`docs.orivonstack.com`, remote `github.com/OrivonBrowser/orivon-docs`, Apache-2.0.
Last commit `5fdfb93` (2026-03-03). **This is the newest and canonical copy.**

| File | Content | MVP relevance |
|---|---|---|
| `docs/orivon.mdx` | Master vision doc: Web3 problems, Applications system, Web3 Scores, Advanced WASM, appstore, search, DDOC, connection settings | **High** — contains the core thesis |
| `docs/technical-design/orivon-runtime.mdx` | WASM host: Wasmtime + WASI + Component Model/WIT; module identity (`bitcoin.node.metamask`); Library/Module/Group module kinds; permissions + OS grants | **High** — closest thing to an architecture spec |
| `docs/technical-design/orivon-core.mdx` | 15-line stub. `orivon-core` = official client wrapping `orivon-runtime`, enforces standards, embedded in browser | **High but nearly empty** |
| `docs/technical-design/standards.mdx` | Interface definitions for `group.net.dns`, `group.net.data-gather`, `group.net.web3score`, `group.crypto.account`. TODO list for btc/eth/address-book/network groups | **High** — the only concrete API surface |
| `docs/technical-design/orivon-objects.mdx` | `CapabilityDescriptor` schema + 6 worked examples (HW wallet, mnemonic, eIDAS smart card, KeePassXC, Binance custodial) | Medium — wallet layer, likely post-MVP |
| `docs/implementations/dns-resolution.md` | Pluggable TLD resolution, priority table, fallback | Medium |
| `docs/implementations/data-gathering.md` | Pluggable content fetch (IPFS/Arweave/IP+proxy), priority + fallback, reports DDOC status | Medium |
| `docs/implementations/native-ddoc-specs.md` | DDOC wire format: `DDOC <version> <hash>` DNS record, Core hash-tree + per-page hash-trees, `page.html.hashes`, generator script via headless Chromium | Medium |
| `docs/implementations/web3-score.md` | Trustlessity levels for Websites (4) / Operations (5) / Connections (3), `+Privacy` bonus. Security levels = "Work in progress" | Medium — see contradictions |
| `docs/implementations/wallet-system.md` | 3 layers: Accounts / Crypto (TAGs e.g. `MONERO_V1`) / Address book | Low for MVP |
| `docs/implementations/dashboard-app.md` | Android-style resizable widget grid as new-tab page | Low for MVP |
| `docs/roadmap.mdx` | Current phase = "Establishing a solid Elite Team". Build order: philosophy → team → community → name → **funding → build browser**. 3 funding stages: 30–80k / 150–400k / 750k–2M | **High** — defines what the MVP is *for* |
| `docs/economical-strategy.md` | Revenue: featured placement, default search engine, paid Web3-Score evaluation priority | Context (see contradictions) |
| `docs/dao-plan.mdx` | Pre-DAO (Discord polls) → After-DAO (on-chain, treasury). Merit-tracked token distribution. Dev salary 60–80% cash / 40–20% tokens | Not MVP |
| `docs/involving.mdx` | Roles sought: Community growth, **Rust/C++ dev**, HTML/CSS/JS, NodeJS, Solidity, Partnership, Investor | Context |
| `docs/more/mobile-note.md` | No mobile design yet; architecture intended to stay mobile-portable | Constraint |
| `docs/more/acknowledgements.md` | Contributors: Kai (community), WowSeoWeb3 (partner, prospective Web3-Score provider), Alirem, Peter | Context |

### UX concept images (`static/img/`)
- `OrivonDashboardConcept.png` — widget grid; tiles labelled with resolution method
  (`IPFS`, `DDOC`, `Storj`, `ICP`, `https://`) + a green/yellow trust dot; ETH balance in
  the toolbar; "Bisq2 easy" and "Trustless Nodes" widgets with per-network ON/OFF toggles.
- `OrivonBisqEasyConcept.png` — in-page modal: bank transfer → BTC → atomic swap → XMR,
  with **Trustless 100% / Security 99%** dials. This is the clearest artifact of the
  intended end-state UX.
- Also: `Roadmap.png`, `Funding.webp`, `TokenDistribution.jpg`, `DAOPlan.png`,
  `web3problems{1,2}.png`, `web3scores.png`, `MeritsDiscord/Github.png`.

### Stale duplicates — do not edit, do not cite
- `/home/jhon/Desktop/Develop/orivon-docs (Copy)` — pre-2026-01-27 snapshot
- `/home/jhon/Desktop/Develop/orivon-docs (Copy 2)` — 2026-01-27 snapshot
- `/home/jhon/git/orivon-docs`, `/home/jhon/git/ctobranch-orivon/orivon-docs` — other clones

---

## 1b. "OrivonBook" — NEWEST statement of the product thesis (work in progress)

**`/home/jhon/Downloads/OrivonBook/Journal/work/Orivon Book/`** — a mini-book being
written by the owner (Davide Martinico / "Sp3rick"). Dated **2026-08-18 — the most recent
material in the whole corpus**, and it supersedes earlier framings where they conflict.
Contains untranslated Italian `TODO:` markers, so it is mid-draft.

| File | Lines | Content |
|---|---|---|
| `Introduction.md` | 49 | Purpose of the book; author bio; the "Orivon theory" — *Web3 is revolutionary; the only thing missing is easy interfaces*. `TODO: aggiungere roadmap` (Where Orivon stands / What Orivon builds first / How Orivon builds) — **this is exactly the MVP question, and it is unwritten** |
| `Web3 Potential.md` | 173 | The strategic frame. Web ladder: *Web1 = protocols to read, Web2 = easy interfaces to read/write, Web3 = protocols to own, **Web4 = easy interfaces to use***. Argues Web3's value comes from globalising **supply** + maximum trust in that supply. Market table (Ethereum, Polymarket, Filecoin, Helium, Akash, Power Ledger). Historical analogy: Netscape/IE opened Web2 in 1995–96 → **Orivon intends to be the "Web4 era starter"**. One unverified economic claim (Web3 = +5–10% global economy vs +3.4% for Web1+2) sourced only to a ChatGPT share link |
| `Orivon_ How_.md` | 119 | **The most important single file in the corpus.** Motivation × Ability behavioural frame. Names **10 desktop adoption barriers**, then maps each to a feature, then justifies each mapping. Explicitly states: *"this is the source code of the Orivon idea"* and *"if the Team building Orivon fails to follow that scheme, it is reasonable that goes wrong"* |
| `New Empires.md`, `Orivon DAO Empire.md`, `Resources.md` | 0 | Planned, empty |

### The 10 barriers (canonical list, from `Orivon_ How_.md`)
Practical inability · Feeling unsafe · Missing resources · Web2.5 confusion ·
Mentally heavy · Social proof · Useless perception · Privacy worrying · Habit friction ·
Dependence lack.

### Current feature vocabulary — supersedes older names
| Book term | Earlier name(s) |
|---|---|
| **WASM Orivon Execution Layer** | "Advanced WASM", "Programs on-fly", `orivon-runtime` |
| **Web3 Accounts** | "Wallet system" |
| **Web3 Scores** | "Trustlessity & Security score", "Web3 Verification" |
| **Web3 Green mark** | (new) the yellow "you are in Web2" badge, inverted into a network-effect incentive for site owners to adopt |
| **Android-like permissions system** | "permissions + OS grants" |
| **Web3 Appstore**, **Dashboard**, **Pre-configured integrations** | unchanged |

> Two positions in this file are load-bearing and contested — see
> `docs/open-questions.md` §B4 (zero-setup auto-connecting accounts) and §A4
> (the book concedes Web3 Scores only work *"once Web3 scores gets the right authority
> to be considerable reliable"*).

---

## 2. Private planning material

**`/home/jhon/Desktop/Orivon Browser/`** — not version-controlled. Mixed Italian/English.
Contains the *evolution* of the architecture, which the public docs flatten out.

### Technically load-bearing
| File | Date | Content |
|---|---|---|
| `Posts/Technical Specifications` | 2025-12-19 | Fullest single technical write-up. States **"Orivon will be an Hard Fork of Brave, with Chromium as upstream"**. Enumerates the 6 App integration types. Dashboard served at `http://127.0.0.1/dashboard`. WASI as the compile target |
| `Old-Private-Plan/Struttura Browser` | 2025-12-19 | Same feature set, plus the key maintenance warning: fork Brave *shallowly* — "if you **add** you're chill; if you **modify** it starts to burn". Names Networking / connections / DNS / DDOC as the dangerous deep-modification areas. Orivon logic lives in a **separate `orivon-backend`**; browser side stays frontend-only and Extension-compatible |
| `Archivio/Struttura Stack` | 2025-12-10 | An **earlier, different architecture**: browser *extension* + local companion daemon over local HTTP/WebSocket. Also: Client Profile system (identity/data/settings separation), proxy-chain loop detection, per-App proxy override |
| `technical/orivon-core` | 2026-02-06 | `orivon-core` as a standalone queryable **daemon**, CLI-debuggable. Enumerates module capability sets (Metadata, DNS Resolution, Data Gathering, Account, Crypto, Address List, **Network-core**, Network, Web3 Score provider) and the full permission matrix. Ends with the unanswered heading *"Come Orivon Core si connetterà al browser?"* — how core connects to the browser |
| `Old-Private-Plan/Web3 Verification levels` | 2025-12-18 | **Earlier, different** trustlessity ladders — 5 site levels (incl. "full-stack runs entirely locally" as L3), and marks which levels need a human/AI **Giudice** (judge) |
| `Old-Private-Plan/Glossario` | 2025-12-02 | DDOC expanded as *Data Domain Ownership **Certification***. Claims DDOC lets Web3-compliant sites use self-signed HTTPS. Frames site certification as 3 orthogonal axes: DDOC / Web3 Verified / Security |
| `Old-Private-Plan/La Piramide dei Pilastri` | 2025-12-16 | **The most valuable strategy doc.** Enumerates why Web3 is not mainstream on desktop vs mobile, then maps each blocker to a browser feature. Contains the "**zero-setup wallet**" position ("It's not a crypto wallet, it's a Web3 wallet"), the stablecoin focus, the yellow "you are in Web2" badge, and the reasoning for **deferring mobile** while keeping WASM as the portability guarantee |

### Non-technical (community / team / growth / economics) — read only if relevant
`Involved-resources/` (Community-Growth, Growth-Manager, X-Twitter Strategy),
`religion-system/`, `Posts/` (Reddit First Post, Economic plan), `Management-Team.txt`,
`Come-Gestire-Devs-Early-Stage.txt`, `First-Contact-Method`, `Script-Gestione-Nuovi.txt`,
`TeamScore.ods`, `Community-Graph.svg`, `Old-Private-Plan/{Plan, Piano Economico}`,
`temp/Facaw-Flinch-Idea.txt`, `Archivio/Untitled 1.odt`.

`Commit-Tecnico-review` (2026-03-14) is a review of one contributor's work — not
architecture. Deliberately not read.

---

## 3. Prior code

**`/home/jhon/git/orivon-browser-v2`** — Electron + electron-vite + TypeScript.
Remote `github.com/OrivonBrowser/orivon-browser-v2`. Last commit 2026-05-26 by
`barnazaka`. Commit log shows tabs, dashboard, AppStore/NodeManager/Settings pages,
an onboarding flow that was removed for crashing, and wallet init moved to main process.

> **Owner's verdict: this is a failed MVP and is to be ignored.**
> Not a baseline, not a reference architecture. Its only value is as evidence about
> what went wrong — see `docs/open-questions.md`.

**`/home/jhon/git/Orivon-website`** — Next.js marketing site. Unrelated to MVP.

**`github.com/OrivonBrowser/native-ddoc-lib`** — referenced from `roadmap.mdx` as a
contributor proof-of-concept for DDOC. Not present locally; not yet reviewed.

---

## 4. Community / channel surface
Discord `discord.gg/DuRg87MvgD` (primary) · Forum `orivonstack.com` (OrivonStack) ·
Docs `docs.orivonstack.com` · X `x.com/OrivonBrowser` · Telegram `t.me/OrivonBrowser` ·
GitHub org `github.com/OrivonBrowser`.

---

## 5. Local development environment (measured 2026-08-18)
Linux 7.0.0-29-generic · 8 cores · 23 GiB RAM · **76 GiB free disk (92% full)**
Node v24.11.1 · npm 11.6.2 · **rustc/cargo 1.75.0 (Dec 2023 — too old for
`wasm32-wasip2` / current Component Model tooling)** · Python 3.12.3 · git 2.43.0

Both the disk headroom and the Rust version are constraints if a Chromium fork or a
Wasmtime/component-model toolchain is in scope. See `docs/open-questions.md`.
