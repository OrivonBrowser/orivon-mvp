# `test/apps/ipfs-gateway/`: a trustless IPFS gateway for the suite

[`gateway.mjs`](gateway.mjs) builds the sites an end-to-end test names into UnixFS DAGs when it
starts, then serves their blocks the way a public trustless gateway does (`?format=raw`), the
signed IPNS record of each site named in `ipnsKeys` under a key made at start (`?format=ipns-record`,
the key in `keys`), and DNSLink TXT answers in the JSON form of DNS-over-HTTPS. A file is text or
bytes. It logs every request, so a test can count what the verifier asked for; it can flip one byte
in any file's block, so a test can watch the verifier refuse it; `failNext` makes a file's block answer
a status (a 502, say) for its next few requests and then serve it, as a gateway that is briefly
unwell does; `blockDelayMs` holds every block
answer that long, as a slow public gateway does; and `hang` answers nothing at all, as a dead one
behind a proxy does.

A test build of the shell reaches it through the verifier's test seam: fixture `.eth` names mapped
to the roots it built, and the gateways a test lists, in order (`src/main/verifier/test-seam.ts`). It
listens on a port the OS picks, on loopback, so it can never collide with the fixed ports other
fixtures and `orivon-ports` hold.
