# Wallet system: exploration and recommended path

> **Draft, 2026-09-28.** Written for the agent that will implement the wallet system, before any
> code exists. It records what the vision asks for, what the repository already has, the design
> this exploration recommends, and the decisions the owner still has to make. `docs/planning/` is
> exempt from CLAUDE.md Rule 2, so dates and reasoning stay here; the live pages named in section
> 12 must be rewritten to state only what is true once the work lands.

**The ask.** Build the wallet system of the canonical
[Wallet system](https://docs.orivonstack.com/docs/implementations/wallet-system) page. In this
build every layer is provided by the browser itself; nothing is provided by an installed app yet.
The code must keep the seams that let integrations (installed apps acting as providers) plug into
each layer later, without a rewrite.

**Read first, in this order:** `CLAUDE.md`, `docs/scope.md`, `docs/architecture/capability-api.md`
(the "Two kinds of identity" section), `ADR-0010`, `ADR-0033`, `ADR-0021`, `ADR-0031`,
`src/resolution/README.md`, `src/main/keyring/README.md`, `src/nostr/README.md`, then this
document. Section 8 is the file map for the code path a new capability follows.

**One sentence of orientation.** Orivon already has half a wallet: a keyring-sealed seed with a
frozen derivation scheme (`orivon.id`), a verified Ethereum provider running in every install
(Helios, for `.eth` names), `viem` in the dependency tree, a provider registry pattern
(`src/resolution/`), a per-site permission model (notifications), a page-global rule for
`window.*` injections, and a Web3 Score shield to hang the auto-connect policy on. What it has
none of is: a funds-bearing secret, a connect prompt, secp256k1 signing, a chain layer that an
app can call, and any wallet UI.

---

## 1. What the vision asks for

Summarised and linked, never copied (CLAUDE.md, "The vision corpus"). Sources:
`<vision-corpus>/implementations/wallet-system.md`, `technical-design/orivon-objects.mdx`,
`technical-design/standards.mdx`, `technical-design/orivon-runtime.mdx`, `orivon.mdx`,
`implementations/web3-score.md`, `implementations/dashboard-app.md`.

**Three layers, each one a kind of App (integration) in the vision:**

| Layer | Vision name | What it provides | Holds private keys? |
|---|---|---|---|
| 1 | **Accounts** | A signing method: mnemonic, hardware wallet, smart account, multisig, custodial. May open a GUI at the moment of an operation. Exposes a set of functions; the more it exposes, the more cryptos it is compatible with. Depending on user settings and the site's Web3 Score, an account may connect to a site automatically | Yes, or a proxy to a device that does |
| 2 | **Crypto** | One crypto's function scheme: derive addresses, sign and verify transactions, talk to its network. Identified by a standardised **TAG** (the page's example is `MONERO_V1`). Sites declare which TAGs they support or need, so the browser can tell them what is available. New TAGs are defined by the community on the OrivonStack forum | No: it asks an account to sign |
| 3 | **Address book** | The list of addresses a person can use, generated from an account's keys through a crypto's scheme: the default derivation paths, a vanity list, a Gnosis Safe list. May open a GUI | No, by design ("generally safe") |

**The compatibility contract between layers 1 and 2 is the `CapabilityDescriptor`**
(`orivon-objects.mdx`): an account type publishes an array of `{ algorithm: { mode, scheme,
capabilities }, key?: { keyList }, context?: { chain, network, maxPayloadSize, metadata } }`,
with a small wildcard grammar for `keyList` (`{*}`, `{0-10}`, `{5-*}`). A crypto module reads the
descriptors to decide whether, and for which operations, an account can serve it. The page's
worked examples cover a Bitcoin-only hardware wallet, a multi-coin one, a mnemonic, an eIDAS smart
card, KeePassXC and a custodial exchange account.

**The standard the vision writes for layer 1** (`standards.mdx`, `group.crypto.account`): an
account module implements `accountTypes`, `createAccount`, `accountList`, `getAccountDescriptor`,
`accountOperate(accountId, payload, options)` and `accountGetKey(accountId, path)`; the group
exposes the same set plus `setModulePriority` and `getModules`. The layer-2 and layer-3 standards
(`group.crypto.eth0-1`, `group.crypto.btc0-1`, `group.crypto.address-book`,
`group.crypto.view-only-address-book`) and the network standards (`group.network.eth-0-1`) are
listed as TODO. Module identifiers are reverse-DNS-like (`mnemonic.crypto.orivon`).

**Two more vision facts the design must respect.** The dashboard's pre-inserted apps include
"Wallet management" (`dashboard-app.md`). And `orivon.mdx` names Accounts, Crypto and Address
list as three of the eight kinds of App, alongside Network apps that give sites access to a
network (Bitcoin, Tor, an IPFS node).

**The owner's earlier private notes** (indexed in `docs/inventory.md`; `<early-notes>`) add the
product position the public page does not state: a wallet with no setup and no password, ready
at first launch, with extra setup offered only when real money is involved; a focus on holding
stablecoins rather than on cryptocurrencies as such; one wallet per browser that a site connects
to by permission; wallet "extensions" (the example is Monero) installable as apps and connectable
to sites; and one identity holding several accounts, each account showing sections per crypto
TAG, some native and some added by an app. The "no setup, free operations" half of that position
is what `orivon.id` already is. This document is about the other half.

### 1.1 Gaps and contradictions in the vision, to append to `open-questions.md`

CLAUDE.md Rule 3: surface, never smooth over. Each should become an A-number row when the work
starts (next free number at the time of writing: A259; check the tail of the file).

1. **TAG spelling.** `wallet-system.md` writes `MONERO_V1`; `standards.mdx` names the groups
   `group.crypto.eth0-1` and `group.network.eth-0-1`. One identifier space or two? This build
   needs one string for Ethereum. Recommendation below (section 3.4): a provisional TAG,
   recorded as provisional, with the standards-page spelling noted.
2. **`accountGetKey(accountId, path) | bytes`.** Read literally, layer 1 hands key bytes to
   whoever holds the group. If that means a private key, it contradicts the repository's own
   T8 ("raw export is not a capability at any tier") and the page's own claim that layer-3 apps
   have no access to private keys. Recommendation: it returns a **public** key (or an extended
   public key for derivation), never a private one; a private key never crosses a module
   boundary. Needs the owner's confirmation before it is written into a type.
3. **Auto-connect versus the repository's identity model.** The vision lets an account connect
   automatically "depending on user settings and Web3 Score". `open-questions.md` B4 records
   that a funds-bearing wallet is "a separate, setup-requiring thing" behind explicit per-site
   consent. Both can hold if auto-connect is off by default and only ever available at site
   Level 4; section 6.2 proposes exactly that. It is a policy the owner must confirm.
4. **The `CapabilityDescriptor` examples are illustrative, not valid code** (a `.join` on an
   object literal, an object written with array braces). The repository should define its own
   TypeScript type that transcribes the *shape* and its wildcard grammar, and say the vision page
   is the source it transcribes.
5. **Sites declaring TAGs.** The vision says sites declare which TAGs they need. A tier-1 dApp
   declares nothing; it probes `window.ethereum`. An Orivon manifest has no field for it. Where
   that declaration goes (a manifest field, an HTML hint, EIP-6963-style discovery) is open;
   section 6.3 keeps it out of this step.

---

## 2. Where the repository stands

### 2.1 What exists and what the wallet reuses

