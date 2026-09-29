// Bundled against the shim by ./e2e-child-host.test.ts as the app's own
// /heartbeat.js: a forked module writing an incrementing tick count to
// heartbeat.txt every 200ms, the way ported Node code would run a small
// daemon for the whole app rather than one page.

import { promises as fs } from 'fs'

let count = 0

setInterval(() => {
  count += 1
  void fs.writeFile('heartbeat.txt', String(count))
}, 200)
