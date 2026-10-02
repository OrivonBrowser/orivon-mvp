# `src/main/extensions/web-request/`: the pure half of `chrome.webRequest`

**What lives here.** The decisions `../web-request-dispatch.ts` needs to serve an extension's
`chrome.webRequest` listeners, as plain functions. `filter.ts` validates the `RequestFilter` and
`extraInfoSpec` of an `addListener` call the way Chrome does and says whether a filter covers a
request. `visibility.ts` says whether an extension may see a request at all (Chrome's protected
requests, in Orivon's terms). `details.ts` builds the Chrome-shaped details an extension reads from
the details Electron's session listeners give. `merge.ts` combines the replies of several blocking
listeners into the one answer the session gets.

**What it depends on.** [`../dnr/resource-types.ts`](../dnr/resource-types.ts) (Electron's resource
types to Chrome's), [`../request-frames.ts`](../request-frames.ts) (frame ids and the initiating
origin, shared with `../dnr-webrequest.ts`) and
[`../../../broker/policy/extension-host-patterns.ts`](../../../broker/policy/extension-host-patterns.ts)'s
`matchesHostPattern`. Nothing else.

**What it must never import.** `electron` (Electron's details are described structurally), a
session, a registry or [`src/renderer/`](../../../renderer/). Whether an extension holds host access
reaches `visibility.ts` as a function, and the tab test reaches `details.ts` as one.

**Durable.** All of it: the rules are Chrome's, written against plain data.

## Design notes

**`<all_urls>` covers ws and wss in a request filter, though the shared pattern grammar leaves
them out.** `extension-host-patterns.ts` keeps WebSockets out of `<all_urls>` so a host permission
never reaches them by accident. A webRequest filter is not a permission: a blocker that filters on
`<all_urls>` expects to see WebSocket handshakes, so `filter.ts` adds the two schemes for that one
pattern and leaves every other pattern to the shared matcher. Whether the extension may then see
the request is `visibility.ts`'s question, asked against the HTTP origin the WebSocket shares.

**`windowId` is accepted and ignored.** A request carries a tab id, not a window id, and no
blocker filters on a window. The filter parses it so a listener that passes one still registers.

**A reply is merged from the original headers, not from the previous listener's.** Every listener
of a request is asked at once with the same headers, so each reply is a complete list built from
the original. `merge.ts` reads what a reply changed (the pairs it dropped and the pairs it added)
and applies those changes oldest install first, newest last. Two extensions, or two listeners of
one extension, that change different headers both take effect; where they disagree about one
header the newest install wins. A reply whose header list has a malformed entry is ignored whole.

**A redirect target is checked per extension.** A listener may send a request to the web, to a
`data:` URL, to a blank page, or to a page of its own extension; any other scheme, another
extension's pages included, is dropped before the session sees it.

**A sub_frame's initiator is its embedding document.** Electron's frame for a navigation is the
frame being navigated, so the initiating origin is read from that frame's parent; a top-level
navigation has none, as in Chrome for a navigation the person started.