| Piece | Where | How the wallet uses it |
|---|---|---|
| Identity seed, sealed by the OS keyring, never overwritten when unreadable, session-only fallback | `src/main/keyring/seed-store.ts`, `ADR-0033` | The **pattern** for sealing the wallet's own secret: same `SafeStorageLike` injection, same three-way read result, same never-write-over-unreadable rule. Not the same seed (section 4) |
| `Keychain` interface | `src/broker/secrets-contracts.ts` | The shape a wallet keystore adapter follows |
| Frozen HKDF derivation, labels `app` and `identity`, curves `secp256k1` and `P-256`; secp256k1 point math absent | `src/broker/policy/derive.ts`, `ADR-0010` | Not used for funds keys (section 4). Its ADR already says a pure-JS curve library is acceptable one layer up and that the decision belongs to the stream that first needs secp256k1. The wallet is that stream |
| `viem` 2.56.8 with `@noble/curves`, `@noble/hashes`, `@scure/bip32`, `@scure/bip39`, `ox` beneath it | `package.json`, `node_modules/viem/accounts` | BIP-39 generation and import, BIP-32 derivation, `toAccount` for a custom signer, message, typed-data and transaction signing, RLP and EIP-1559 serialisation, ABI coding. All JavaScript: CLAUDE.md Rule 8 holds, and `check:natives` will confirm |
| Helios light client, pinned `0.11.1`, in the verifier host only, behind one EIP-1193 provider, with execution-RPC failover | `src/verifier-host/light-client/`, `ADR-0031`, `src/main/verifier/endpoints.ts` | The verified Ethereum mainnet **network** for the wallet's chain layer. Its build answers `eth_call`, `eth_getBalance`, `eth_getTransactionCount`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_getLogs`, `eth_getTransactionReceipt`, `eth_sendRawTransaction` and subscriptions (grep of `dist/lib.mjs`). Section 5 |
| Shell-to-host protocol with a deadline per request | `src/verifier-host/protocol.ts`, `src/main/verifier/verifier-subsystem.ts` (`supervisor.request`) | One new `HostRequest` kind carries JSON-RPC to the light client |
| Provider registry: two provider shapes, ordered fallback, most-specific failure | `src/resolution/{providers,registry,records}.ts` | The **precedent** for the wallet's three provider layers and their registry: durable directory, no Electron, plain-data records, built-in providers only, "opening these interfaces to third-party Apps would be a `src/contracts/` change" |
| Page-global rule and its guard | `ADR-0021`, `scripts/check-page-globals.mjs` | `window.ethereum` is a borrowed name: it must carry the platform descriptor (writable and configurable), and the guard scans `src/preload/`, `src/shim/`, `src/shim-electron/`, `src/loader/`. Install functions are serialised with `Function.prototype.toString()` and cannot call helpers outside their own body |
| Main-world injection of `window.orivon` | `ADR-0014`, `src/preload/` | The mechanism `window.ethereum` and its EIP-6963 announcement ride |
| Per-site permission with its own on-disk record, asked at first use, reset from settings | `src/main/sessions/notification-decisions.ts`, `ADR-0028` | The precedent for a **site connection** (origin to account), which is a site permission, not a manifest grant (section 6.2) |
| Consent conventions: a pure decision module, a `-prompt.ts` that shows it with `dialog.showMessageBox`, a `-subsystem.ts` that registers it | `src/main/consent/`, `src/main/README.md` "The organising rule" | The connect, sign and transaction prompts follow it |
| The append point for subsystems, order-dependent on `ctx.broker` | `src/main/subsystems.ts` | The wallet subsystem is appended below `brokerIpcSubsystem` |
| Toolbar popovers as `WebContentsView`s, vanilla-TS renderer pages, a preload global per page | `src/main/permissions/popover-view.ts`, `src/renderer/settings/`, `src/renderer/site-info/` | The wallet popover and the wallet page (section 7) |
| Web3 Score shield with the site's level and mark | `src/renderer/web3-shield.ts`, `ADR-0006`, `ADR-0037` | The auto-connect policy reads the site's level; the connect prompt shows it |
| Routed `fetch` and `WebSocket` for granted hosts | `src/preload/routed/` | Not needed in this step; what a WalletConnect relay or a dApp's own RPC would ride later |
| `window.nostr` adapter built against a stubbed signer, with kind screening | `src/nostr/nip07.ts`, `kind-screening.ts` | The model for a structured, screened signing surface. The wallet's `sign-screening` policy module is its sibling |
| The `#identity` toolbar button, inert, "Identity, not in v0" | `src/renderer/index.html:121`, `open-questions.md` A32 | Becomes the wallet popover's anchor. A32 relabelled it from "wallet" only because a wallet was a non-goal; that reason goes away |
| Prior MVP's wallet UI: create or import a 12-word phrase, password, dashboard with per-chain addresses, toolbar panel | `<prior-mvp>/src/components/WalletPanel.tsx`, `src/store/wallet.ts` | **Visual reference only.** It used ethers v6; here `viem` is already present (Rule 6, one library) |

### 2.2 What the live pages say today, and must stop saying

Every one of these is currently true and becomes false when the wallet lands. Rule 3: rewrite the
page, never append a correction beneath it.

| Page | Current statement |
|---|---|
| `docs/scope.md` OUT table | "Funds-bearing wallet: different security model entirely from per-origin identity" |
| `docs/scope.md` LATER | "wallet Crypto and Address-book layers plus `CapabilityDescriptor`" |
| `docs/scope.md` Explicit non-goals | "**Not a wallet.** No funds, no seed phrase, no send/receive." |
| `docs/scope.md` IN table, new-tab dashboard row | "no Wallet, Network or App-Store tiles" |
| `README.md` | Restates the non-goal (check its Known limitations and non-goals sections) |
| `docs/architecture/capability-api.md`, "Deliberately not in v0" | "`hid` / USB. No wallet app in this version." `hid` stays out; the reason changes |
| `docs/architecture/capability-api.md`, "Two kinds of identity" | Consumer column: "future wallet connect" |
| `docs/planning/compatibility-matrix.md` row "Web ecosystem" | "`window.nostr` (NIP-07); later `window.ethereum`" |
| `docs/planning/build-plan.md` "Not in this plan" | lists "wallet" |
| `docs/open-questions.md` A2 | "(wallet) simplified and deferred, keep architecture ready" |
| `docs/open-questions.md` B4 | "the exact UI language distinguishing throwaway keys / named identities / wallets" is still open. The wallet UI must answer it |
| `ARCHITECTURE.md` "Where things live" | Needs rows for the new directories, each labelled durable or tied to Electron (Rule 5) |

### 2.3 What does not exist

- **A connect prompt.** `orivon.id.requestIdentity` is unbuilt (A111);
  `src/broker/capabilities/id.ts` says so in its header. The wallet needs its own connect
  prompt regardless, because a site connects to an *account*, not to a named identity.
- **secp256k1 signing anywhere.** `derivePublicKey` throws `'internal'` for it (A44). `viem`
  brings it.
- **Any wallet code, storage, UI, or IPC.** Nothing under `src/` mentions a wallet except the
  scope statements above and `LIMITS.secretBytes`'s comment.
- **An inbound shell-to-app channel, a background lifetime and an integration grant tier**,
  the three things an *installed app* would need to act as a provider. They were found missing
  in the integrations exploration of 2026-09-28 (Data Gathering) and are the same three the
  wallet's integration seam will wait on. This step does not build them (section 13).

---

## 3. The shape: three provider layers behind one registry

This is the part of the design that carries the "keep the infrastructure for integrations"
requirement. It follows `src/resolution/` deliberately, because that directory already solved
the same problem for the DNS-resolution and Data-gathering pages of the vision: provider
interfaces as internal TypeScript, a registry that orders them, built-in entries only, and a
one-line statement that opening them to apps is a contracts change.

### 3.1 Principles

1. **A vision App is a provider; a provider is an interface.** `AccountProvider` (layer 1),
   `CryptoModule` (layer 2, one per TAG) and `AddressBookProvider` (layer 3) are TypeScript
   interfaces in a durable directory. This build registers one built-in implementation of each.
   An integration is a later, second implementation of the same interface, driven over a
   message channel.
2. **Plain data across every provider boundary.** Arguments and results are structured-clonable
   (no functions, no class instances, no `Uint8Array` views into shared buffers, `bigint` only
   where a `MessagePort` carries it). This is what lets an out-of-process provider implement
   the interface without the interface changing. `src/resolution/records.ts` makes the same
   choice for the same reason.
3. **The registry orders providers and never knows which one is built in.** Priority, fallback
   and "which module answered" are registry concerns, mirroring the vision's
   `setModulePriority` and `getModules`.
4. **Private key material never crosses a provider boundary.** Layer 2 asks layer 1 to sign;
   layer 3 asks layer 1 for public keys. This is the vision's own claim for layer 3 and the
   repository's T8, applied to every layer. It also decides item 2 of section 1.1.
5. **The durable part imports nothing.** No `electron`, no `node:*`, no other `src/`
   directory. `viem` is the one package the built-in providers need; keep it out of the
   interface files and inside the two modules that do cryptography, so the interfaces stay
   portable to a different signer library or a different engine.

### 3.2 Directories

