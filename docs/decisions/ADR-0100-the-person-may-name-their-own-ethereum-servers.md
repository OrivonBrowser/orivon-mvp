# ADR-0100: The person may name their own Ethereum servers, and a local one is reached directly

- **Status:** accepted, provisional (see Reversibility). Amends [`ADR-0031`](ADR-0031-helios-is-the-light-client.md): the servers the light client asks are Orivon's by default and may be the person's instead.
- **Date:** 2026-10-28
- **Type:** security
- **Decided by:** owner (no fallback: the person's servers replace Orivon's, and `.eth` names wait and say so when they fail); AI recommendation accepted by default for the rest (a home network allowed, a Nym window held to Orivon's servers, both servers changeable), provisional until the owner says otherwise

## Decision

**The Ethereum light client may ask servers the person names instead of Orivon's.** Their execution servers (a list, asked in
order) and their beacon server each replace Orivon's for that field; an empty field keeps Orivon's. Orivon's servers are never
tried after the person's: when theirs fail, `.eth` names wait and the page says which server failed and why, so no server the
person did not choose learns a name they set up their own server to hide.

**An address on this computer or on the home network is reached directly, and never through a proxy or a tunnel.** The verifier
host gets a fetch, `local-rpc-fetch.ts`, that dials only `localhost` or a loopback or private (RFC 1918, unique-local) address
literal, over Node sockets that read no proxy setting, with no redirect followed and a limit on an answer's size and idle time.
The config names which servers are local (`LightClientConfig.localEndpoints`), and the host re-checks that each is such a
literal before it starts the client; the light client's lane fetch sends those origins to the local fetch on every route and
every other to the lane's own. A server that is not named local must be `https` at a public address or a public name (never a local address in another
spelling, `localhost.`, `*.localhost` or a single-label name) and, where it leaves outside the tunnel, answer on port 443.

**A server's key never reaches a screen, a log, an error or a report.** Helios is given names that resolve nowhere on every
lane (the direct one as well), so an error of its cannot quote an address. Every address that is shown is masked to
`host[:port]` and `/••••` when it has a path or a query, and a lane name or configured address inside a message is replaced
before the message is stored. Each of the person's execution servers is asked for its chain id as the client starts, and one
that is not Ethereum mainnet is dropped with a sentence saying so.

**The choice is three settings under Settings > Web3**: which servers (Orivon's or the person's), up to four execution
addresses and one beacon address. Each address is checked when it is typed and again when it is saved, by one rule
(`light-client/server-address.ts`), and refused with a reason that never repeats it. A saved address shows masked in the
list. A private window held to Nym starts on Orivon's servers with both lists empty, so a key is not copied into a window whose
point is that nothing of the person is. The secret-scrub registry (`diagnostics/secret-scrub.ts`) is told each part of the
saved addresses and applied where a log line, a crash record and a report are made.

## Context

The servers are fixed in code (`DEFAULT_ENDPOINTS`). People who run their own node, or hold an account with a provider, have
no way to use them, and the execution server is the one that learns which names are opened (`docs/privacy/outbound-requests.md`
row 4). Nothing in the verifier host can reach a loopback or private address for the light client today: `direct-fetch.ts`
refuses every non-public address and a request through Electron's `net` would follow the proxy setting, which sends a private
address to a tunnel's front, whose exit could then reach its own network (T12).

## Alternatives considered

- **One internet RPC field.** Rejected: it shuts out the people most likely to want the setting, those who run a node on this
  computer or at home, and one address has no failover.
- **Fall back to Orivon's servers when the person's fail.** Rejected: it tells three public servers the names the person set up
  their own to hide, which defeats the setting. A switch for it is more interface than the owner has approved.
- **Send a local server through `net`.** Rejected: a loopback address bypasses Chromium's proxy implicitly, a private one does
  not, and with the whole browser on the tunnel it would go to the front. A dedicated Node socket is the only path that never
  does.
- **Keep the addresses in the keyring.** Deferred: a second storage path outside the settings table for a low-value,
  rate-limited key. It is the first thing to revisit if a key leaks.
- **Mask only on screen.** Rejected: a key in a log or a report leaves the machine as surely as one on screen, and Helios's own
  errors quote the address it was given.

## Reasoning

Every answer is still proven by the light client against its checkpoint, so a server of the person's is trusted for
availability only, as Orivon's are (T28): it can stop a name from loading and can not make one show the wrong site. What changes
is who learns the names, and that is the person's choice. Reaching a local server with its own fence, the reverse of
`direct-fetch.ts`'s, keeps the property the tunnel gives (the exit is never asked to reach this computer's network) while
allowing the one local reach the person asked for by typing an address.

## Consequences

- A new file in the egress table (`local-rpc-fetch.ts`) and a new reach the security model names under T12: a literal the
  config names local, never one a page, an app or a name chose.
- The light client's failed reason can name the person's server, masked, and what it answered.
- A key in an address is stored in plaintext wherever the address is stored. Masking and scrubbing cover what is shown, logged
  and reported; they do not encrypt the file.
- A server on the internet that the whole browser reaches outside the tunnel must answer on port 443 (`outside-fetch.ts`).
- A Nym private window cannot use the person's servers; its light client asks Orivon's.
- A secret shorter than four characters is not scrubbed from free text, and a path with nothing key-like in it (`/eth`) is not
  scrubbed alone: the address that holds it is, and is shown with its path hidden.
- A name on the internet is judged as a name, not by the address it resolves to: one that resolves to a private address is
  reached by the lane's own route, the person's own choice (T12).
- The checkpoint file, copied into every new profile and private window, names Orivon's beacon servers only.

## Reversibility

- **Cost to reverse:** moderate. The lane fetch, the local fetch and the masking are separate files; the setting that names the
  servers is a table row.
- **What would make us revisit:** a report of a leaked key, or a keyring path for secrets in general (the addresses would move
  there); the owner choosing a tunnel for local servers, one field only, or a Nym window that keeps the person's servers.
