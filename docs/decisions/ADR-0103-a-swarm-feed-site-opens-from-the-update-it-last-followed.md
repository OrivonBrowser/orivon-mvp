# ADR-0103: A Swarm feed site opens from the update it last followed, and a newer one is used from the next load

- **Status:** accepted. Extends [`ADR-0102`](ADR-0102-verified-swarm-chunks-are-kept-on-disk-per-site-in-the-verifier-host.md): its "What is kept" no longer excludes the update a feed was last followed to.
- **Date:** 2026-10-29
- **Type:** product / architecture / security
- **Decided by:** owner (2026-10-29: open the last version seen at once, from disk, checked as authentic; look for a newer one in the background; use a newer one the next time the page loads. The same day: the two limits under "The next load" accepted as they are, with no strict per-page follow-up)

## Decision

When a Swarm mount follows a feed hop from the network, the verifier host keeps that update's whole single-owner chunk on disk, in the per-site partition of [`ADR-0102`](ADR-0102-verified-swarm-chunks-are-kept-on-disk-per-site-in-the-verifier-host.md)'s file, with its index. The chunk is a row of the `chunk` table under its single-owner address, so it counts toward the same 256 MB cap, ages and is evicted with the chunks, and goes when the file does; a small `feed_update` table, keyed by the same salted partition key and the feed's owner and topic, holds the index and the chunk row it points at, so evicting the chunk takes the feed row with it, and a read of that address as an ordinary chunk never deletes the update. `user_version` is 2, so a file of the earlier layout is made again.

A later mount of that feed in that partition:

1. reads the kept update and recomputes the address it must have been signed for (`feedUpdateAddress`, `verifySoc`), so the disk is trusted no more than the node; a row that fails is deleted and the hop goes to the network, as with no row;
2. uses it only when its index is not below the highest index `FeedIndexStore` has seen for the feed (the rollback guard: a feed is never read as older than it has been); otherwise the hop goes to the network as before;
3. follows the hop to the kept update's target **without waiting for the Swarm node**, and records the step (`swarm-feed`) as for a network read;
4. starts one background look for a newer update (`resolveFeed`), which waits for the node like any network read, runs under its own abort and a 60-second limit, never fails or delays the mount, and logs one line when it fails (a reason word, never an address or a site). At most one look runs for a feed in a partition. When it finds a higher index it records it in `FeedIndexStore` and keeps that update in place of the old one.

**The next load.** A mount that opened from a kept update answers `MountedSite.hasNewer` once its look found a higher index. `Sites.get` is told whether the request is a page load the person started, and a page load of a site that answers `hasNewer` mounts again, from the newer update, which is on disk. A page load is a request with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`, which Chromium sets on the top-level navigation to the loopback address that serves a `bzz://` page and a page cannot set. Every other request, a subresource or a frame included, is served from the mount in hand. The real shell shows both halves (`test/web3/e2e-swarm-feed-kept.test.ts`): a typed navigation to the name reaches the host marked as a page load and mounts the newer update, while a `fetch` the open page makes meanwhile is not marked as one and is answered from the version the page opened with. So the newer version appears at a reload or a later visit, and the look itself never swaps a version under a page that is open. A mount whose look found nothing newer, or failed, is reused as before.

**Two limits of how this build works.** A page that is open reads its files from the site entry the host holds for its partition and host, and that entry is not permanent. `Sites` keeps one entry for each partition and host, uses it for `SITE_TTL_MS` (2 minutes), serves it stale for up to `STALE_SERVE_MS` while a new mount revalidates it, and drops the least recently used past `MAX_SITES`. So: (1) once the entry is mounted again after those 2 minutes, in the stale window or after a drop, the new mount follows the newer update the look kept, and the requests an open page makes after that read the newer version (the same remount resolved the feed from the network before this change, so this is no sooner than it was); (2) a page load of the same site in another tab, after the look found a newer version, replaces the entry, and the first tab's later requests read the newer version. Within one entry's 2 minutes, and while no other tab loads the site, the version an open page reads does not change, and the newer version is taken by the next page load. The owner accepted both limits on 2026-10-29.