| Directory | Holds | Tied to Electron? |
|---|---|---|
| `src/wallet/` (new) | The interfaces, the `CapabilityDescriptor` type and its `keyList` matcher, the registry, the TAG constants, the pure policy modules (compatibility matching, connect policy, sign screening, transaction summary), and the built-in providers: `mnemonic-account.ts`, `ethereum/` (the `ETHEREUM_V1` crypto module and its default address book) | **No.** Same status as `src/resolution/`. Its README says what it depends on (`viem` in the two crypto files only) and what it must never import |
| `src/main/wallet/` (new) | The keystore file (sealed entropy, the `SeedStore` pattern), the connections store, the signing log, the three prompts (`connect-prompt.ts`, `sign-prompt.ts`, `transaction-prompt.ts` beside their pure decision files), the wallet subsystem, the popover and page hosts | **Entirely** |
| `src/broker/capabilities/wallet.ts` and its transport dispatch (new) | The page-facing request path: origin from `event.senderFrame` (T3), the per-origin connection check, rate limits, the hand-off to `src/wallet/`'s registry | Partly, like the rest of the broker |
| `src/verifier-host/` (one new request kind) | `eth-rpc`: JSON-RPC to the light client, method allowlisted | Entirely, as today |
| `src/preload/` (new surface) | `window.ethereum` and the EIP-6963 announcement, installed in the main world with the platform descriptor | Entirely |
| `src/renderer/wallet/` (new) | The popover and the page | Entirely |

The page-facing request path enters through the broker's control channel, and the prompts, the
connection store and the network reach the broker as injected dependencies, the way `pickPath`
and `keychain` already do; section 8.1 has the files.

### 3.3 The interfaces, sketched

Sketches, not final code. Names track `standards.mdx` so that a future integration mapping is
mechanical, and `readonly`/`Promise` shapes track `src/resolution/providers.ts`.

```ts
// src/wallet/descriptor.ts -- transcribes orivon-objects.mdx's CapabilityDescriptor
export interface CapabilityDescriptor {
  readonly algorithm: { readonly mode: string, readonly scheme: string, readonly capabilities: readonly string[] }
  readonly key?: { readonly keyList?: readonly string[] }        // "m/44'/60'/0'/0/{0-*}", "slot-{0-1}"
  readonly context?: { readonly chain?: string, readonly network?: string, readonly maxPayloadSize?: number, readonly metadata?: Record<string, unknown> }
}
/** Whether `path` is inside `pattern`'s wildcard grammar: {*}, {a-b}, {a-*}. Pure, tested. */
export function keyListMatches (pattern: string, path: string): boolean

// src/wallet/providers.ts
export type AccountId = string          // opaque, provider-generated, never user-typed (ADR-0010's identityId rule)
export type Tag = string                // 'ETHEREUM_V1' (section 3.4)

export interface AccountSummary { readonly id: AccountId, readonly provider: string, readonly type: string, readonly label: string, readonly createdAt: number }

/** What layer 2 asks layer 1 to do. Carries the full payload AND its type, so a
 *  hardware provider can parse and display it, while a mnemonic provider may hash
 *  it itself. `context` is the descriptor's own context vocabulary. */
export interface SignRequest {
  readonly scheme: 'ecdsa-secp256k1' | 'schnorr-bip340' | 'eddsa-ed25519' | string
  readonly path: string
  readonly payloadType: 'digest' | 'eth-transaction' | 'eth-personal-message' | 'eth-typed-data' | string
  readonly payload: Uint8Array
  readonly context?: { readonly chain?: string, readonly network?: string }
}
export interface Signature { readonly bytes: Uint8Array, readonly recovery?: number }

export interface AccountProvider {
  readonly id: string                                   // 'mnemonic.crypto.orivon'
  accountTypes(): readonly { type: string, descriptors: readonly CapabilityDescriptor[] }[]
  createAccount(type: string, options: Record<string, unknown>): Promise<AccountSummary>
  accountList(): Promise<readonly AccountSummary[]>
  getAccountDescriptor(id: AccountId): Promise<readonly CapabilityDescriptor[]>
  /** Public key at `path`. Never a private key (section 1.1 item 2). */
  accountGetKey(id: AccountId, path: string, scheme: string): Promise<Uint8Array>
  accountOperate(id: AccountId, request: SignRequest): Promise<Signature>
  removeAccount(id: AccountId): Promise<void>
}

export interface Address { readonly tag: Tag, readonly address: string, readonly path: string, readonly source: string /* address-book provider id */ }

export interface AddressBookProvider {
  readonly id: string                                   // 'default.address-book.orivon'
  readonly tags: readonly Tag[]
  /** Derives from public keys only; never sees a SignRequest. */
  addresses(account: AccountSummary, descriptors: readonly CapabilityDescriptor[], tag: Tag, keys: (path: string, scheme: string) => Promise<Uint8Array>): Promise<readonly Address[]>
}

/** Layer 2: one crypto's scheme. Compatibility is decided from descriptors, not from the provider's name. */
export interface CryptoModule {
  readonly tag: Tag
  readonly requires: CapabilityDescriptor                // what an account must offer to serve this TAG
  addressFromKey(publicKey: Uint8Array): string
  /** Builds the bytes to sign for one operation and turns a Signature into what the network accepts. */
  prepare(op: CryptoOperation, from: Address): Promise<{ readonly request: SignRequest, readonly summary: OperationSummary }>
  finish(op: CryptoOperation, request: SignRequest, signature: Signature): Promise<Uint8Array | string>
}

/** The network beneath a TAG (the vision's group.network.*). One per chain id. */
export interface Network {
  readonly tag: Tag
  readonly chainId: string                              // CAIP-2: 'eip155:1'
  /** True when every answer is verified on this machine (the light client); false for a plain RPC. Shown in the UI, never hidden. */
  readonly verified: boolean
  request(method: string, params: readonly unknown[]): Promise<unknown>
}

// src/wallet/registry.ts
export class WalletRegistry {
  constructor (accounts: readonly AccountProvider[], cryptos: readonly CryptoModule[], books: readonly AddressBookProvider[], networks: readonly Network[])
  /** Accounts whose descriptors satisfy `tag`'s `requires`, in priority order. */
  compatibleAccounts(tag: Tag): Promise<readonly AccountSummary[]>
  addresses(account: AccountId, tag: Tag): Promise<readonly Address[]>
  network(chainId: string): Network | undefined
  setPriority(kind: 'account' | 'crypto' | 'address-book' | 'network', id: string, level: number): void
}
```

Two shapes are deliberate and worth a sentence each in the eventual README:

- **`SignRequest` carries the whole payload and its type.** A mnemonic provider hashes
  `eth-transaction` bytes itself with `keccak256`; a hardware provider would forward them to a
  device that insists on seeing the transaction. A `digest`-only interface would fit today's
  one provider and lock out the next one. The `maxPayloadSize` field of the descriptor exists
  for exactly this.
- **`AddressBookProvider.addresses` receives a key-fetching function, not the account.** It can
  derive any address the account's descriptors allow and nothing else; there is no path from
  layer 3 to `accountOperate`.

### 3.4 Identifiers, provisional

- **TAG for Ethereum: `ETHEREUM_V1`**, in the spelling `wallet-system.md` uses, with the
  `standards.mdx` group name (`group.crypto.eth0-1`) noted beside it in the constant's comment
  and the discrepancy filed (section 1.1 item 1). A decision-log row marks it *provisional*;
  what would settle it is the community standard the vision defers to.
- **Provider ids** in the vision's reverse form: `mnemonic.crypto.orivon`,
  `ethereum.crypto.orivon`, `default.address-book.orivon`, `helios.network.orivon`.
- **Chain ids** in CAIP-2 (`eip155:1`) inside the registry; EIP-155 hex (`0x1`) only at the
  `window.ethereum` edge.
- **Account ids and address-book entries** opaque and generated, never derived from a label,
  for the reason `ADR-0010` gives for `identityId`.

### 3.5 How an integration plugs in later, and what it waits on

An installed app that wants to be an account, crypto or address-book provider would implement
one of the interfaces above over a message channel: the registry would hold a proxy that
forwards each call and structured-clones the plain-data result. Nothing in this step should make
that harder, and three things it does not build make it possible:

1. an **inbound channel** from the shell to a running app (today every channel is app to
   shell);
2. a **background lifetime** for an app whose tab is closed
   (`compatibility-matrix.md`, "Background lifetime", unspecified);
3. an **integration grant tier**, distinct from capability grants, held by an installed app.

All three were identified on 2026-09-28 for the Data Gathering integration and are the same
here. Opening the interfaces is then a `src/contracts/` change with its own PR, and, because the
vision's descriptors and ids would become app-facing, an ADR. Until then the interfaces are
internal and may change freely, which is another reason to keep them out of `src/contracts/`
now.

---

## 4. Key custody: the mnemonic account provider

The first, and in this build the only, `AccountProvider`.

### 4.1 The secret is not the identity seed

