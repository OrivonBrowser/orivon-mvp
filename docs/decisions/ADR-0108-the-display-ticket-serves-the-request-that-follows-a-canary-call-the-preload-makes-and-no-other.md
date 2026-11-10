# ADR-0108: The display ticket serves the request that follows a canary call the preload makes, and no other

- **Status:** accepted
- **Date:** 2026-11-10
- **Type:** security
- **Decided by:** AI recommendation accepted by default; narrows how ADR-0055 picks the one request a ticket allows

## Decision

In the step where the tab's preload arms a share's ticket it makes two calls, one after the other, with nothing
between them: a canary, which is its own world's `getDisplayMedia({ video: true })`, and then the real call of
ADR-0061 in the page's world. Under an open ticket main refuses the first request it sees at once, holds the next
until the preload reports that its canary was refused (at most `CANARY_WAIT_MS`, 1 s, provisional), and allows only the
request that follows that report, when the preload has also said its call was made and no other request arrived
for the quiet window. A page that makes a display request of its own in that step is refused along with the real
call. Everything else in ADR-0055 and ADR-0061 stands, including ending the renderer of a tab whose unconfirmed share
is refused, which is now the second line.

## Context

Electron 44 hands main the page's `getDisplayMedia`, a legacy `getUserMedia({ chromeMediaSource })` and the
preload's own call as the same request, with no frame request id and none of the options (ADR-0055). ADR-0055 told
the preload's call apart by counting: a ticket allowed exactly one request, and a second one, which could only be a
page's, voided the ticket.

That rule assumed main could hold two requests of a frame at once. It cannot. Blink queues a frame's display requests
in order and starts the next one only after the previous one was answered (`MediaDevices::getDisplayMedia` and the
user media client's request queue, read in Chromium's source; the legacy `chromeMediaSource` desktop and tab requests
take the same queue, and camera and microphone requests another), so a page's request made ahead of the preload's step
is answered before the preload's request is sent. It can also reach main late, after the ticket opened, when the
browser process is busy, and then it is the one request the ticket allows: the page is served the screen, the
preload's own request meets no ticket, and only then does the unconfirmed-share check end the page's renderer.

Measured on the 12-core server that runs the gates, with a page that calls a native `getDisplayMedia` taken from a
fresh frame and the wrapped call in the same step, 40 launches of the code before this decision: 14 handed the page a
live stream, a page that asked `ImageCapture` for a frame got one of 1280x1024 pixels of the screen in 4 of those, and
the renderer was gone 0.6 to 2.0 s after the stream was served. With a page that held its own thread busy for 4 s
after it got the stream, 11 of 40 launches were served, and in 8 of them main could end the renderer only 4.2 to 4.5 s
later. The end-to-end spec for the case failed about 2 runs in 30 on that machine for the same reason.

## Alternatives considered

- **End the renderer sooner, or on every refused request.** The end is a signal to the renderer process, and measured it
  takes up to 1.2 s under load and longer for a page that blocks. Any stream served in that time can be read, so
  the end can only be a second line.
- **Refuse at Chromium's ask, by who made the request.** Electron gives the permission handler the same fields for
  every display request of a frame and none of the call's options, so there is no mark to refuse on.
- **Count requests, or lengthen the quiet window.** Blink answers the page's request before the preload's is sent, so
  main never has two to count, and a longer window only moves where the late request lands.
- **Capture in a hidden page and hand the website a copy.** Rejected in ADR-0055 for what it costs every share.
- **Tell the requests apart in the preload.** The preload cannot see a request the page makes with a native method taken
  from a fresh frame, which never meets the wrapper, and that is the request that matters.

## Reasoning

The canary gives the preload's calls a position that main can recognise: the real call is the request that comes after
the one the preload reports refused. Blink's order means a request the page made earlier has been answered by then,
and making both calls in one synchronous step means no request of the page's can be queued between them, so the
request after the report is the real call whichever order the report and the request reach main. A page that tries
to get its own request into the real call's place ends the ticket instead: its request is the first, so the canary
waits behind it for a report that cannot come, and the wait ends the ticket. The request is refused before a
stream exists, so there is no moment in which the page holds one.

## Consequences

- A share costs one more request, which main refuses and the page never sees.
- A page that makes its own display request in the same step as its wrapped call is refused both, after at most
  `CANARY_WAIT_MS` for the wrapped call. Pages call through the wrapper, so this reaches a hostile page and a
  content script that races the page's call.
- The rule rests on two facts that Chromium does not promise: a frame's display requests are answered in order, one at a
  time, and a synchronous step queues both calls before anything else can run. The unit tests state both as the
  preload's order and main's order, `e2e-screen-share-gate` fails if either stops holding, and the unconfirmed-share
  check stays as the backstop.
- `QUIET_WINDOW_MS`, `CANARY_WAIT_MS` and the 50 ms slack that let a request overtake the arm message are not needed
  to tell the requests apart any more. The slack is gone.

## Reversibility

- **Cost to reverse:** cheap. The canary and the report are two functions in two files, and the previous counting
  rule is what remains if they are removed.
- **What would make us revisit:** Electron passing a per-request identity (a frame request id or the call's
  options) to the permission handler, which would let main refuse by who asked; or a measured honest share refused
  by `CANARY_WAIT_MS`.
