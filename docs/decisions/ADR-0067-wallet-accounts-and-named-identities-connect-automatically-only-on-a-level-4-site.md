# ADR-0067: Wallet accounts and named identities connect automatically only on a Level 4 site

- **Status:** accepted
- **Date:** 2026-10-07
- **Type:** product
- **Decided by:** **owner**

## Decision
Wallet accounts, Nostr identities and orivon.id identities connect to a site without a prompt only when
that site's Web3 Score is Level 4 (trustless). On any other site the person is asked, with a one-click
or broker grant as today. An action that moves value always prompts, on every site, whatever the level.

## Context
A wallet is not built yet. `docs/planning/wallet-system-exploration.md` section 6.2 proposed that a site
connection is a per-site permission asked at first use. The owner's direction is that accounts are
ready when the person arrives and connect without a setup step, and that the Web3 Score, which already
rates how far a site can be trusted, decides where that is safe. The rule is written down now so that the
named-identity path (`orivon.id.requestIdentity`, A111) and the wallet are built to it.

## Alternatives considered
- **Always prompt per site.** The safest default, and the one the exploration proposed. Rejected because it
  asks a question the Web3 Score can already answer on a Level 4 site, and a first visit to every site
  starts with a prompt.
- **Connect automatically on every site.** Rejected: a site the score does not vouch for would learn an
  identity or an address the person never offered it.
- **Connect automatically from Level 3.** Rejected: the owner chose Level 4, the top of the site ladder
  and the one the browser shows as Web3, as the only level where an automatic connection is safe.

## Reasoning
The connection reveals who the person is to the site, so the site's trust level is the right input, and
the Web3 Score already rates it. Value-bearing actions are separate because their cost is not
recoverable: a rule about identity must not weaken them.

## Consequences
- `capability-api.md` and the wallet exploration state this rule; the per-site connect prompt there is
  the path for every other site.
- Levels 3 and above are judged by a Web3 Score provider the person chose, so the rule is only as strong
  as that provider; a judged Level 4 still leaves every capability warning in place (`ADR-0037`). The
  exact source of the level the connect path reads is settled when it is built.
- Nothing changes in the code today; the brief is in `docs/planning/realignment-followups.md`.
- B4 (the words for keys, identities and wallets) stays open and is the owner's.

## Reversibility
- **Cost to reverse:** cheap while no wallet or named-identity path is built; moderate afterwards, as a
  person's connected sites would be asked again.
- **What would make us revisit:** a Level 4 site that connects an identity against the person's wish, or
  a site class below Level 4 the person asks to connect automatically.