`docs/scope.md` calls a funds-bearing wallet "a different security model entirely from
per-origin identity", and it is right, for one reason above all: **the identity seed has no
backup and no export** (`ADR-0003`, `ADR-0010`). A key that can hold money must be
recoverable on another machine, or the first lost laptop loses the money. So:

- The wallet's root secret is **BIP-39 entropy** (128 or 256 bits), generated with `viem`'s
  `generateMnemonic(english)` or imported from a phrase the person types.
- It is **person-exportable**: the wallet page can reveal the phrase after a deliberate
  confirmation. It is **never app-exportable**: no `orivon.*` call and no `window.ethereum`
  method returns it or any private key, at any tier. This is a new sentence for
  `capability-api.md`'s "Rules that apply to every app" and an amendment in the same spirit as
  `ADR-0033`'s: the identity seed, never; the wallet phrase, only to the person, in the browser's
  own UI.
- It is **cryptographically unrelated** to the identity seed: not derived from it, not deriving
  it. `ADR-0033` chose a distinct salt to keep two uses of one seed apart; here even the seed is
  separate, because the two secrets have different backup and threat stories.

A **second account type derived from the identity seed** under a new HKDF label would give the
"no setup" account the owner's notes describe, but only once identity export ships
(`ADR-0010`, "What would make us revisit"). Note it as a later account type in the README; do
not build it now.

### 4.2 Sealing and unlocking

Follow `src/main/keyring/seed-store.ts` exactly, for a second file
(`<userData>/wallet/keystore.json`, versioned): entropy encrypted with `safeStorage`'s async
trio, never overwritten when unreadable, the same `'basic_text'`/`'unknown'` backend refusal.
Prefer extracting the sealing logic into one shared helper both stores use over copying it
(code-guidelines Rule 3), if the extraction stays small.

**No password by default.** This is the owner's stated position and matches how the identity
seed already works: the OS keyring is the lock. An optional passphrase (Argon2id or scrypt from
`@noble/hashes`, then AES-GCM) is a later account option, not a first-step requirement; leave a
version byte in the file for it.

**With no real keyring reachable** the identity seed becomes session-only. A funds account must
not do that silently. Recommendation: refuse to *create* an account in that state until the
person has confirmed they wrote the phrase down, and say plainly that the browser cannot keep it
after a restart; *importing* a phrase is fine, since the person already holds it. Owner to
confirm (section 14).

**In memory.** Entropy is decrypted in the main process, held for the session, and zeroed on
lock, on quit and after a configurable idle time. Signing happens in main; the renderer only ever
sees addresses, summaries and signatures. This is the same trust boundary the identity seed has
(T24 names same-user code as out of scope for `safeStorage`).

### 4.3 What the provider derives

- **Descriptors**, per the vision's mnemonic example: `secp256k1`/`ecdsa`, `secp256k1`/`schnorr`
  (BIP-340), `ed25519`/`eddsa`, each with `keyList: ["m/{*}"]`. Only the first is exercised in
  this build; the other two are declared because the entropy genuinely supports them and a
  future Bitcoin or Solana module will read the descriptor, not the provider's name.
- **Keys** with `@scure/bip32`'s `HDKey` (re-exported by `viem/accounts`): `accountGetKey`
  returns the compressed public key at a path; `accountOperate` signs a digest or a typed
  payload with the private key at a path and discards it.
- **Ethereum addresses** through the default address book at `m/44'/60'/0'/0/{i}`; the first
  address is the account's active one, more on request from the wallet page.

### 4.4 Other account types, named so the seam stays visible

Hardware wallets need `hid`, excluded from this build for every tier
(`compatibility-matrix.md` row "hid / USB"); the descriptor and `SignRequest` shapes above are
what they would implement. A watch-only provider (an address with no keys, `accountOperate`
always `'denied'`) is cheap, useful for the address-book layer, and a good second provider to
prove the registry with in tests. Smart accounts and multisig are layer-1 types the vision
names; nothing here blocks them.

---

## 5. The chain layer for Ethereum

### 5.1 Reads verified by the light client, writes forwarded

The shell starts Helios in every install, confined to the verifier host and reaching only
allowlisted RPCs (`ADR-0031`). Its provider answers the whole read set a wallet needs with
state proofs, and forwards `eth_sendRawTransaction`. Using it gives the wallet, and every dApp
behind `window.ethereum`, **Connection Level 2** by construction: the RPC supplies availability,
never correctness. No other browser wallet does this by default. It costs no new dependency and
no new process.

Mechanism:

- A new `HostRequest` kind, `{ kind: 'eth-rpc', method, params }`, in
  `src/verifier-host/protocol.ts`, served by `service.ts` from the existing `LightClient.provider`
  through a **method allowlist** (the read set, `eth_estimateGas`, the fee methods,
  `eth_sendRawTransaction`, `eth_getTransactionReceipt`, `eth_chainId`). Anything else is
  refused in the host, not in main.
- `src/main/wallet/helios-network.ts` implements `Network` (`verified: true`,
  `chainId: 'eip155:1'`) over `supervisor.request(..., deadline)`.
- **Failure modes are surfaced, never hidden.** `not-synced` maps to EIP-1193 error `4900`
  (disconnected) on the page, the wallet UI says "verifying the chain, wait", and a timeout is a
  timeout. A light client that is off (`lightClientOff`) means the wallet has no mainnet network,
  and says so.
- **A broadcast is sent once.** The host's execution-RPC failover retries a request on any
  JSON-RPC error, which would hand a signed transaction to every endpoint in turn. The `eth-rpc`
  handler sends `eth_sendRawTransaction` to one endpoint, once, and reads "already known" after
  a send as success (section 8.1, item 6).

### 5.2 Mainnet only, in this build

`wallet_switchEthereumChain` to any other chain returns EIP-3326's `4902` ("unrecognised
chain"); `wallet_addEthereumChain` is refused with `4200`. Record it as a decision-log row with
the reason: a second chain is either another light-client instance (Helios supports OP Stack and
Linea kinds, at 150 to 200 MB resident each) or a plain RPC, which is Connection Level 1 and
would need its own visible label. Add a chain when a real app needs it (Rule 4). The `Network`
interface's `verified` flag exists so that a plain-RPC network can be added honestly.

### 5.3 A risk to measure, not assume

Proof-verified `eth_call` and `eth_getLogs` are slower than a plain RPC, and busy dApps issue
many. Route everything through Helios first and measure against one real dApp (section 9 names
candidates). If a method proves unusable, the fallback policy must be explicit per method and
shown in the UI, never a silent downgrade of the verification the shield promises. This is the
same rule ADR-0017 applies to a divergence in a platform API.

---

## 6. The app-facing surface

### 6.1 `window.ethereum` with EIP-6963, in every top-level frame

The consumers that exist today are ordinary web dApps (compatibility tier 1). They probe
`window.ethereum` and, increasingly, listen for EIP-6963's `eip6963:announceProvider`. Serving
both is what makes Uniswap-class frontends and `.eth` dApps work with no manifest.

- **Where.** Installed by the preload into the main world of every tab's top-level frame,
  ordinary tabs and app tabs alike, the way `capability-api.md` already describes `window.nostr`
  ("injected in ordinary tabs"). Subframes get no preload and therefore no provider (T18);
  iframe-embedded dApps are out of scope and the README says so.
- **How.** The same serialised-function mechanism as `window.orivon`
  (`ADR-0014`), but with `writable: true, configurable: true` because `ethereum` is a borrowed
  name (`ADR-0021`); `check:page-globals` will fail the build otherwise. The object is a thin
  proxy: `request({ method, params })` posts to the isolated world over a `contextBridge`
  closure and from there to the broker; `on`/`removeListener` implement the EIP-1193 events
  `connect`, `disconnect`, `chainChanged`, `accountsChanged` from pushes the broker sends. No
  `isMetaMask`, no other wallet's flag: EIP-6963 exists so a wallet need not lie about its
  name. If a needed dApp turns out to require the flag, file it, do not add it.
- **Events.** The broker has no push channel to a page. `wallet.awaitEvent`, a long-poll the
  preload re-issues in the pattern of `web.awaitClose`, delivers `connect`, `disconnect`,
  `chainChanged` and `accountsChanged` to the main-world provider (section 8.1, item 4).
- **EIP-6963.** Dispatch `eip6963:announceProvider` on install and again on every
  `eip6963:requestProvider`, with `info: { uuid, name: 'Orivon', icon (data: SVG), rdns }`.
  The `rdns` value is the owner's call (a reverse of the docs domain is the obvious candidate).
