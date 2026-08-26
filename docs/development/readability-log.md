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
| | | | |

*(Empty until the first check runs, at the end of the repo-and-parallel-work task.)*
