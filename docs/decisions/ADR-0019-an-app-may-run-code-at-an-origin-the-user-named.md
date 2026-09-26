# ADR-0019: An app may run code in an empty document at an origin the user named

- **Status:** proposed
- **Date:** 2026-09-18
- **Type:** security
- **Decided by:** AI recommendation, awaiting the owner

## Decision

Orivon gains one capability kind, `web.context`, and one namespace, `orivon.web`. An app holding
a `web.context` grant for an origin may **open an isolated context** there. That is an empty
document whose origin is the named one, in a storage partition that is empty when it opens and
cleared when it closes. The app runs a script in the context with `evaluate` and receives the
script's result. That is the whole interface.

The context:

- **has no `orivon.*`, no preload and no cookies**, and is never displayed;
- **has no network of its own.** Every request it makes is authorised against the *opening app's*
  own `https.connect` grant, and travels the path the loader already uses for an installed app's
  third-party reach: `fetchThirdParty` in `src/loader/serve/serve.ts`, which uses Node's `https` with no
  cookie jar, follows no redirects, and carries the A199 revocation guard and the A200 socket
  allowance. A host the app may not reach, the context may not reach either.
- **cannot navigate its top frame, open windows, download, or be granted any web permission.**
  A subframe it creates may load, over the same grant, the way any page may embed another site.
  That frame runs that site's own code under the web's same-origin rules, never the app's. The
  one origin the app's own code runs as is the one the person named. BotGuard itself creates a
  subframe, which is why subframes are not refused.
- **has no WebRTC**, and any connection Chromium would dial outside the protocol handlers fails
  at an unreachable proxy.

A `web.context` pattern is an exact `https://host[:port]` origin, with no wildcard. It must not
be an address literal outside public unicast (T12), and must not be an Orivon-internal origin.

## Context

Measured, not reasoned (`orivon-ports`'s `apps/freetube/README.md` §Spike results):

- YouTube's integrity token (`GenerateIT`) is issued **only to a document at
  `https://www.youtube.com`**. The same view at `https://example.org` or at an opaque origin got
  `[null, ...]` in every run. So did a sandboxed child, in view, off-screen and 1x1.
- Upstream FreeTube reaches that origin by loading a `data:` URL with `baseURLForDataURL` into
  a `WebContentsView`. That is a privilege of the embedding application. A web page cannot host a
  document at another site's origin, so no child-context primitive can do it: not a
  manifest-declared sandbox page, not a `srcdoc` frame, not a worker with delegated ports.
- Relaying the context's requests through a Node `fetch` in the trusted process gets a token
  3 of 3 times, so the broker's own network path is acceptable to the site.

Without this capability, FreeTube cannot play what YouTube serves over SABR. The same holds for
any alternative frontend of a site that binds attestation to its origin. Those are the
applications Orivon exists for: they run in Electron today because the web forbids them.

## Alternatives considered

1. **Manifest-declared sandbox pages (Chrome MV3 `sandbox.pages`).** Measured: the primitive
   works (the CSP `sandbox` header is honoured on `protocol.handle` responses, live origins can be
   sandboxed through `onHeadersReceived`, and sandboxed frames are process-isolated). But the
   document's origin is opaque, so it cannot mint the token. Lost on the measurement.
2. **Delegated capability ports to a child context.** It has the same origin problem, and on top
   needs a T17 exception and a versioned wire format, about 3-4 engineer-weeks. Lost on the same
   measurement.
3. **Do nothing.** FreeTube would play only what YouTube serves without SABR. Measured: the WEB
   client is SABR-only, and `ANDROID_VR` returns `LOGIN_REQUIRED` for most videos. Lost because
   it means no playback.
4. **Run BotGuard in the trusted process, under jsdom** (yt-dlp's provider does this). That runs
   Google's VM with Node's privileges inside the broker. Rejected outright.
5. **Give the context Chromium's own network in its partition** (what FreeTube does). It bypasses
   the broker: every grant, the T12 private-address gate, and the socket allowance. Rejected
   outright.
6. **No network at all, with the app relaying every request over a message channel.** It works:
   the spike's relayed view got a token 3 of 3 times. But the contract grows a message channel,
   every app writes its own relay, and a script that loads anything except through `fetch`
   breaks. **Kept as the fallback** if the chosen shape proves too wide.

## Reasoning

**What the capability adds, exactly.** An app holding `https.connect` for `www.youtube.com` can
already send that host any request, with any `Origin` header, and read any response (ADR-0017).
The one thing it cannot do is run a script whose `location.origin` reads `https://www.youtube.com`.
That script environment is the entire delta.

**What it does not add:**

- the person's data at that site: the partition is empty, and their real cookies live in
  partitions a context never touches;
- any host beyond the app's own grant;
- persistence, UI, or `orivon.*`.

**The prompt can say it honestly and plainly:** *"Run code as www.youtube.com, in a private, empty
session. It cannot see your account or anything you keep there."* A separate grant kind means
this is never implied by `https.connect`, and never hidden behind it.

**It is general.** Every Electron app that runs a site's script in a hidden view at that site's
origin (FreeTube's pattern) needs exactly this. So does every app whose target site binds its
bot-check to its own origin.

## Consequences

- **The web's rule that a page cannot claim another origin is relaxed**, for a granted app,
  towards a site the person named at consent. Site operators' anti-abuse systems are built to
  notice exactly this, so Orivon becomes a way past them for the apps a person grants. That is a
  stance, not a side effect: the same one ADR-0017 took with forbidden headers, one step further.
- **CORS is relaxed inside the context only.** Responses carry `Access-Control-Allow-Origin` for
  the context's own origin, and preflights are answered without touching the network. That is
  justified because the app can read these responses anyway through routed fetch, and the context
  carries no credentials.
- **Electron never frees a session** (FreeTube hit OS resource exhaustion by creating one per
  token). So a context reuses one in-memory partition per (app, origin), cleared on close, with a
  small platform cap on concurrent contexts.
- **The contract is permanent** once an app ships against it (ADR-0002).
- **Held until the docs reorganisation lands:** `docs/architecture/capability-api.md`'s v0 surface,
  a `security-model.md` threat row, the `docs/README.md` ADR index, and the decision-log row.

## Reversibility

- **Cost to reverse:** cheap before the contracts PR merges; expensive once any app depends on it.
- **What would make us revisit:** a site operator or a legal review objecting to Orivon as the
  tool; a child-context primitive becoming able to carry origin-bound attestation; or an app
  found using a context against a site where it could harm the person, which cannot happen through
  UI since contexts are never displayed.