- **Methods, phase 1:** `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `net_version`,
  `wallet_getPermissions`, `wallet_requestPermissions`, `wallet_revokePermissions` (EIP-2255),
  `wallet_switchEthereumChain` (EIP-3326, `4902` for anything but mainnet), `personal_sign`
  (EIP-191), `eth_signTypedData_v4` (EIP-712), `eth_sendTransaction` (prompt, sign locally with
  `viem`, broadcast through the `Network`), and a pass-through of the read allowlist to the
  `Network`. **Refused with `4200`:** `eth_sign` (a raw-hash oracle, the wallet analogue of the
  raw-bytes signing `handle-contracts.md` forbids), `eth_signTransaction` (returns signed bytes to
  the page; add only if an app needs it), `wallet_addEthereumChain`, `wallet_watchAsset`,
  `eth_subscribe`. **Error codes** as EIP-1193 and EIP-1474 give them: `4001` when the person
  declines, `4100` when the origin is not connected, `4200` unsupported, `4900` disconnected,
  `-32601` unknown method, `-32602` bad params.
- **Nonce, gas and chain id** are the wallet's business, not the page's: `eth_sendTransaction`
  takes the page's `to`, `value`, `data` and optional gas fields, fills the rest from the
  `Network`, signs with EIP-155 replay protection, and rejects a `chainId` that is not the
  connected one.

### 6.2 A site connection is a site permission, not a manifest grant

A dApp has no manifest, so its connection cannot be a `Grant`; and even if it could, grant
hydration drops any grant with no registered manifest at restart, and holding one moves an origin
into its own partition (`ADR-0018`), stranding a site's storage (section 8.2). Model it on the
notification decision (`ADR-0028`): a per-origin record `{ origin, accounts: AccountId[], chainId,
connectedAt }` in `src/main/wallet/connections.ts`, asked for at the first `eth_requestAccounts`,
shown in the site-info popover as its own row with a switch, listed in the all-sites settings
panel, and cleared by `wallet_revokePermissions` from the page or by the person from either
panel. Removing an account disconnects every site that held it and emits `accountsChanged`.

This keeps `src/contracts/` untouched in this step. It is also the honest model: what the
person is deciding is "this site may see and ask this account to sign", which is what the connect
prompt says.

**The Web3 Score hook.** `src/wallet/policy/connect-policy.ts` is a pure function
`connectDecision({ siteLevel, autoConnectSetting, existingConnection }) -> 'silent' | 'prompt' |
'refuse'`. In this step it returns `'prompt'` for any origin with no connection and `'silent'`
for one that has, and it carries the one extra branch the vision asks for: `'silent'` for a new
origin **only when the setting is on and the site is Level 4**. The setting ships **off**, and
the prompt always shows the site's level and mark beside the origin. Provisional; the owner
confirms both the default and the level (section 14).

### 6.3 `orivon.wallet` in `src/contracts/`: not in this step

An Orivon-native app or a port will eventually want a chain-agnostic, TAG-keyed wallet API
rather than an Ethereum-shaped one, and the vision's "sites declare which TAGs they need" points
the same way. That is a `src/contracts/` addition (a `wallet` capability kind, a manifest field
for TAGs, an `OrivonWallet` namespace whose methods mirror the registry's), which by the owner's
policy is its own PR, merged first, and by Rule 4 waits for the app that needs it. What this
step does to keep it cheap: the broker's internal wallet API is already TAG-keyed and takes the
plain-data shapes of section 3.3, so `window.ethereum` is one adapter over it and
`orivon.wallet` would be a second. Write the sketch of `OrivonWallet` in the README as an idea,
not in `capability-api.ts`.

### 6.4 The prompts

Three, following the `consent/` convention (a pure module that decides and words it, a
`-prompt.ts` that shows it). Start with native dialogs in the window-attached, gesture-gated
style the external-link and notification prompts use (section 8.1, item 7), never the parentless
box `app.requestGrant` shows; move to a `WebContentsView` sheet when the readability check says
a typed-data message is illegible in a native one. Each prompt:

| Prompt | Must show | Decision it records |
|---|---|---|
| **Connect** | The **origin first and largest** (the grant prompt's rule; the site chooses its own name), the site's Web3 Score level and mark, which account (the active one, with a way to pick another), what connecting allows (see addresses, ask to sign; never spend without a further prompt) | The connection record |
| **Sign message** | Origin, account, the message decoded as UTF-8 when it is valid text, otherwise hex; for typed data the `domain` (name, `chainId`, `verifyingContract`), the `primaryType` and the fields as a tree; a Sign-in-with-Ethereum message (EIP-4361) parsed into its fields when it parses | One line in the signing log |
| **Send transaction** | Origin, account and its balance, `to` (with an ENS reverse name if the light client can resolve one), `value` in ETH, the fee estimate, `data`'s size and, when the selector is a known ERC-20 `transfer`/`approve`, the decoded amount and spender, with an unlimited `approve` called out; the chain | One line in the signing log |

**Sign screening** (`src/wallet/policy/sign-screening.ts`, tested first, TDD): the sibling of
`src/nostr/kind-screening.ts`. In this build every signature and every transaction prompts;
the module exists so that the rule is one tested table rather than scattered `if`s, and so
that a future "silent for this site" setting has one place to live. Like its sibling, it is a
hint for the UI and **not the enforcement boundary**; the broker prompts regardless.

**The signing log.** `security-model.md` T8b names "a local append-only signing log (origin,
identity, kind, time) with a viewer" as the missing repudiation control for named identities.
Build it for the wallet from day one (`<userData>/wallet/signing-log.jsonl`: time, origin,
account, method, hash or transaction hash, outcome) and show it on the wallet page. It is
cheap, and the first dispute over "I never signed that" is not the moment to wish for it.

---

## 7. Browser UI

Vanilla TypeScript pages, as everything in `src/renderer/` is; no framework.

- **The popover**, anchored on the toolbar's `#identity` button (rename its id and tooltip to
  the wallet): the active account's label and address (copy on click), its mainnet balance from
  the `Network` with the connection's verification shown, the sites connected to it, and "Open
  wallet". Hosted through `popover-view.ts` like the two existing popovers. Its preload exposes
  `orivonWallet`, added to `ORIVON_OWN_GLOBALS` in `scripts/check-page-globals.mjs`.
- **The wallet page**, an internal page like settings: create an account (show the phrase,
  require the person to confirm they saved it), import a phrase, back up (reveal, behind a
  confirmation), rename, remove (with the disconnect consequence stated), the address book per
  TAG with more addresses on request, connections with revoke, the signing log, and the
  auto-connect setting with its Level-4 condition explained. The first-run experience is
  **nothing**: no wallet exists until a site asks or the person opens the page. That is the
  owner's "no setup" position applied to funds: the person is not asked to set up money they
  have not decided to hold.
- **The new-tab dashboard** gains a Wallet tile that opens the page (the `scope.md` dashboard
  row changes accordingly; the pluggable widget platform stays out).
- **UI language**, the open half of B4: three words for three things, used consistently in
  every surface: *app key* (never shown), *identity* (the named, Nostr-shaped thing, when it
  ships), *account* (a wallet account that can hold funds). The word "wallet" names the feature
  and the page, never an individual key.
- **Visual reference:** the prior MVP's `WalletPanel` and dashboard, for look only.

---

## 8. The code path, and where each wallet piece goes

This section was built from a trace of `orivon.secrets` (`ADR-0033`), the most recent capability
added through every layer, whose whole diff git still holds. Line numbers drift; the file names
are what matter.

### 8.1 The path a manifest-declared capability follows

Recorded for completeness and because `orivon.wallet` will follow it one day (section 6.3).
**This step skips the first half**: a site connection is not a `CapabilityKind`, so nothing in
`src/contracts/`, the loader's manifest parser, `scripts/check-manifest-parity.mjs`,
`policy/manifest-patterns.ts`, `policy/request-grant.ts`'s `CAPABILITY_KINDS`, the grant ledger,
`consent/grant-prompt-render.ts` or `renderer/grant-icons.ts` changes. The exhaustive `never`
guards in the last two are what would force a new kind through every surface; leave them alone.

The second half is the wallet's path:

1. **Broker types.** A new `src/broker/wallet-contracts.ts` (`Broker.wallet`, the plain-data
   request and event shapes), re-exported from `broker-contracts.ts`, which sits at 478 lines
   and must not grow. New `CreateBrokerOptions` dependencies for the prompt host, the connection
   store and the network, in the shape `pickPath`, `keychain` and `webContextHost` already take:
   the broker asks the person through an injected dependency, never by importing a dialog.
