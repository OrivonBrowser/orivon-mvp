# `test/apps/ipfs-gateway/`: a trustless IPFS gateway for the suite

[`gateway.mjs`](gateway.mjs) builds the sites an end-to-end test names into UnixFS DAGs when it
starts, then serves their blocks the way a public trustless gateway does (`?format=raw`), and
DNSLink TXT answers in the JSON form of DNS-over-HTTPS. It logs every request, so a test can count
what the verifier asked for, and it can flip one byte in any file's block, so a test can watch
the verifier refuse it.

A test build of the shell reaches it through the verifier's test seam: fixture `.eth` names mapped
to the roots it built, and this gateway as the only gateway (`src/main/verifier/test-seam.ts`). It
listens on a port the OS picks, on loopback, so it can never collide with the fixed ports other
fixtures and `orivon-ports` hold.
