# ADR-0114: Orivon's names are signed for 3653 days and re-announced every four hours by a job separate from Kubo's republisher

- **Status:** accepted
- **Date:** 2026-11-16
- **Type:** architecture
- **Decided by:** owner for the lifetime (at least ten years); AI recommendation for the job that keeps it

## Decision

The IPNS record of each key behind an `<name>.orivonstack.eth` name is signed to last 3653 days (`87672h`: ten calendar
years, whatever the leap days). `scripts/ipns-republish.sh`, run by a timer on the pinning node every four hours, puts each
key's record on the network again exactly as the node holds it, and signs it anew for the same value when fewer than 30 days
of it are left. It is a job of Orivon's own, apart from Kubo's republisher: each key has a timeout, and several run at once.
Each record goes out by two routes, over HTTP to a delegated routing endpoint (`delegated-ipfs.dev` by default), which puts it
into the DHT from its own nodes, and into the DHT through the node; a key is handled once one route took it (amended
2026-11-17, `d-0792`). The node's `Ipns.RecordLifetime` is set to the same value, so Kubo's republisher, when it runs, signs
the same lifetime.

## Context

The names went dark when Kubo's republisher stalled. On Kubo 0.43.1 a goroutine dump showed it blocked for 47 hours inside a
DHT put (`republishEntry`, `PublishIPNSRecord`, `PutValue`, `GetClosestPeers`), a lookup that never ended, under a context with
no deadline. It publishes the keys one by one, so none after that one was renewed. Their records, signed for 48 hours, expired,
and 15 names stopped resolving. The watchdog's restarts of Kubo had hidden this, because each start runs the republisher again.
`ipfs name publish` signs for 48 hours whatever `Ipns.RecordLifetime` says (the setting only drives Kubo's own republisher), so
the release pinner and every other publisher kept making 48 hour records. A DHT keeps a record for about 36 to 48 hours, so a
record of any lifetime must also be put again regularly. The job is described in [`packaging.md`](../development/packaging.md)
section Keeping the names alive.

The first day of the job found the cause one level down. Minutes after Kubo restarted, a goroutine dump showed a DHT write to
one peer (`peerMessageSender.SendMessage`, a QUIC stream write) blocked for 14 hours: the peer had stopped reading, the write
has no deadline, and it holds that peer's lock. Seventeen requests waited on the lock, so every lookup that reached the peer
never ended, Kubo's republisher stalled again, and the job's own put of one key timed out on every run. The job's timeouts
kept every other key going; the HTTP route carries the keys whose lookups pass a stuck peer.

## Alternatives considered

- **Lengthen `Ipns.RecordLifetime` and leave the rest to Kubo.** Rejected: the setting is not what `name publish` uses, and the
  republisher would still stop at one hung lookup, which leaves records the DHT has already dropped.
- **Restart Kubo when its republisher stalls.** Rejected: it hides the stall, as the watchdog's restarts did, and a restart loses
  a release add in progress.
- **A shorter lifetime (a year, 30 days) with the same job.** Not chosen: the owner asked for at least ten years, so that a
  stopped job costs nothing until someone notices it.
- **Sign a record anew on every run.** Rejected: it reads a value and publishes it later, so it can undo a publisher that moved
  the key in between (the release pinner moves `latest-release`). Putting the record unchanged carries no value to be stale.

## Reasoning

A lifetime only says how long a record stays valid unrenewed, and the DHT's retention says how often it must be put again, so
two things are needed: a long lifetime, and a job that does not stop for one lookup. The job is the second; the lifetime makes
the first failure it has cost nothing visible. Re-signing only when a record is near its end, and putting it unchanged
otherwise, keeps the sequence of an unchanged value and leaves moving a key to whoever moves it.

## Consequences

- An expired record is no longer the way a name goes dark: a stalled or stopped job leaves records valid for years, and the
  status page's warning of an end under 12 hours (`ipfs-status.sh`) now means the job is broken.
- **Accepted risk:** a record that a newer one has superseded stays valid for ten years, so a party that kept it can serve it
  where the newer record cannot be found. Where both are seen the higher sequence still wins, and a profile that has seen none
  has only the grace described in T33 ([`security-model.md`](../architecture/security-model.md)): its residual, an old record that
  is still validly signed winning where no source answers with a newer one, now lasts ten years instead of two days.
- A key moved by a tool that signs for 48 hours (`pin-releases.sh` for `latest-release`) is signed anew by the next run.
- A key the node holds no valid record for fails the run, and its line says how to publish it by hand; the job never invents a
  value.
- While the node's DHT client is stuck, the keys it cannot reach depend on the delegated routing endpoint alone. Its line ends
  in `failed: DHT: ...` on every run, and ops-checks, which reads every record from outside, alerts when no source has one.

## Reversibility

- **Cost to reverse:** expensive. A shorter lifetime applies only to records signed after the change; a record already signed
  and held by others cannot be recalled and stays valid to its end.
- **What would make us revisit:** a name seen resolving to a superseded record, or IPNS gaining a way to revoke a record.