2. **Capability.** `src/broker/capabilities/wallet.ts`: origin-keyed like `secrets.ts`,
   `requireConnection(origin, account)` instead of `requireGrant`, a denial that never says why,
   then the hand-off to `src/wallet/`'s registry. Wired in `src/broker/index.ts` (477 lines;
   split before adding).
3. **Transport.** `transport/ipc-validation.ts`: two new `ControlMethod` strings on the one
   `orivon:control` channel (`src/main/channels.ts` holds channel names, not
   `src/contracts/ipc.ts`): `wallet.request` (an EIP-1193 request envelope) and
   `wallet.awaitEvent` (below). Validators for both. `transport/dispatch/wallet.ts` with its own
   exhaustive guard, a case in `transport/ipc.ts`'s `dispatch` switch, and the real dependencies
   in `brokerIpcSubsystem`. The origin comes from `event.senderFrame` and nowhere else (T3);
   the rate limiter already applies.
4. **Events.** There is no push channel for control-plane events. The precedent is
   `web.awaitClose` (`src/preload/surface/web.ts`): a long-poll the preload re-issues, resolved
   by the broker when something happens. `wallet.awaitEvent` returns the next of `connect`,
   `disconnect`, `chainChanged`, `accountsChanged` for that origin; the main-world provider
   re-emits it. A dedicated push channel is the alternative; take it only if the long-poll
   proves visibly laggy, and say why in the README.
5. **Preload.** A serialised installer `src/preload/expose-ethereum.ts`, called from
   `src/preload/app.ts` inside try/catch, that builds the provider in the main world over bridge
   closures exactly as `installOrivon` does, with `writable: true, configurable: true` on the
   `ethereum` property and the EIP-6963 announce inside the same function (it may reference
   nothing outside its own body). A `TIMEOUT_MS.wallet` in `surface/control-call.ts` of the
   `grant` size (120 s: a person is deciding). `main-world-socket.ts` is at 476 lines and
   `window.orivon` is frozen at install, so nothing wallet-shaped is attached to it.
6. **Verifier host.** `protocol.ts`: `{ kind: 'eth-rpc', method, params }` and its reply;
   `service.ts`: the allowlist and the call on `LightClient.provider`;
   `src/main/verifier/host-supervisor.ts`: `request()`'s default deadline is 5 s, so the network
   passes its own per method. **Broadcast is special**: `rpc-failover.ts` re-sends a request to
   the next RPC on any JSON-RPC error, which for `eth_sendRawTransaction` means every endpoint
   receives the signed transaction and the second one answers "already known" as an error. The
   host must send a raw transaction once, to one endpoint, treat "already known" or "nonce too
   low" after a send as terminal, and return the hash it got. Test this first.
7. **Main.** `src/main/wallet/`: `keystore.ts` (pure, `SafeStorageLike` injected) and
   `electron-keystore.ts`; `connections.ts` (per-origin decisions on disk, the
   `notification-decisions.ts` pattern); `signing-log.ts`; `connect.ts`, `sign.ts`,
   `transaction.ts` as pure decision-and-wording modules with `connect-prompt.ts`,
   `sign-prompt.ts`, `transaction-prompt.ts` beside them; `helios-network.ts`;
   `wallet-subsystem.ts`, appended to `src/main/subsystems.ts` **below** `brokerIpcSubsystem`
   and `verifierSubsystem`. Prompts use the **window-attached, gesture-gated** style of the
   external-link and notification prompts (`src/main/shell/notification-prompt.ts`,
   `src/main/shell/showing-window.ts`, `src/main/sessions/tab-prompts.ts`: one question per
   tab, a real gesture before re-asking), not `request-grant-prompt.ts`'s parentless box. One
   catch the trace found: a control dispatcher receives only `senderFrame`, so mapping a request
   to its tab's window needs a small resolver from frame to tab. Build it once; the identity
   connect prompt (A111) will want the same one.
8. **The site's level in the prompt.** The consent code sees only the dev override today;
   `SiteInfoController.siteTrustFor` computes the real `displayedLevel` and is not published on
   `SubsystemContext`. Publish a `trustLevelFor(origin)` (or pass the controller) so the connect
   prompt and `connect-policy.ts` read the level the shield shows. A provider's judged Level 4
   shows on the shield but never removes a warning (`ADR-0054`), so anything the connect prompt
   relaxes at Level 4 must read the developer override alone, as the grant prompts do; for a real
   site that branch stays dormant. Say so in the README rather than pretending it is exercised.
9. **Browser UI.** `src/main/channels.ts` (`WALLET_COMMAND_CHANNEL`), `src/main/ipc/wallet-ipc.ts`
   with the sender check `settings-ipc.ts` performs, `src/preload/wallet.ts` exposing
   `orivonWallet`, `src/renderer/wallet/`, the `#identity` button in `src/renderer/index.html`
   and its handler in `src/renderer/main.ts`, the popover host through
   `src/main/permissions/popover-view.ts`. Site-info row: `site-info-controller.ts`,
   `site-switches.ts`, `src/renderer/site-info/main-view.ts`. All-sites list:
   `src/main/permissions/permissions.ts`, `src/preload/settings.ts`, `src/main/ipc/settings-ipc.ts`,
   `src/renderer/settings/permissions-view.ts`, following the site-notification rows, which are
   not `CapabilityKind`s either.
10. **Guards.** `orivonWallet` into `ORIVON_OWN_GLOBALS` in `scripts/check-page-globals.mjs`. The
    installer lives in `src/preload/`, which the guard scans; anything that installs a page
    global from another directory must be added to `SCANNED_DIRECTORIES` or it is unguarded.
    `check:size` (500 lines), `check:comments` (25 leading comment lines, no PR or finding ids),
    `check:natives`, `check:advisories` after the dependency change.
11. **Tests.** Fakes to extend: `src/broker/transport/tests/stub-broker.ts`,
    `src/preload/surface/tests/main-world-socket.test-helpers.ts`,
    `src/broker/transport/dispatch/tests/exhaustiveness.test.ts`. The e2e model is
    `test/e2e-id-capability.test.ts`. Section 11 has the plan.
12. **Pages.** The READMEs of every directory touched (`src/preload/surface/README.md` has an
    "update this bullet in the same PR" rule), `ARCHITECTURE.md`'s table, `CHANGELOG.md`,
    `docs/planning/compatibility-matrix.md`, and section 12's list.

### 8.2 Constraints the trace turned up

- **Files with almost no headroom**: `broker-contracts.ts` 478, `broker/index.ts` 477,
  `main-world-socket.ts` 476, `consent/grant-prompt-render.ts` 470, `contracts/ipc.ts` 498.
  New wallet code goes in new files; a split of an existing one is its own commit.
- **A manifest-less site cannot hold a grant.** Grant hydration re-validates each persisted
  grant against a registered manifest, so a dApp's grant would vanish at restart; and holding any
  grant moves an origin into its own partition (`ADR-0018`), stranding the site's storage in the
  default session. This is why section 6.2 is a site permission, not a grant.
- **`src/contracts/` may import nothing, not even a `viem` type** (`check:contracts`). When
  `orivon.wallet` comes, its types are written by hand.
