# `test/apps/swarm-gateway/`: a Swarm node for the suite

[`gateway.mjs`](gateway.mjs) holds the chunks of the sites and feeds a test builds and serves them
the way a Bee node does: `/chunks/<hex>`, and `/feeds/<owner>/<topic>` with the newest index in a
`swarm-feed-index` header when the test asks for it (otherwise a 501, as a node without that route
answers). `addSite` stores a site's files as a Mantaray manifest over a chunk tree and returns its
reference; `addFeed` returns a feed's manifest and a `publish` that stores the next signed update.
It logs every request, so a test can count what the verifier asked for; `tamper` and `setTamperAll`
flip a byte of the chunks they name, so a test can watch the verifier refuse them; `redirect`
answers a chunk with a redirect, as a content filter does. It listens on loopback on a port the OS
picks, so it can never collide with the fixed ports other fixtures and `orivon-ports` hold.

[`encode.mjs`](encode.mjs) is the second implementation of the formats it serves, written from the
formats alone and importing nothing from `src/`: chunk addresses, Bee's left-filled file tree (with
an optional redundancy level and fake parity references), Mantaray 0.2 manifests and signed feed
updates. The unit tests under `src/protocols/swarm/tests/` use it to check the product's parsers
against it.

A test build of the shell reaches the node through the verifier's test seam: fixture `.eth` names
mapped to `bzz://` references, and the endpoints a test lists in `ORIVON_TEST_SWARM_ENDPOINTS`
(`src/main/verifier/test-seam.ts`).
