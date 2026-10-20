# ADR-0096: A manifest may name the https address where its publisher takes problem reports

- **Status:** accepted
- **Date:** 2026-10-21
- **Type:** product
- **Decided by:** AI recommendation accepted by default (the shape, `https:` only, and rejecting a malformed value)

## Decision

**A manifest may carry `support: { issues: "<url>" }`, the one place its publisher wants a problem with the app
reported.** `issues` is an absolute URL written with `https://`, a host, no user name or password, no whitespace or
control character, and at most 2048 characters. The field is optional. When `support` is present and not an object,
has no `issues`, or has an `issues` that breaks one of those rules, the loader rejects the manifest with a
developer-facing reason naming `support.issues`, as it does for a malformed `domain`. A key of `support` this build does
not know is skipped without a warning, as an unknown top-level key is. The field is self-asserted, like `name`: the
shell shows it as the publisher's claim and never as something Orivon vouches for.

## Context

A port of someone else's app is maintained by the people who ported it, and a problem a person meets in the port is
the port maintainers' to look at, not the upstream project's. Today a person who meets one has nowhere to be sent:
the manifest names the app, its entry and its capabilities and nothing about where to go next. The shell's site
information panel is where a person already looks to learn about the site in front of them, and it shows an app the
same way it shows any website (an installed app behaves like a website), so the address has to be readable from the
manifest of any site that serves one, installed or not.

## Alternatives considered

- **A bare string, `support: "<url>"`.** Smaller, but a second support route (a chat, a documentation page) would
  have to change the type of an existing field, and an older build would then reject a manifest it could have read.
  An object lets a new key sit beside `issues`, where an older build skips it.
- **Allow `mailto:` as well.** Many small publishers have a mailbox and no tracker. It was left out because a
  `mailto:` address can carry a subject, a body and extra recipients that the person sees only in their mail program,
  and opening one hands a site-chosen string to another program. A mailbox, if wanted, is a new key beside `issues`
  with its own grammar; widening what `issues` accepts later would make a build that accepted the wider value
  and a build that did not disagree about the same manifest.
- **Drop a malformed value with a warning instead of rejecting the manifest.** It would keep an app installed
  against a typo. It was not chosen because every other optional field (`domain`, `consentGranularity`,
  `crossOriginIsolated`) rejects, and one rule is easier for a publisher to hold than a second; the typo is found at
  the first install, the same moment as every other manifest error. The cost is that a build which learns a wider
  grammar for `issues` later would lock out older builds' installs of a manifest using it, which is why the
  grammar is not widened (above).
- **Accept `http:`.** A report page that does not encrypt what a person types into it is a poor thing to point a
  person at from a privacy-branded browser.

## Reasoning

The smallest shape that can grow is an object with one key. `https:` only keeps the link a plain navigation the shell
already treats as one: it opens in a new tab with the usual address-bar information, and needs no new question.
Refusing credentials in the address keeps a name or password from sitting in a link the shell prints.

## Consequences

- `src/contracts/manifest.ts` gains `support?: { readonly issues: string }`; `contracts-surface.txt` and the changelog's
  *Changed for apps* list follow. An older Orivon build lists `support` among a manifest's ignored fields and runs the app
  as before.
- The shell reads the field from a site's manifest wherever one is known; that is a later change, and ports that
  write the field take effect only in builds that read it.
- A publisher who mistypes the field has the manifest rejected at install, with the reason.

## Reversibility

- **Cost to reverse:** cheap while no app depends on the display; moderate after ports publish the field, since a
  removed field becomes an ignored one rather than an error.
- **What would make us revisit:** a publisher with no web tracker who needs a mailbox (a new key, not a wider
  `issues`), or evidence that rejecting on a typo costs more installs than it saves.
