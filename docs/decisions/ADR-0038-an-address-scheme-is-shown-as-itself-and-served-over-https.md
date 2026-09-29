# ADR-0038: An address scheme is shown as itself and served over HTTPS, under one routed suffix

- **Status:** accepted, amended 2026-09-29
- **Date:** 2026-09-28
- **Type:** architecture
- **Decided by:** owner, for serving over HTTPS rather than a custom scheme, for `ipfs://` and
  `ipns://` being in this build, and for new protocols needing to be addable while Orivon runs. AI
  recommendation, accepted by the owner, for the one shared suffix, its name, and the redirect that
  canonicalises a written address.

## Decision

A protocol is registered through one function, `defineProtocol` (`src/protocols/protocol.ts`),
which takes a descriptor (its id, the address schemes it serves and the top-level domains it
resolves, as plain data) and the resolvers and gatherers that serve them. The shell reads only
descriptors; no protocol's code runs in the main process.

An address scheme is shown as itself and served over HTTPS:

- **`ipfs://<name>/<path>` is what a person sees**, in the address bar, every consent dialog, the
  site-info popover and the permissions list. Copying the address bar copies it.
- **The page runs at `https://<label>.<scheme>.orivon/<path>`**, an ordinary https origin, served
  by the verifier host on loopback exactly as a `.eth` name is (`ADR-0030`). `<label>` is the
  name's canonical spelling as one DNS label, a DNSLink name inlined the way IPFS subdomain
  gateways do it (`-` doubled, `.` made `-`).
- **Every address scheme shares one suffix, `.orivon`**, routed to the verifier by a single
  `--host-resolver-rules` clause set at launch. A new scheme adds no rule of its own, so one
  registered while Orivon runs would need no restart; runtime registration itself is not part of
  this build.
- **A written address is canonicalised by its protocol, not the shell.** The shell turns
  `ipfs://<name>/<path>` into `https://ipfs.orivon/<name>/<path>`, the scheme's endpoint, and the
  verifier answers with a redirect to the origin of the name's canonical spelling: a CIDv0 becomes
  its base32 CIDv1, a key its base36 form, a DNSLink name lowercased. A host that is not the
  canonical spelling is refused, so one site has one origin. The endpoint serves only redirects
  and error pages, never a page.
- **A top-level domain stays its own host.** A `.eth` name is `https://<name>.eth` (`ADR-0030`);
  ENS registers `.eth` through the same function. Such a name is shown with its protocol's
  display scheme, `ipfs://<name>` for `.eth` (amended 2026-09-29, below).

`ipfs://` and `ipns://` are the first two schemes, both served by the IPFS protocol. An
`ipfs://` address names its content, so it is proven by construction; `ipns://<key>` is proven by
its signed record; `ipns://<domain>` goes through DNSLink and is unproven, exactly as a `.eth`
name's DNSLink hop is.

## Context

The owner asked for data-gathering protocols to be modular, each isolated in `src/protocols/`,
with a standard way to add one and its prefix visible in the address bar, and for new protocols to
become addable while Orivon runs. Two Electron 44 constraints decide the shape, both checked in
`node_modules/electron/electron.d.ts`:

- `protocol.registerSchemesAsPrivileged` works only before `ready`, and only once. A scheme
  registered later gets no standard, secure, storage, service-worker or fetch privileges.
- `--host-resolver-rules` is read at launch only. Each host suffix it must cover costs a restart
  to add.

## Alternatives considered

**A real `ipfs:` scheme through `protocol.handle`.** The page's own `location` would say
`ipfs://`, and `ipfs://` subresources would load. It lost on three counts: it cannot be added at
runtime, since privileges are fixed before `ready`; it reverses `ADR-0007` and `ADR-0030`, which
refused a custom scheme because the origin keys grants, storage and identity; and the broker, the
loader, CSP and consent all assume http(s) origins, while Electron's handled responses enforce no
CORS and drop cookies (`ADR-0030` measured it).

**A top-level domain per scheme, `https://<cid>.ipfs`.** Shorter, and it reads like `.eth`. It
lost only on runtime extensibility: each new scheme would need its own resolver rule, and so a
restart.

**`.localhost` as the suffix**, which Kubo and Brave used (`<cid>.ipfs.localhost`). The loader
and the broker deliberately refuse the whole `.localhost` namespace as an app origin
(`src/loader/fetch/install-origin.ts`, `src/loader/manifest/capabilities.ts`), and Chromium treats
it as local. **`.internal`** is reserved by ICANN for private use, and routing `*.internal` would
take over company intranets.

