# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

1. **Preferred:** [GitHub private vulnerability reporting](https://github.com/OrivonBrowser/orivon-mvp/security/advisories/new)
   — the *Security* tab of this repository. It is private, it threads properly, and it produces
   a CVE if one is warranted.
2. **Fallback:** accauntacaso57@gmail.com

Please include what you did, what happened, what you expected, and the commit or version you
tested. A proof of concept is welcome but not required — a clear description of the flaw is
worth more than a working exploit.

**Response.** This is currently a one-person project, so: acknowledgement within **7 days**,
and an assessment within **30**. If you do not hear back in 7 days, assume the message was
lost and send it again through the other channel.

**Disclosure.** Coordinated. Tell us first, give us a reasonable window to fix it, and we will
credit you in the advisory and the changelog unless you prefer otherwise. There is no bounty
programme — this project has no money.

---

## What you should know before you start looking

### The MVP's security model is authorisation, not containment

This is stated plainly because it changes what counts as a vulnerability.

Orivon decides **whether an app may do a thing**. It does not, in this version, contain the app
if that decision is wrong. An app granted `tcp.connect: ["*:*"]` genuinely can connect anywhere
— that is the grant working, not failing. Containment for untrusted code is a real goal, and it
is deferred to a future runtime, not cancelled
([`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

So the highest-value bugs are ones where **the decision itself is wrong or bypassable**:

| | |
|---|---|
| **The broker's authorisation logic** | [`src/broker/`](src/broker/) and especially [`src/broker/policy/`](src/broker/policy/). The crown jewels |
| **Origin derivation** | If an origin can be spoofed or confused, every grant, every storage domain and every derived key is keyed on a lie |
| **Path confinement** | `..`, symlinks, and the platform-specific forms of both |
| **DNS rebinding** | Patterns must be matched against **resolved addresses**. A correct glob matcher fed a *hostname* is completely defeated, and this is the subtlest one |
| **The preload boundary** | Anything that gets `require`, `process`, or a raw `MessagePortMain` into a page's main world |
| **The update path** | An update that should have prompted and did not. Its failure mode is *"no prompt appeared"*, which nothing else catches |

The full threat model, with identifiers referenced throughout the codebase, is
[`docs/architecture/security-model.md`](docs/architecture/security-model.md).

### Already known, and not vulnerabilities

Please don't report these; they are documented design positions.

- **Swarm peers see the user's IP address.** No Tor in v0. Stated in the README and in-product.
- **Protocol encryption is obfuscation, not privacy.** Its Diffie-Hellman exchange is
  unauthenticated and RC4 is broken. It exists to defeat ISP traffic shaping, not
  eavesdroppers, and it is never presented as more than that.
- **`window.nostr`'s presence is fingerprintable.** True of every NIP-07 extension. The *data*
  behind it is what sits behind consent (T16).
- **Address-bar text that isn't a URL goes to DuckDuckGo**, so search text leaves the machine.
  An accepted, disclosed trade-off.
- **Apps are unsigned in v0.** Integrity rests on hash-pinning (trust on first use). Signing
  returns when a second publisher exists
  ([`capability-api.md`](docs/architecture/capability-api.md) §Signing is not in v0).

### Current state

**Pre-alpha. The capability broker is not written yet.** As of now the shell exists and the
contracts are defined. There is nothing released, nothing packaged, and no users to protect —
so the most useful reports today are about the *design* in
[`docs/architecture/`](docs/architecture/) rather than about the code.

Design-level reports are genuinely welcome. A flaw found in `capability-api.md` costs an
afternoon; the same flaw found after apps exist costs a migration.

## Supported versions

None yet. There has been no release. When there is, this table will say which versions receive
fixes.
