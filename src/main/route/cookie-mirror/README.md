# `src/main/route/cookie-mirror/`: the same sign-ins in the tunnel profiles and in normal browsing, for the sites a person opens, when the person asks for them

**What lives here.** The part of [ADR-0111](../../../../docs/decisions/ADR-0111-a-person-can-keep-the-tunnel-profiles-sign-ins-the-same-as-normal-browsing-and-a-cookie-mirror-keeps-them-in-step.md)
that copies cookies between the default session and the kept sessions of the three profiles
([`../site-partition.ts`](../site-partition.ts)) while "Keep tunneled sites separate" (`network.tunnel.separateSignIns`) is off. Only the cookies of a site
a tunnelled tab has opened as its top-level page are copied (its registrable domain, `mirror-site.ts`); no other cookie is.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `cookies.ts` | A cookie as a store holds it, how it is written into another store with every attribute kept (`planSet`), which cookie is which (`identityOf`), which site it belongs to (`siteOfCookie`), whether two are the same (`sameCookie`), which changes the mirror follows (`followsChange`), and the `CookieStore` the mirror asks of a session | Durable: pure |
| `mirror-site.ts` | The site an address belongs to for the mirror: the registrable domain by the whole public suffix list, private section included, and the whole host for an address Orivon serves | Durable: pure |
| `navigation-hops.ts` | Whether a main-frame request is the first of a navigation the person started, the first of one a page started, or a hop after the first | Durable: pure |
| `cookie-mirror.ts` | The mirror: copies a site into a profile when the person's navigation is about to load it or a navigation has committed at it, makes a profile equal to the default session for its recorded sites when it starts or joins, follows every change of those sites, clears them from the profiles when stopped or when history is cleared, and counts what it did | Durable: free of Electron, over the stores it is handed |
| `mirror-record.ts` | What is kept on disk: the sites copied into each profile and whether a clear is owed (`cookie-mirror.json` in the profile folder), read and written atomically | Durable: Node only |
| `members.ts` | Which session names take part (a profile's kept session, never in a private window's process) | Durable: pure |
| `mirror-status.ts` | What `orivon://report` says of the mirror: one word and counts, never a cookie's name, value or site | Durable: pure |
| `write-budget.ts` | The bound on how often one cookie is written into one session (30 times in 5 seconds), against a store that keeps changing what it is given | Durable: pure |
| `mirror-forget.ts` | How "Clear browsing data" reaches the mirror: the way to forget the sites copied, registered by the installer and called by the privacy domain | Durable: pure |
| `session-ready.ts` | The promise a profile session's first request waits for, so a page opened in a profile made while the setting is off already has the cookies of the sites recorded | Durable: pure |
| `install-cookie-mirror.ts` | Adapts Electron's `session.cookies` to `CookieStore`, joins each profile session as the website-sessions seam announces it, waits a page load for the copy of its site (a `webRequest` handler on the main frame, there only while the mirror is on), tells the mirror when a tab commits a navigation, and follows the setting | Tied to Electron |