**What does not change.** A first visit, a partition-less mount and a feed with nothing kept wait for the node and ask the network. With Swarm switched off (`holdMounts`) every mount waits for the node's refusal first, so a kept site does not open. A site in a tunnel's profile keeps its update under the tunnel's name, as it keeps its chunks, and `SWARM_NOT_TUNNELLED` is untouched.

## Context

A Swarm feed site reopened after a restart took about 7 s on the owner's measurement: the node starts (1.6 s), then the mount looks up the feed's newest update on the network (about 3 s), then the files are read from disk (about 2 s). With no network at all it failed with "no answer from the Swarm node about whether ... exists", though every chunk of the site was on disk. A feed hop always waited for the node because its newest update is mutable ([`d-0748`](decision-log.md)), and [`ADR-0102`](ADR-0102-verified-swarm-chunks-are-kept-on-disk-per-site-in-the-verifier-host.md) kept no feed update.

## Alternatives considered

- **Keep waiting for the network on every mount, as before.** The seven seconds and the failure offline stay. Rejected by the owner: a site seen before should open at once.
- **Swap the new version under the open page as soon as the look finds it.** Rejected: a page that changes version the moment the look finds it breaks what it loaded (scripts of one version, files of another) and the person's place in it.
- **Use a kept update only while it is younger than some age.** Rejected: freshness of a feed is not provable from the network either (an endpoint can hide the newest update), so an age limit would add a wait without adding a guarantee; the rollback guard is the property the design can actually hold.
- **Keep the index only (the existing `FeedIndexStore`), and fetch the update by index.** Rejected: the update is a chunk, and fetching it needs the node; keeping the chunk is what lets a mount send no request.
- **A separate file or table for the update bytes.** Rejected: a row of the chunk table counts toward the cap, ages with the chunks and is removed with the file, with no second accounting.
- **Migrate a version-1 file in place.** Not taken: the file is a cache, and the layout rule of [`ADR-0102`](ADR-0102-verified-swarm-chunks-are-kept-on-disk-per-site-in-the-verifier-host.md) is to make a layout the code does not know again, so one cold visit per site follows the upgrade.

## Reasoning

Verification does not change: the page opens from a signed chunk whose signer is recovered and whose address is recomputed on every use, and the rollback guard keeps the feed from going back. What changes is freshness, which Swarm cannot prove anyway: the person sees the version of their last visit at once and the newest one at the next load, where before they saw whichever the node produced after a wait. The look is a normal network read, so its answer is verified like any other, and a failure of it costs only the newer version.

## Consequences

- A Swarm feed site opened before opens in the time its chunks take to read from disk, with no node and no network. Measured on the WebTorrent app's page (8.9 MB, 2,191 chunks) against the real Swarm node, store reopened after a restart: the mount took 3.7 s and the page 6.0 s (7.6 s with the node's own 1.6 s start) where it now takes 7 ms and 2.4 s, and with no node at all it failed where it now loads in 2.0 s.
- A person sees the version of their last visit first. For a feed published often, the first load after a gap shows the older version, and a reload or the next visit shows the newer; the look finding a newer version changes nothing in a page that is open, apart from the two limits above.
- A page load of a site whose look found a newer version mounts again, and for a `.eth` name that includes resolving the name again.
- The file layout number is 2: the first start after the upgrade makes the file again, and each site's chunks are fetched once more.
- A kept update that its feed's owner later signs a replacement for is not found missing: the look finds the higher index, and keeping it replaces the old row.

## Reversibility

- **Cost to reverse:** cheap: the gatherer takes the kept updates as an option (`keptUpdates`), and leaving it out returns every feed hop to the network; the rows are a cache.
- **What would make us revisit:** a version that opens first and is visibly stale often enough to confuse people (a feed that publishes by the minute), or a way to prove a feed's freshness, which would let the look run before the page opens.
