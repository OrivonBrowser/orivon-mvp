# `src/main/route/cookie-mirror/`: the same sign-ins in the tunnel profiles and in normal browsing, when the person asks for them

**What lives here.** The part of [ADR-0109](../../../../docs/decisions/ADR-0109-a-person-can-keep-the-tunnel-profiles-sign-ins-the-same-as-normal-browsing-and-a-cookie-mirror-keeps-them-in-step.md)
that copies cookies between the default session and the kept sessions of the three profiles
([`../site-partition.ts`](../site-partition.ts)) while "Keep tunneled sites separate" (`network.tunnel.separateSignIns`) is off.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `cookies.ts` | A cookie as a store holds it, how it is written into another store with every attribute kept (`planSet`), which cookie is which (`identityOf`), whether two are the same (`sameCookie`), which changes the mirror follows (`followsChange`), and the `CookieStore` the mirror asks of a session | Durable: pure |
| `cookie-mirror.ts` | The mirror: merges once when started, follows every change of the default session and of each joined profile, clears the profiles when stopped, and counts what it did | Durable: free of Electron, over the stores it is handed |
| `members.ts` | Which session names take part (a profile's kept session, never in a private window's process) | Durable: pure |
| `mirror-status.ts` | What `orivon://report` says of the mirror: one word and counts, never a cookie's name, value or site | Durable: pure |
| `session-ready.ts` | The promise a profile session's first request waits for, so a page opened in a profile made while the setting is off already has the cookies | Durable: pure |
| `install-cookie-mirror.ts` | Adapts Electron's `session.cookies` to `CookieStore`, joins each profile session as the website-sessions seam announces it, brings in the profiles that have data on disk, and follows the setting | Tied to Electron |

**What it depends on.** [`../site-partition.ts`](../site-partition.ts), [`../site-routes.ts`](../site-routes.ts) (`ensureSiteSession`),
[`../kinds-migration.ts`](../kinds-migration.ts) (`profileFolder`), [`../within.ts`](../within.ts) and
[`../../sessions/website-sessions.ts`](../../sessions/website-sessions.ts) (the seam that announces a profile session with its name).

**What it must never import.** The Electron package, outside `install-cookie-mirror.ts`. Nothing here reads a cookie's value into a log line
or the report.

**Owner stream.** `broker`.

## Design notes

**A change is carried by reading both sessions again, not by trusting the event.** The event only says which cookie to look at. The mirror reads
it in the session it came from and in the other and writes only where they differ, so what the mirror itself wrote finds both sides equal and
ends there. It keeps no list of its own writes: a write that changes nothing may raise no event, and an expectation that is never met would
swallow a real change later. As a bound against a store that keeps changing what it is given, a cookie is written into one session at most 30
times in 5 seconds.

**The default session is the hub.** A change in a profile is written to the default session, whose own change event then reaches the other
profiles; a change in the default session is written to every profile. The default session wins where a merge finds both holding a cookie.

**A site signs out by sending the cookie already expired.** Chromium announces that as `expired-overwrite`, so it is followed like an explicit
removal. `overwrite` is the removal half of a change of value and is followed by an insert; `expired` and `evicted` go from each store by themselves.

**`remove(url, name)` can take more than the cookie it was meant for.** It removes every cookie of that name the address would send, a host-only
cookie and a domain cookie of the same host among them. After a removal the source's other cookies of that name are written back.

**Electron 44's cookie API carries no partition key**, so a partitioned cookie cannot be read or written with its key and is not mirrored.

**Profiles with data on disk are made when the mirror starts.** A profile session is made lazily, and a sign-out in normal browsing while it did
not exist would otherwise return from its stale copy at its first use. A profile made later has an empty store and joins as it is announced;
its first request waits up to 8 seconds for its cookies, and a mirror that is slow or failing never keeps a page from loading.