**What it depends on.** [`../site-partition.ts`](../site-partition.ts), [`../within.ts`](../within.ts),
[`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) (which hosts Orivon serves), [`../../sessions/website-sessions.ts`](../../sessions/website-sessions.ts)
(the seam that announces a profile session with its name) and [`../../sessions/web-request-owner.ts`](../../sessions/web-request-owner.ts).

**What it must never import.** The Electron package, outside `install-cookie-mirror.ts`. Nothing here reads a cookie's value into a log line
or the report.

**Owner stream.** `broker`.

## Design notes

**A site is added by the person's navigation or by a commit, never by a request that merely passed.** The scope is the sites a person opens in a tunnelled
tab, so that a tracker's ID minted in a tunnel is not sent from normal browsing, and the reverse. The installer's `webRequest` handler asks
`visit` for every main-frame request in a profile session and says whether it is the first request of a navigation the browser started
(`navigation-hops.ts`: no initiating origin, no referrer, and not a hop after the first, which keeps the request's id): only then does a new site
join before the page asks. It is recorded on disk, the default session's cookies of it are written into the profile, and the request goes on (8 seconds
at most: a mirror that is slow or failing never keeps a page from loading). A site already being copied is waited for whatever started the load. A redirect
hop and a navigation a page started add nothing, so a tracker a page bounces through is never in the scope. `committed` is asked from the tab's
`did-navigate`: the site a navigation has landed on joins then, so a page-started navigation to a new site loads signed out once. A tab a page opens
with no referrer at all looks like one the person opened; the site would join at its commit anyway. The scope is *provisional* (the ADR says what would
settle it).

**A site is its registrable domain by the whole public suffix list, and an address Orivon serves is its whole host.** `mirror-site.ts` consults the private
section of the list (`alice.github.io` and `bob.github.io` are two sites, which the privacy helper `siteOf` deliberately does not do), and for a host
under a suffix Orivon routes to the verifier (`.eth`, `<label>.ipfs.orivon`, `<label>.bzz.orivon`) takes the full host, because the domain above it is a
namespace shared by every party in it.

**Clearing history forgets the list.** `forget` clears the recorded sites from the profiles (with the clear recorded as owed first), empties the list and
follows again; nothing it removes is carried to the default session. The list has no times, so any history range empties all of it.

**The default session is the truth at launch.** A profile that joins, and every profile when the mirror starts, is made equal to the default session for
its recorded sites (`equalize`): what the default holds is written, what only the profile holds is removed. Nothing is copied from a profile to the
default session at launch, so a stale or lone cookie in a profile cannot come back into normal browsing, at the cost of a sign-in made in a tunnelled
tab just before a crash. Only live changes go both ways.

**A change is carried by reading both sessions again and comparing with what they last agreed on.** The event only says which cookie to look at. The
mirror reads it in both sessions by address and name (`find`, a read scoped by address) and compares each with `agreed`, the value both held last. The
side that changed since gives to the other; a removal reaches the other only while it still holds the agreed value; when both changed, the change
observed later wins (the order the events arrive in, which does not depend on a cookie's creation time). The agreed value is set before a write is made,
so the write's own event is recognised as nothing to carry; as a further bound against a store that keeps changing what it is given, a cookie is
written into one session at most 30 times in 5 seconds (`write-budget.ts`). `list` reads the whole jar in Electron, whose `domain` filter is applied after the read, so it is
asked once for all the sites a step needs and never once for each cookie.

**One worker, steps first.** `step` queues a start, a stop, a join or a site's first copy, and the worker runs those before it carries the next
changed cookie, so a continual stream of changes cannot starve a profile that is waiting for its copy.

**A removal the mirror makes itself is never carried.** `remove(url, name)` takes every cookie of that name the address would send, so the other cookies
of that name that were listed first are written back (`take`). One that cannot be written back is forgotten (`agreed` loses it), which makes the next
look at it a cookie only the other session holds, to be copied there, never a removal to carry.

**A clear is owed on disk before it is done.** Turning the setting back on records `owed` in `cookie-mirror.json`, clears the recorded sites from every
profile, and empties the record only when every profile has been cleared. A restart with the setting on finishes it (`settle`), and a start with the
setting off clears first. Only the recorded sites' cookies go; the verification is that the removals did not fail, because a partitioned cookie that
Electron would not remove would otherwise keep a clear owed for ever.

**Electron 44's cookie API carries no partition key, and lists a partitioned cookie like any other**, so one cannot be told from an ordinary cookie, or written back
with its key. A cookie that shares a name, domain and path with another in a listing (only partitioned cookies share them) is never written to the other
session (`twinned`, forgotten for a cookie that is set anew and judged again from the listing at each equalize); a removal of the cookie last mirrored still
reaches the other session, and the look-alike left behind is not carried as if it were the cookie's new value. A lone partitioned cookie of a site that is
mirrored is carried as an ordinary one (a known limit); third-party cookie blocking does not cover that (it works on the
request, and a script in a cross-site frame still reads and writes `document.cookie`), which is why the scope is the sites opened and not every cookie.