- **The hookify rule `.claude/hookify.scope-creep.local.md` warns on the word "wallet"** in any
  `src/**/*.ts|json`. Expect the warning; once the owner has changed scope, the rule should
  change too (it is the owner's local file).
- **Two doc/code mismatches found on the way**, neither the wallet's: `ADR-0033` is marked
  *proposed* but is implemented; `ADR-0003`'s table says the grant ledger is encrypted with
  `safeStorage`, and `grants.json` is plain JSON. Each earns an open-questions row.

---

## 9. What the ported apps need, and what the need for this step actually is

`orivon-ports` was surveyed with `node_modules` excluded. The result is unambiguous and the
implementer should not soften it: **no ported app calls `window.ethereum`, EIP-1193, EIP-6963,
WalletConnect, `window.keplr`, `window.xfi` or `window.solana`.** The two apps that are wallets,
ASGARDEX (`@xchainjs/*`, ethers, twenty chains) and AirGap Vault (`bip39`, `@airgap/*`, a QR
signer for MetaMask and Rabby), generate and hold their own phrases inside the page, and both
ports ship whole on that path. What the ports lack in this area is, in their own words:

| Need | Who | Status here |
|---|---|---|
| Hardware-wallet device access (`hid`, then WebUSB) | ASGARDEX's six refused Ledger members; `docs/port-candidates.md` calls it "the one open question" for the device-shaped wallets | Excluded from this build for every tier; the permission gate denies all device permissions. Unchanged by this step |
| An app-facing secret store backed by the OS keyring | Element's hand-off item 1, The Lounge's recon | **Built**: `orivon.secrets`, `ADR-0033`. The port READMEs predate it |
| Camera and clipboard-read, AirGap Vault's only two ways to receive a request to sign | AirGap Vault | Declared by `ADR-0032`; whether the port adopts it is a ports question |

So, under CLAUDE.md Rule 4 ("name the need before building"), the need for the wallet is **not a
port**. It is three things, and the plan should say them in this order:

1. **The owner's product decision** to build the vision's wallet system now.
2. **Ordinary web dApps**, compatibility tier 1, which the ports repository excludes by
   construction ("web-only, so there is no renderer target to keep") and which are exactly the
   consumers a browser's `window.ethereum` exists for. A `.eth` dApp loaded through the light
   client with a wallet that reads through the same light client is the journey the shield was
   built to grade.
3. **The success metric**: daily-driver use of a Web3 browser includes the sites people already
   use, and those sites expect a wallet.

Two things from the survey are worth adopting:

- **ASGARDEX's three EVM derivation templates**, `legacy` (`m/44'/60'/0'/{i}`), `ledgerlive`
  (`m/44'/60'/{i}'/0/0`) and `metamask` (`m/44'/60'/0'/0/{i}`, the BIP-44 default). They are
  three address books over one account in the vision's terms. Ship `metamask` as the default
  book and make the other two selectable in the wallet page; it costs a path template each and
  it is what a person importing a phrase from another wallet needs to find their funds.
- **AirGap Vault's QR flow** (Keystone UR `eth-sign-request`, already spoken for MetaMask and
  Rabby) is the natural second `AccountProvider`: an air-gapped signer that opens a GUI at the
  moment of an operation, which is the layer-1 behaviour the vision page describes. Not in this
  step; the `SignRequest` shape that carries the full payload is what it would consume.

Unverified candidates from the ports backlog that would use an injected provider: Remix Desktop,
Rotki, Audius. The first real consumer to test against should be a live mainnet dApp in
read-only use (the ENS manager, a Uniswap frontend) plus the fixture dApp of section 11.

If the owner wanted the single wallet-adjacent feature that unblocks the most apps in the ports
repository, the survey's answer is `hid`, not this. That is stated once here for the record and
is not what this document plans.

---

## 10. Security model additions

Rows for `docs/architecture/security-model.md` (numbers assigned when written; T33 is the last
today), each with the mitigation this design already carries:

| Threat | Mitigation |
|---|---|
| A page, an app or same-user code reads the wallet phrase | The phrase is decrypted only in the main process, zeroed on lock, quit and idle; no `orivon.*` or `window.ethereum` method returns key material; `safeStorage` seals it at rest; T24's limit (same-user code) applies exactly as it does to the identity seed and is stated |
| Blind signing: a dApp asks for a signature whose meaning the person cannot see | `eth_sign` refused; `personal_sign` shown decoded; typed data shown as domain, `verifyingContract`, primary type and fields; ERC-20 `approve` decoded with an unlimited allowance called out; every signature prompts in this build (`sign-screening.ts` is a hint, the broker prompts regardless) |
| Prompt fatigue and prompt spoofing | Window-attached, gesture-gated prompts, one per tab, origin first and largest, the site's own name never in the title; a refused prompt is `4001`, and the site cannot re-prompt without a fresh gesture |
| A compromised renderer forges a request as another origin | Origin from `event.senderFrame` only (T3); the connection store is keyed by that origin |
| A connected site follows the person across origins | Connections are per origin; a navigation to another origin has no accounts (`eth_accounts` is `[]`) and `ADR-0018` already swaps the session; `wallet_revokePermissions` and both panels disconnect |
| A signed transaction is broadcast more than once, or to more RPCs than intended | `eth_sendRawTransaction` bypasses the failover's retry; sent once; "already known" after a send is success; EIP-155 chain id and a nonce read from the `Network` |
| Fingerprinting through `window.ethereum` and the EIP-6963 announce | Presence is detectable, as it is for every wallet (the T16 analogue); accounts and signatures sit behind the connect prompt; the announce names Orivon, which is a deliberate trade the owner should confirm (section 14) |
| A read answered by an unverified source is shown as verified | The `Network` carries `verified`; the popover and prompts show it; there is no silent per-method fallback (section 5.3) |
| The wallet page's privileged preload is reached by a page | Its own channel with the sender check `settings-ipc.ts` performs; the popover and page are Orivon-owned pages in their own views |
| A funds account on a machine with no real keyring silently vanishes at restart | Creation refused until the person confirms the phrase is saved; `available`-style state shown on the page; import allowed |
| "I never signed that" | The append-only signing log with a viewer, T8b's missing repudiation control, built for the wallet from the first signature |

---

## 11. Verification plan

- **Unit, test-first for every policy module** (the `superpowers` rule for broker and policy
  functions): `keyListMatches`, descriptor compatibility, `connect-policy`, `sign-screening`, the
  transaction summary (including ERC-20 decoding), the keystore file (a real temp directory and a
  fake `SafeStorageLike`, as `seed-store.test.ts` does), the connections store, the signing log.
- **Provider vectors.** The mnemonic provider against BIP-39 and BIP-44 test vectors (the
  well-known development phrase and its `m/44'/60'/0'/0/0` address); EIP-191 and EIP-712
  signatures compared with `viem`'s own reference functions; a serialised EIP-1559 transaction
  compared byte for byte. Consider a `wallet-vectors.json` checked by `scripts/check-vectors.mjs`
  the way `derive-vectors.json` and `secrets-vectors.json` are, since an address derivation that
  drifts loses money as silently as a KDF that drifts loses an identity.
- **Broker and transport.** `capabilities/wallet.ts` with stub dependencies (a fake prompt host
  that records what it was asked and answers as the test says, a fake `Network`); the dispatcher
  exhaustiveness test; the `eth-rpc` host handler's single-send rule.
- **End to end.** A fixture dApp under `test/apps/` (a page that calls `eth_requestAccounts`,
  `personal_sign`, `eth_signTypedData_v4` and `eth_sendTransaction` and displays the results),
  driven by the Electron suite with a fake `Network` behind the same kind of test seam the
  verifier uses for fixture names, compiled out of an ordinary build and covered by
  `check:dev-grant-absent`'s logic or a sibling guard. How the suite answers native prompts is
  the first thing to check in `test/e2e-id-capability.test.ts` and the dev-grant path; a
  dev-only auto-approve seam for wallet prompts needs the same compile-out guarantee. Clipboard
  round trips hang under `xvfb`: test the copy button's promise outcome, not the clipboard.
- **Live, opt-in.** A read-only test against mainnet through Helios (`eth_getBalance`,
  `eth_call`) in the style of `live-ens.test.ts`. Never a live send in CI.
- **The usual gates**: `npm run typecheck`, `npm test`, every `check:*`, `npm run smoke`,
  `npm run test:e2e`, all through `scripts/run-headless.mjs` where Electron is involved.
- **Reviews.** `/security-review` and `/code-review` per commit on the broker and keystore path;
  `adversarial-reviewer` on `capabilities/wallet.ts`, the keystore and the prompts after the
  step lands; every `security-guidance` finding addressed or acknowledged.
- **The readability check.** The document to hand the owner is the connect prompt's text and
  the wallet page's first screen, cold: "where did you first get lost?" Log the answer in
  `docs/development/readability-log.md` either way.

---

## 12. Records and pages this step must produce

**ADRs** (`docs/decisions/ADR-0000-template.md`; the next free number was 0038 at the time of
writing, and two branches can take the same number, so check `main` before merging):

1. *The wallet system is three provider layers behind one registry.* Architecture. The
   interfaces, plain-data rule, registry, built-in-only status, and the sentence that opening
   them to apps is a `src/contracts/` change that waits on the inbound channel, the background
   lifetime and the integration grant tier. Reversibility: cheap while internal.
2. *A wallet account's phrase is a separate, keyring-sealed, person-exportable secret.*
   Security. Not the identity seed, not derivable from it, never app-exportable, no password by
   default, the no-keyring rule, the in-memory rule, and the direct dependency on the audited
   pure-JS curve and BIP libraries `ADR-0010` deferred to "the stream that first needs
   secp256k1". Amends the scope of `ADR-0003`'s export sentence (the identity seed, still never;
   the wallet phrase, to the person only). Reversibility: expensive once an account holds funds.
3. *`window.ethereum` is served to every top-level frame, a site connection is a per-site
   permission, and Ethereum reads go through the light client.* Architecture and security. Why
   not a grant (section 8.2), why every signature prompts, why mainnet only, why no other
   wallet's flag. Reversibility: moderate; dApps written against the promise are not under this
   project's control.

