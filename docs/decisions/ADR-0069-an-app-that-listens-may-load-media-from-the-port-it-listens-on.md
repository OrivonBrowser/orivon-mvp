# ADR-0069: An app that listens may load media and images from the port it listens on

- **Status:** accepted
- **Date:** 2026-10-08
- **Type:** security
- **Decided by:** AI recommendation, confirmed by the owner on 2026-10-08

## Decision
A page whose origin holds a live `tcp.listen.local` or `tcp.listen.network` grant may load
`<img>`, `<audio>` and `<video>` from `http://localhost` and `http://127.0.0.1` on
a port its own broker listener holds at that moment, and from no other loopback port.

Two layers, both required. The page's Content-Security-Policy gets those two hosts, with any
port, in `img-src` and `media-src` only. A main-process gate then cancels any loopback image or
media request from that page to a port its own listeners do not hold, before it connects. The
gate reads the same listener table `web.embed`'s local pattern reads (ADR-0047). A loopback
request that names no page (the browser's own fetch of a tab icon) is left alone, since no page can read what it fetches. `connect-src` is not widened (the
page's `fetch` already goes through the broker) and neither is `frame-src` (`web.embed` is that
grant).

The widening is made only for the documents the gate can attribute: a granted origin's document
and worker script on the shared session, and an app served from its own cache partition. A local
file and an app's child host keep the policy they had.

## Context
A Node program that streams a file to its own player runs an HTTP server and sets
`video.src = 'http://localhost:<port>/...'`. Under Node and Electron that works with no policy at
all. Here the shim's `http.createServer().listen(0)` binds, and the page's own policy then refuses
the media load (`media-src 'self' data: blob: https:`). T12 already notes that an ordinary web page can reach loopback unprompted; this decision concerns an app's page, whose policy is the narrow one. A ported torrent client cannot play a
file. Rule 20 says the gap is closed in Orivon, not in the port.

## Alternatives considered
- **Widen the CSP alone.** CSP cannot name a port range or a port the app has not been given yet,
  so the page could then load from any local service (a database admin page, a router's status
  image, a debug server). That is the reach T12 exists to refuse, so it lost.
- **Serve the media through the broker (`orivon.net` stream to a blob URL).** A port needs the
  player to seek and range-request; a blob URL costs the whole file in memory. The torrent client
  would also need a change, which Rule 20 rules out.
- **A scheme the shell serves for the app's listener.** It adds a durable name to the surface for
  a need a loopback URL already meets.
- **A grant of its own.** The listen grant already says "this app runs a server on this machine";
  a second consent would ask the same question twice.

## Reasoning
Reading from a port the app itself opened shows the page nothing it could not already put there:
the listener is the app's own code. The gate keeps the claim exact: the only loopback port the page
reaches is one the broker handed it. T12 reads the same afterwards: `*:*` still never reaches
loopback through the broker, and an app's page still cannot load an image or media from a loopback
service it did not open.

## Consequences
- Every document of an origin with a listen grant has a wider `img-src` and `media-src` in its
  policy, and every loopback image or media request from a page passes through this process. The
  filter names only loopback hosts and two resource types, so ordinary browsing is not routed here.
- A page without a listen grant is untouched, as is a page of another kind (a local file, an
  extension page).
- A request is attributed to the frame that made it, or to the first ancestor with a web address; a
  page's own requests always carry a frame.
- A cache-served app is not offered `http://` through its own scheme handler; its loopback media
  loads from the network stack, and the gate is the only check on it.
- A listener is the page's own only: a second app's page cannot load from it, because the port must
  be held by the page's own origin.

## Reversibility
- **Cost to reverse:** cheap. Remove the three sources and the gate; apps that stream from their
  own listener stop playing.
- **What would make us revisit:** the owner choosing a different route for local media (a brokered
  stream), or a loopback request the gate cannot attribute turning out to be common in ordinary
  pages.
