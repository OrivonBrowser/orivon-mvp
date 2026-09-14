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

| 2026-09-03 | `docs/development/code-guidelines.md` §Rule 1, as rewritten | **"A comment describes the code as it stands, not the change that produced it" — could not follow it.** Four banned phrasings ran together in one sentence, and "the second kind ages into an outright lie" had no resolvable referent; the provenance of the rule was welded onto the end of the rule itself | Replaced the paragraph with a two-column **do-not-write / write-instead** table, one row per banned phrasing, and moved the audit provenance to §Background |
| 2026-09-11 | `README.md` | **"Build step 1 of 10 is done" — inaccurate.** Steps 2 and 3 had landed the day before, and the same banner still said *"the capability broker — the actual product — is not written yet"*, which the roadmap table eight lines below contradicted. The document argued with itself, and the banner is what a reader meets first | Rewrote the banner to say steps 1-3 are done and to state the honest limit in its place — **no app can ask for a permission yet, so nothing is granted in practice** — and pointed it at the compatibility matrix as well as the build plan. The stale `CHANGELOG.md` the banner sends readers to, which still described step 1 only, was brought up to date in the same pass |
| 2026-09-11 | `README.md` §Roadmap | **Process trivia in a product document.** *"Steps 2 and 3 landed on 2026-09-10, in one unattended multi-agent run of about eighteen hours."* The owner's words: *who cares if you're a new reader, but even a contributor* | Deleted. How the work got done is not what a README is for. The one useful half — a pointer to the compatibility matrix — moved into the status banner, where a reader looking for "what works today" will actually be |
| 2026-09-14 | `README.md` | **None. The owner read it and found it well ordered.** | No fix needed. Recorded because a round that finds nothing is a result, not a skipped gate -- see Round 5 below for why this one is worth keeping |

### Round 5 — 2026-09-14, `README.md`

**The first round to come back clean, and worth recording for that reason rather than in spite of
it.**

Handed over at the end of build step 4, after a landing of twenty-four PRs that changed what the
document could honestly claim: the app loader now works end to end, so the banner's own statement
of the limit ("no app can ask for a permission yet") had become false and was rewritten during the
landing itself. The owner's verdict on the result: *well ordered.* No first confusion point.

**One thing was fixed before the artefact was handed over, and it is the reason this round is not
simply "nothing happened".** While choosing which document to give the owner, the conductor found
that `README.md`'s "What's different" table still promised consent *"the moment the site actually
requests a capability"* -- deferred consent, which owner decision `d-0025` had reversed that same
morning. It contradicted the status banner eight lines above it.

**That is Round 4's own finding reproduced exactly**: a document contradicting itself in its own
opening, with the banner correct and the text below it stale. Round 4 caught it in the banner;
this time the banner was right and the table was wrong. The failure mode is not "the banner goes
stale" -- it is **that a decision reversed in one place survives in another**, and the opening of
a README is where a reader meets both.

It was fixed rather than left for the cold read, on the reasoning that handing someone a document
already known to state something false wastes the read. That is a judgement call worth naming: a
readability check is for *where a reader gets lost*, not for defects the author already knows
about, and the two should not be conflated.

**What this round adds to how the docs are written:** when a decision is reversed, grep for the
old claim rather than correcting the place it was noticed. `d-0025`'s reversal was carried into
`ADR-0012`, `docs/README.md`'s index row and the status banner on the day it was taken -- and
still left one sentence standing in a table nobody thought to look at.

### Round 3 — 2026-09-03, `code-guidelines.md`

The owner gave five findings rather than one, and they turned out to be a single failure seen
five times: **the document was organised as a history of decisions, not as a guide to writing
code.** Every rule interleaved "here is the rule" with "here is the audit that produced it", so
the rule could not be read without the archaeology.

Which is the failure the document is about. It told the reader that rationale belongs somewhere
other than the thing it explains, in a file where rationale was woven through every rule.

| # | Finding | Fix |
|---|---|---|
| 1 | §"A comment describes the code as it stands" unreadable | Do-not-write / write-instead table; provenance moved out |
| 2 | The opening of §The second test unreadable, though its examples were clear | **It opened with three sentences of rationale for why the rule exists, before stating the rule.** Now opens with the rule in a block quote, then the worked example. The reasoning moved to §Background |
| 3 | §The budget understandable, but no quick view of what is and is not allowed | Added a **what you can and cannot do** table: seven rows, each naming the situation, whether it is allowed, and how |
| 4 | Past errors referenced throughout, motivating but heavy — worst in Rules 2 and 3 | All history moved to a single §Background, explicitly marked skippable. Rules 1-3 now state the rule and nothing else |
| 5 | §Applying the rules — could not tell why it mattered or why to read it | **Deleted as a section.** Its three parts were exceptions to Rules 1, 2 and 3, separated from the rules they modified. Each is now stated with its own rule |
| 6 | §Open points felt off-topic for a code guidelines file | Shrunk to §Status: one short entry per item, each linking to where the detail lives |

**The rule that follows, and it is binding on anything written here:**

> **State the rule first and completely. Put why it exists somewhere the reader can skip.**

A document that explains itself as it goes forces every reader to pay the cost of a debate that
was settled once. That cost is invisible to whoever writes it — they already know which
sentences are the rule — and it is the whole of the reading experience for everyone else. The
same test Rule 1 now applies to comments applies to the documents: *would someone acting on this
get it wrong without this sentence?* If not, it is background.

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