**Decision-log rows** (`docs/decisions/decision-log.md`, next `d-` id at the tail): TAG
`ETHEREUM_V1` provisional; mainnet only; auto-connect off by default and Level 4 only; no
`isMetaMask`; `eth_sign` refused; prompts native first; the three words (app key, identity,
account); the default and selectable derivation books; the EIP-6963 `rdns` and name.

**`docs/open-questions.md` appends**: section 1.1's five items; the two mismatches in section
8.2; and one on how the identity connect prompt (A111) shares the wallet's prompt host.

**Pages to rewrite** so they state only what is then true (Rule 2 and 3): every row of section
2.2; `ARCHITECTURE.md`'s "Where things live" (rows for `src/wallet/`, durable, and
`src/main/wallet/`, tied to Electron) and its capability-call diagram if the host request is
drawn; `docs/architecture/security-model.md` (section 10 and the T8b sentence); the
"Rules that apply to every app" list in `capability-api.md`; `docs/glossary.md` (account,
address book, TAG, connection, crypto module); `docs/planning/compatibility-matrix.md` (the
"Web ecosystem" row and a wallet row; the `hid` rows unchanged); `CHANGELOG.md`; each touched
directory's `README.md`; the ports' `docs/port-candidates.md` note about a system-wide provider,
if the owner wants the two repositories to agree; a `devlog/journal.md` bullet under Done when it
lands.

---

## 13. Suggested build order

For `writing-plans`. One or two PRs per working day (CLAUDE.md, "Before opening a PR"); no
`src/contracts/` change is expected in this step, and if one turns out to be needed (a new
`OrivonErrorCode`, say) it goes first in its own PR. Sizes are relative, not hours; record hours
as `scope.md` asks.

| Phase | What | Merges alone? | Size |
|---|---|---|---|
| 0 | Scope change: rewrite section 2.2's pages, the three ADRs as *proposed*, decision-log rows, open-questions appends, the hookify rule | Yes, docs only | S |
| 1 | `src/wallet/`: interfaces, descriptor and matcher, registry, mnemonic provider, `ETHEREUM_V1` module, default and alternative address books, the policy modules, vectors, README. No Electron, fully unit-tested, touches nothing else | Yes | M |
| 2a | `src/main/wallet/` keystore, connections, signing log, prompts and subsystem; the verifier host's `eth-rpc` with the single-send rule; `helios-network.ts`; the broker capability, transport methods and injected dependencies | With 2b, or alone if `window.ethereum` is behind the next PR | L |
| 2b | The preload installer with EIP-6963 and the event long-poll; the site-info row and the all-sites list; the fixture dApp and the e2e test | Yes | M |
| 3 | The popover, the wallet page, the new-tab tile, the identity button's rename; `orivonWallet` in the guard | Yes | M |
| 4 | Adversarial and security reviews, the readability check, `compatibility-matrix.md`, `CHANGELOG.md`, the ADRs to *accepted*, the devlog bullet | Yes | S |

Before phase 2: `context7` for Electron's `dialog`, `utilityProcess` and `MessagePortMain`
signatures (training data is stale for Electron 44), and the `orivon-electron` skill. Before any
comment in `src/`: the `orivon-comments` skill.

---

## 14. Decisions for the owner

Each has a recommendation; the plan proceeds on it unless the owner says otherwise.

1. **The scope change itself.** Move the wallet from OUT to IN. *This is the trigger for
   everything else.*
2. **No password by default; the OS keyring seals the phrase.** Recommended: yes, matching the
   identity seed and the owner's own notes; an optional passphrase later.
3. **No reachable keyring: refuse to create, allow import, until the phrase is confirmed
   saved.** Recommended: yes.
4. **The person can reveal the phrase in the wallet page.** Recommended: yes; a funds key with
   no backup is a lost-laptop away from lost money.
5. **Auto-connect: off by default, Level 4 only, dormant until a score provider exists.**
   Recommended: yes.
6. **Mainnet only through the light client; other chains answer `4902`.** Recommended: yes.
7. **`ETHEREUM_V1` as the provisional TAG.** Recommended: yes, with the discrepancy filed.
8. **`accountGetKey` returns public keys only.** Recommended: yes.
9. **The EIP-6963 name and `rdns`, and the announce naming Orivon.** Owner's call.
10. **Prompts as native message boxes first.** Recommended: yes; revisit at the readability
    check.
11. **Every signature and transaction prompts in this build.** Recommended: yes.
12. **Direct, pinned dependencies on the BIP and curve libraries `viem` already brings** rather
    than importing transitive packages. Recommended: yes, in ADR 2.
13. **The prompt host is built once so `requestIdentity`'s connect prompt (A111) can reuse it.**
    Recommended: yes for the host, no for building Nostr's prompt in this step.
14. **Reset the identity button's tooltip and the hookify scope rule.** Recommended: yes.

---

## 15. Out of scope for this step, with the seam each one plugs into

| Later | Plugs into |
|---|---|
| Hardware wallets (Ledger, Trezor, Keystone over USB) | `hid` (its own contracts, prompt and ADR) plus an `AccountProvider` whose `accountOperate` forwards the full `SignRequest` payload |
| An air-gapped QR signer (AirGap Vault, Keystone UR) | An `AccountProvider` with a camera GUI at operation time; `ADR-0032`'s camera grant |
| WalletConnect | A second app-facing adapter over the same broker API; the routed `WebSocket` for the relay; a pairing UI |
| Other EVM chains, L2s, testnets | A `Network` per CAIP-2 id; Helios's OP Stack and Linea kinds, or a plain RPC marked `verified: false` |
| Bitcoin, Monero, Solana and any non-EVM TAG | A `CryptoModule` per TAG whose `requires` descriptor selects compatible accounts; the mnemonic provider already declares the schemes |
| Installed apps as providers ("integrations") | The inbound shell-to-app channel, the background lifetime, the integration grant tier; then a `src/contracts/` PR opening the interfaces |
| `orivon.wallet` and a manifest field for TAGs | A `src/contracts/` PR, merged first, transcribing the registry's shapes by hand |
| Smart accounts, multisig, Safe address lists | Layer-1 types and layer-3 books the vision names; nothing here blocks them |
| Transaction simulation, local analysis of a contract call, ZK connection proofs (the owner's use-case notes) | The `OperationSummary` the transaction prompt renders is the hook |
| Token balances, price feeds, token lists | `CryptoModule` extensions; no third-party price API by default, for the privacy reason the DuckDuckGo row in `scope.md` already states |
| A passphrase lock, an idle auto-lock policy the person tunes | The keystore file's reserved version byte |
| An account derived from the identity seed ("no setup" funds) | After identity export ships (`ADR-0010`) |
| Nostr signing with the same curve library (A44) | The same direct dependency; its own ADR in the `nostr` stream |
| dApps in iframes, `eth_subscribe`, EIP-5792 batched calls, EIP-7702 authorisations | Not needed by any named consumer |

---

## Sources consulted

`<vision-corpus>`: `implementations/wallet-system.md`, `implementations/web3-score.md`,
`implementations/data-gathering.md`, `implementations/dashboard-app.md`,
`technical-design/orivon-objects.mdx`, `technical-design/standards.mdx`,
`technical-design/orivon-runtime.mdx`, `technical-design/orivon-core.mdx`, `orivon.mdx`,
`roadmap.mdx`. This repository: `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`, `docs/scope.md`,
`docs/architecture/capability-api.md`, `handle-contracts.md`, `security-model.md`,
`app-compatibility.md`, `docs/planning/compatibility-matrix.md`, `build-plan.md`,
`docs/open-questions.md` (A2, A32, A44, A111, B4), `docs/decisions/` (0003, 0010, 0012, 0014,
0018, 0021, 0028, 0030, 0031, 0032, 0033, 0037 and the log), `src/contracts/`,
`src/resolution/`, `src/ens/`, `src/verifier-host/`, `src/main/keyring/`, `src/main/verifier/`,
`src/main/consent/`, `src/main/sessions/`, `src/main/permissions/`, `src/broker/`,
`src/preload/`, `src/nostr/`, `src/renderer/`, `scripts/check-page-globals.mjs`,
`package.json` and the installed `viem` and `@a16z/helios` packages. `orivon-ports`: every
`apps/<id>/README.md` and `bridge/`, `docs/*-recon.md`, `docs/port-candidates.md`, and the
pinned upstream sources with `node_modules` excluded. `<prior-mvp>`'s wallet UI, for look only.
`<early-notes>`: the private planning documents `docs/inventory.md` indexes.
