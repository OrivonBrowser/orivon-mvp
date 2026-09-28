// Bundled against the shim by ./e2e-child-process.test.ts as the app's
// /child.js: a module ported Node code would fork, using `fs` and IPC.

import { promises as fs } from 'fs'

process.on('message', (received: unknown) => {
  const message = received as { text?: string, exit?: number }
  if (message.exit !== undefined) process.exit(message.exit)
  void fs.writeFile('forked.txt', message.text ?? '').then(() => {
    process.send?.({ argv: process.argv.slice(1), wrote: true })
  })
})
