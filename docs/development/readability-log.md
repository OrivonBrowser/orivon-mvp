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

### What this round changed about how the docs are written

Both README findings were **absences**, not errors — nothing was wrong, something was missing,
and the reader could not tell the difference between "deliberately out of scope" and "not
thought about". That is now a rule: **every omission a reader might notice is stated as an
omission, with its reason.** The `ARCHITECTURE.md` finding was the opposite failure, and the
more serious one: a diagram that was accurate about the design and misleading about the plan.
Aspiration and schedule must be visibly separated.
