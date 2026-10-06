# ADR-0061: The page's share call runs in its own world so its CaptureController binds

- **Status:** accepted
- **Date:** 2026-10-06
- **Type:** security
- **Decided by:** AI recommendation, accepted by default; narrows how ADR-0055 makes the call

## Decision

The real `getDisplayMedia` call of a share is made in the page's own world, by a closure the tab's preload
wrapper builds in the same step that wraps the method, and the preload's isolated world starts it. Everything
else in ADR-0055 stands: the wrapper asks for the picker, main opens a one-shot ticket after the person picks, and
the isolated world arms it, sends `called`, and reports `received`, `failed` and `tracks-ended`. What changes is
the realm of the one native call.

- **Natives captured first.** At document start the wrapper captures `Reflect.apply`, `Promise.prototype.then`,
  `Document.prototype.createElement`, the `srcObject` setter, the `name` and `message` getters of
  `DOMException.prototype`, `Object.create`, the `DOMException` and `TypeError` constructors and the stream and
  track methods it needs, before any page script runs. The call and the reading of its outcome use only these.
- **The page's options become data.** When the page calls, the wrapper reads `video`, `audio`, `controller` and
  the hints once, and builds the real options as an object with no prototype: `video` and `audio` are copies made
  of objects with no prototype and no accessor (an array carries an iterator of its own), and the controller is
  passed as given, so the browser's own brand check accepts or refuses it. Converting these options when the
  call is made reads data and runs no page code.
- **One call, in the arming step.** The isolated world sends `arm` and then calls the closure in the same
  synchronous step, through the bridge. The closure calls the captured native once, on the page's
  `MediaDevices`, and hands the isolated world the outcome: a detached `<video>` holding the stream, or the name and
  message of the refusal, read with the captured getters. It keeps the stream for the page, and the isolated world
  keeps the tracks as before, so Stop and the end of a share work as in ADR-0055.
- **The outcome is not the page's to forge.** The closure reads the native promise with the captured `then`, after
  giving that promise a constructor and species of its own, so a changed `Promise.prototype` is never consulted.
  The isolated world's answer comes back to the closure as the return value of a bridge call, in the turn the
  call settled, and settles the page's promise there: a refusal becomes the page's error with the browser's own
  name, and a share the isolated world could not confirm has its tracks stopped.

## Context

A `CaptureController` binds to the capture only when it is in the options of the call that starts it. The wrapper
made the call in the isolated world, which cannot receive the page's controller (a controller is not a type the
context bridge carries, and no DOM property carries one), so a page's controller never bound. Chromium then
answers `getSupportedZoomLevels()` and `forwardWheel` with `InvalidStateError: Not actively capturing.`, so
Captured Surface Control, and with it the presentation setup of sites that use it, failed for every site. A
meeting site showed a black tile where the presenter's own presentation belonged.

## Alternatives considered

- **Keep the call in the isolated world and proxy the controller's methods.** The page's own object would have
  to be replaced by a wrapper that forwards to a second controller, which can only ever be a copy of the
  platform's behaviour and breaks the first time Chromium adds a method.
- **Let the page make the call and have main recognise it.** The gate could then not tell Orivon's call from the
  page's, which is the property ADR-0055 exists to give.
- **Return the native promise to the page itself.** The call would have to be made before the person picks, with
  main holding the request. That rebuilds the ticket and the picker's lifecycle and is a decision of its own.

## Reasoning

The ticket remains the only fact main trusts, and what it trusts is still a call made by Orivon's code, from
natives captured before any page script, in the step that armed it. No page code runs inside the call: the
options have no prototype and no accessor, the controller is checked by the browser, and the outcome is read through
captured natives, so a page cannot turn a refusal into another name or a success into a refusal. A page request
that races the call is handled by the ticket exactly as before. The page can still see and change its own
`getDisplayMedia`, as it could, and a call that goes around the wrapper meets no ticket.

## Consequences

- A page's `CaptureController` binds: zoom levels, zoom level and wheel forwarding work for a tab share, and a
  screen share answers `NotSupportedError` as it does in Chrome.
- `setFocusBehavior` is refused as too late. Chromium closes the window for the focus decision in the
  microtask after the call's promise resolves, and the page's promise is Orivon's, resolved in that first
  microtask, so the page's callbacks run after the window has closed (measured). The browser then focuses the
  shared surface as it does when a page makes no choice. A page that calls it gets `InvalidStateError`.
- The page's promise is a native promise made by the wrapper, not the one the browser returned.
- The wrapper depends on more natives that must exist; where one is missing it installs nothing, and the page's
  call meets no ticket and is refused.

## Reversibility

- **Cost to reverse:** cheap. The call moves back to the isolated world and the controller stops binding.
- **What would make us revisit:** the context bridge carrying a `CaptureController`, or Chromium keeping the
  focus window open until the page's callbacks have run; either lets the call stay in the isolated world or the
  focus choice work.
