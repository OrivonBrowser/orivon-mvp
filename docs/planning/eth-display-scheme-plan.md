# A `.eth` name shown by where it lives: plan

**Need.** The owner decided that a `.eth` name is shown as `bzz://<name>` when its content is on
Swarm and `ipfs://<name>` when it is on IPFS. Today `ProtocolAddresses` shows every `.eth` name
with ENS's static `displayScheme: 'ipfs'` (`src/protocols/ens/descriptor.ts`), so `swarm.eth`
reads `ipfs://swarm.eth`.

**Constraint.** The shell reads descriptors only and never loads a protocol's code
(`src/protocols/README.md`). What a name points to is known only after the verifier host mounts it.
So the shown scheme becomes a fact main learns per name, and it keeps that fact.

## Design

1. **`src/protocols/address.ts`.** `ProtocolAddresses` takes an optional `learnedScheme(host):
   string | undefined`, injected (a setter or a constructor option; pick the smaller change).
   `shownScheme` asks it first for a top-level-domain name, and uses the descriptor's
   `displayScheme` only when it answers nothing. A learned scheme that no protocol serves is
   ignored, never shown (the same check the constructor makes). `loadingScreenFor` follows the same
   order: the learned scheme's protocol's screen, else the protocol's own (ENS's neutral one).
   The module stays pure: no Electron, no `node:*`.
2. **The verifier host reports what a name is.** After a successful mount of a top-level-domain
   name, it posts `{ type: 'name-scheme', host, scheme }`, where `scheme` is the address scheme of
   the gatherer that mounted it. Take it from the root's kind: `ipfs` gives `ipfs`, `swarm` gives
   `bzz`; better still, take it from the gatherer's protocol descriptor's first scheme, so a third
   protocol needs no edit here. `host-messages.ts` validates it structurally: a host that
   `servedName` maps to a top-level domain, and a scheme some built-in protocol serves.
3. **Main keeps it** (`src/main/verifier/`). A small store maps host to scheme, capped at 4096,
   least recently touched first out, written as the feed floors are (`floor-file.ts`, atomic,
   chained writes). It is loaded at startup and injected into main's `BUILTIN_ADDRESSES` once.
   When a host's scheme changes, the shell refreshes the tabs, history rows and loading screen
   that show that host. Find the existing signal that re-sends a tab's state; do not poll.
   A name that moves from IPFS to Swarm shows `bzz://` from its next mount on.
4. **Renderer pages** (Settings apps list, permissions view) run their own `BUILTIN_ADDRESSES`
   and learn nothing; they keep the descriptor's default. Where main already sends those pages
   an origin, send the display string main computes instead, only if that is a one-line change
   per page. Otherwise it is a named limit in the PR.
5. **ENS's descriptor** keeps `displayScheme: 'ipfs'` as the default for a name not yet mounted
   on this install. Update its comment to say the learned scheme overrides it.

## Tests

- **Unit:**
  - `address.test.ts`: learned beats default; an unknown learned scheme is ignored; the loading
    screen follows the learned scheme; addresses and origins other than `.eth` are unchanged.
  - Store tests: cap, eviction, atomic write, a bad file reads as empty.
  - Host-messages tests for the new message.
  - The host posts `name-scheme` on a Swarm mount and on an IPFS mount, never on a `bzz://` or
    `ipfs://` address.
- **e2e:** extend `test/web3/e2e-swarm-address.test.ts` (or add a spec beside it). A fixture
  `.eth` name on Swarm is shown as `bzz://<name>/` in the address bar once loaded, and an IPFS
  fixture name stays `ipfs://<name>/`. Add a catalogue row in `test/app-behaviours/catalogue.md`
  section Names and addresses.
- **Shell UI changed:** run the QA the `orivon-qa` skill names for an address-bar change, and read
  its screenshots.

## Docs

`src/protocols/README.md` (the `displayScheme` paragraph), `src/protocols/ens/README.md`,
`docs/features.md` if it describes how `.eth` names are shown, and a decision-log row. The
owner's decision is already row d-0603; cite it, do not add a duplicate. Check whether
ADR-0038 needs a dated amendment (`docs/decisions/` may carry history).