**Canonicalising in the shell.** It would save one local redirect, but it needs each protocol's
parser (multiformats, for IPFS) in the main process, and a protocol added at runtime would need
code there too.

## Reasoning

Every page stays an ordinary https origin, so the permission model, secure-context features,
service workers, cookies and CORS apply unchanged, and the verifier stays the one place that
serves a protocol's bytes. The shared suffix is the one design of the three in which a protocol
added later is routed, shown and served with no restart. The address people type and share is
the one the address bar shows. IPFS content is already written for this origin shape: subdomain
gateways serve `<cid>.ipfs.<host>`.

`ADR-0007` refused a synthetic subdomain too, for cached apps (`app-example-com.orivon.local`), and
that refusal does not carry over whole. Its first reason was that the synthetic name replaced an
app's real origin, splitting its grants, storage and identity key across two; an IPFS address has
no other origin to split from, so `https://<cid>.ipfs.orivon` is the only one it ever has. Its
second reason, a namespace Orivon must own and defend, does carry over, and is accepted below.

## Consequences

- **The page's own `location`, devtools and anything the page copies see the https form.** Only
  the browser's own surfaces show the address.
- **`ipfs://` subresources inside a page do not load** (`<img src="ipfs://...">`, `fetch`).
  Chromium knows no such scheme; only navigations are rewritten (`open-questions.md` A260).
- **Each CID is its own origin**, so an `ipfs://` app's grants and storage do not carry over to a
  new release. An app that wants to keep them ships under `ipns://` or a `.eth` name.
- **Orivon owns `.orivon` as a namespace.** Nothing outside Orivon resolves it, and the resolver
  rule keeps Chromium's own lookups for it off DNS. Two cases fall outside that rule, as they do for
  `.eth`: a trailing-dot spelling (`<cid>.ipfs.orivon.`), which the shell does not treat as the
  verifier's and which fails; and a configured proxy, which is sent the host name. If ICANN ever
  delegated `.orivon`, Orivon would still route it to the verifier.
- **A top-level domain added while Orivon runs still needs a restart**, since the name has to be
  the host. ENS is built in, so nothing in this build needs one.
- **Any page can make the verifier fetch any CID or IPNS name** by linking or embedding its
  origin, bounded as `.eth` lookups are (`ADR-0030`): per-site caches, shared slots, capped memory.
- **A link to an address never reaches the OS.** An app that claims `ipfs:` on this machine is not
  offered it; the tab loads the address instead.

## Amendment, 2026-09-29: a .eth name is shown as ipfs://<name>

A protocol's descriptor may name a `displayScheme`: the address scheme a name under one of its
top-level domains is shown with. ENS names `ipfs`, so `https://vitalik.eth` is shown, everywhere
an address or origin is shown, as `ipfs://vitalik.eth`. The name's origin is unchanged: grants,
storage, the loader and the verifier all still key on `https://vitalik.eth`, exactly as `ADR-0030`
describes.

**Both `ipfs://vitalik.eth` and `ipns://vitalik.eth` open `https://vitalik.eth`**, the name's own
origin, directly -- never through the `ipfs:`/`ipns:` scheme's own DNSLink-style resolution. A
`.eth` name already has an origin of its own; routing it through an address scheme's canonical
spelling would be one more hop to the same place.

The owner chose `ipfs://` as the shown form. `ipns://vitalik.eth` is the form other IPFS tools
accept for a DNSLink-style name; a copied `ipfs://vitalik.eth` is not valid outside Orivon, since
elsewhere `ipfs://` takes only a CID, never a name that still needs resolving.

*Provisional*: in this build every name the verifier loads for a `.eth` name is IPFS content
(`ADR-0030`), so the descriptor can simply name the shown prefix. Once a second data gatherer can
serve a `.eth` name, the shown prefix should come from what actually loaded the page, not from a
fixed field on the protocol's descriptor.

## Reversibility

- **Cost to reverse:** moderate. An installed `ipfs://` app's grants are keyed to its served
  origin, so changing the suffix or the label rule moves every such app to a new origin. The
  descriptor and registration function are internal.
- **What would make us revisit:** Electron allowing privileged schemes after `ready`; `ipfs://`
  subresources proving to matter for real content; or opening protocols to third-party Apps, which
  is a `src/contracts/` change and would put untrusted providers in their own sandbox.
