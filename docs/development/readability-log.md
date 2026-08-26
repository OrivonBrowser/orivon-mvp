# Readability log

A standing check that this repository is legible to a human, run on a human.

**Owner policy, 2026-08-26.** The goal is that a developer arriving alone, with no AI
assistance, can start working. That is not verifiable by the people who wrote the
documentation — we cannot un-know what we know. So it is tested on someone who has not read the
thing being tested.

## The protocol

At the end of every build step, **one artefact** is handed to the owner — the document a
newcomer would actually hit at that point in the project — with **one question**:

> Read this cold. Where is the first place you got lost, or had to guess?

**Not "is this good?"**, which reliably returns a useless answer. And deliberately only the
*first* confusion point: everything after it is unreliable, because the reader is already lost
and is now guessing from context rather than reading. Fix that point, then ask again about what
follows.

The answer is the fix list. It is not feedback to consider.

## Why it is recorded

Three reasons, in order of how much they matter:

1. **So the checks accumulate.** Occasional feedback evaporates; a table is evidence.
2. **So a later contributor can see which parts have actually been tested on a human**, and
   which are still only assumed to be clear.
3. **So the same confusion is not fixed twice**, or worse, reintroduced.

## Log

| Date | Artefact | First confusion point | Fix made |
|---|---|---|---|
| 2026-08-26 | `README.md` | **No roadmap at all.** A reader could not tell what was built, what was next, or what had been deliberately left out | Added §Roadmap: the eleven build steps with their state, plus explicit "deferred" and "not scheduled" lists, so omissions read as decisions rather than gaps |
| 2026-08-26 | `README.md` | **"I don't understand how it is related to Web3."** Nostr and P2P appeared with no explanation of why a browser is the right place for them | Added §How this relates to Web3, stating the actual argument — decentralised protocols get routed through centralised gateways *because the browser will not speak them* — plus an explicit "what Orivon is not" list: no wallet, no token, no chain, no DAO, ENS/IPFS/DDOC deferred |
| 2026-08-26 | `ARCHITECTURE.md` | **Actively wrong message.** A "now / later / later still" table read as *this repository's roadmap to becoming a browser-engine fork*. It was meant to say what the interface is designed to outlive | Rewrote the opening as §What this repository is / §What is *not* disposable, saying plainly that this is an Electron app and is meant to be replaceable, that the engine swap is a design property and **not a schedule, not planned, and out of scope**. Retitled the directory table's column from "Survives a Chromium fork?" to "Tied to Electron?", which is the question actually being answered |

| 2026-08-26 | `README.md` §How this relates to Web3 | **"Not a wallet, not a DAO" conflicts with Orivon's actual long-term goal — those are MVP boundaries, not permanent positions.** The wallet has a three-layer design (`docs/implementations/wallet-system.md`) of which this MVP ships only the first; the DAO has its own plan (`docs/dao-plan.mdx`) with a treasury and merit-tracked distribution | Reframed the whole block from *"what Orivon is not"* to *"what is not in this MVP"*, splitting two genuinely different categories: **deferred but planned** (wallet Crypto and Address-book layers, ENS, IPFS, DDOC) versus **organisational rather than a browser feature** (DAO, token, governance — real, and living in `orivon-docs`). The roadmap gained a matching note that it covers the product only |

### What these rounds changed about how the docs are written

The first two README findings were **absences** — nothing was wrong, something was missing, and
the reader could not tell "deliberately out of scope" from "not thought about". That is now a
rule: **every omission a reader might notice is stated as an omission, with its reason.**

The other two were the same failure twice, in opposite directions, and both were mine:

| | What it said | What was true |
|---|---|---|
| `ARCHITECTURE.md` | A "now / later / later still" table, reading as *this repo is becoming a browser-engine fork* | A design property. **Not planned, not scheduled, out of scope** |
| `README.md` | "Not a wallet, no DAO — there won't be one" | Both are **real long-term goals**. Only this MVP excludes them |

**The rule that follows, and it is now binding on anything written in this repository:**

> **Never state an MVP scope boundary as a permanent property of Orivon, and never state a
> long-term aspiration as a plan for this repository.**

Both errors read as confident and precise. Neither was. A sentence about scope must make clear
*which* thing it is bounding — this month's build, this repository, or the project — because a
reader cannot recover that from context, and will believe whichever one the sentence implies.
