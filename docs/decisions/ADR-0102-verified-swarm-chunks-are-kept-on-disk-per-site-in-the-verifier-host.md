# ADR-0102: Verified Swarm chunks are kept on disk per site, in the verifier host

- **Status:** accepted. Extends [`ADR-0077`](ADR-0077-swarm-content-is-verified-chunk-by-chunk-from-a-local-node.md): its rule that a chunk is used only after its address is recomputed now also covers a chunk read back from disk.
- **Date:** 2026-10-28
- **Type:** architecture / security
- **Decided by:** AI recommendation accepted by default

## Decision

The verifier host keeps the content-addressed chunks of Swarm that it has verified in one SQLite database, `<profile>/verifier/swarm-chunks-<id>.db`, opened with `node:sqlite` (`DatabaseSync`, part of Electron 44's Node: no native module). `<id>` is the first 16 hex characters of sha256 of the profile's partition salt, the salt the IPFS node's store is keyed by. A row is keyed by the partition key (`partitionStoreKey(salt, partition)`, base64url of sha256 of the salt and the site's origin) and the chunk address, so no origin is in the file in plain text and one site's chunks are never another's hits.

- **What is kept.** Only content-addressed chunks, the ones `ChunkSource.get` and `ChunkSource.leaves` fetch. Single-owner chunks and feed updates are never kept: they are mutable, and asking for the newest is the point of asking.
- **Trust.** A row read back is hashed against its address (`verifyCac`) before it is used, as a network answer is. A row that fails is deleted and the chunk fetched again. The disk is trusted no more than the node.
- **Size.** At most 256 MB of chunk bytes. When a write passes the cap, rows go least recently used first, down to nine tenths of it. `used` is the minute of the last read or write, set by one write per row per minute at most, so a read costs no write.
- **Memory in front.** `KeptChunkMemory` is a `BlockMemory`: `recall` asks the in-memory `BlockCache` first, then the database, and a chunk it took from the disk is then answered from memory; `remember` writes to both; `share` stays the in-memory one. A mount with no partition keeps nothing, as before.
- **Writes.** WAL journal, `synchronous = NORMAL`, 32 KB pages (a chunk row is a little over 4 KB, so a smaller page would give each row two). Rows wait and go in one transaction when 64 are waiting or 250 ms after the first, so a file of 2,000 chunks is about thirty commits. A failed write is logged once and drops that batch; no load fails because of the store.
- **Opening.** At the first use, which is the first Swarm mount with a partition. A file that is not a database is deleted and made again once. If the directory or the file cannot be opened at all, the host logs one line and keeps chunks in memory for the rest of the run.
- **Forgetting.** Clearing cached data or all history stops the IPFS node, replaces the salt, puts the host to sleep and waits for its process to exit (at most 10 s), then deletes every `swarm-chunks-*` file except the one of the new salt, with its `-wal`, `-shm` and `-journal`. A host that opens its database also deletes every `swarm-chunks-*` file whose id is not its own salt's, so a file main could not delete (Windows keeps an open file) goes at the next start.
- **Report.** The host's log line for a mount, and for a file of 256 KB or more, says how many chunks came from disk; the store logs its size when it opens. No line names an address or a site.

## Context

Swarm sites load from Orivon's own Swarm node, which runs with `--no-disk-cache` because its disk cache needs threads WASI lacks. Orivon kept verified chunks only in memory (64 MB, in the verifier host), so after a restart, or after the host slept, a revisit downloaded everything again: the WebTorrent app's page took 15 to 19 s every time. The IPFS node keeps a 256 MB `blocks.db` keyed by the same salted partition, so an IPFS revisit is local.

## Alternatives considered

- **A disk cache in the Swarm node.** Not possible: the node's cache needs threads, which its WASI host does not give; the reason it runs without one.
- **The store in the main process.** Rejected: the host is where chunks are verified and where `ChunkSource` runs, and `BlockMemory.recall` is synchronous, so a round trip to main would turn a lookup into a message. The host is an unsandboxed utility process, so a directory it writes opens no capability it lacked; it does write one directory of the profile now.
- **One file per site.** Rejected: a site opened once leaves a file, there is no single place to count the cap, and a file name that is a function of the origin shows the sites visited.
- **Files on disk, one per chunk.** Rejected: 60,000 small files for a full cache, a directory listing to find the least recently used, and no transaction.
- **A key without the salt (the chunk address alone).** Rejected: a site could then tell, by how fast a chunk loads, whether another site fetched it, which is the leak the in-memory cache already closes (A256).
- **Keeping single-owner chunks and feed updates.** Rejected: a kept feed update is a stale answer to the question the feed exists to ask.
- **Compressing rows.** Not taken: chunks of media and archives do not compress, and the cost lands on the read path.

## Reasoning

Verification does not change: every byte used is in a chunk whose address was recomputed from it, on the way in from the node and again on the way out of the file. What the file adds is availability, so the worst a corrupt or replaced file can do is cost the download it was meant to save. Keying by the salted partition keeps the IPFS store's property: the file holds no origin, a copy of it means nothing in another profile, and one site's chunks answer only that site.

## Consequences

- A Swarm site seen before opens from disk: no request to the node for a chunk the site has already read, up to the cap.
- The file is larger than the bytes it counts, by about a seventh, for page padding and the indexes.
- The host now writes one directory of the profile (`verifier/`), where it wrote nothing before.
- The salt that keys the IPFS node's store also keys this one, so clearing cached data forgets both, and a profile with the IPFS node off still has a salt.
- Whoever holds the whole profile directory has the salt beside the file: the keying defends against timing between sites and against origins in plain text in the file, not against that reader.

## Reversibility

- **Cost to reverse:** cheap: the gatherer takes its memory as an option, and removing `config.swarmChunks` returns to memory alone; the files are a cache.
- **What would make us revisit:** a Swarm node whose own disk cache works under WASI (the store would then duplicate it), or `node:sqlite` leaving Electron's Node.
