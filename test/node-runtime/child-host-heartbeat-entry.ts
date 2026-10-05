// Bundled against the shim by ./e2e-child-host.test.ts as the app's own
// /heartbeat.js: a forked module writing an incrementing tick count to
// heartbeat.txt every 200ms, the way ported Node code would run a small
// daemon for the whole app rather than one page. Also logs each tick to
// stdout, which the page that forked it never drains (`silent: true`, and
// no `child.stdout` reader) even before it is orphaned -- proving a fork's
// own output posting, unlike a spawn's, never waits on the page for an ack
// (`../../src/shim/worker/runtime-fork.ts`'s `write`), so it cannot stall here
// however long the tab that started it has been gone.

import { promises as fs } from 'fs'

let count = 0

setInterval(() => {
  count += 1
  void fs.writeFile('heartbeat.txt', String(count))
  console.log(count)
}, 200)
