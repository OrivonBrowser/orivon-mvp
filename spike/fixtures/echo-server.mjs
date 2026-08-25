// Minimal TCP echo server for gate 4's concurrent-socket test. Not a
// BitTorrent peer -- just something that accepts N simultaneous connections
// and echoes back whatever it receives, so the shim's per-socket
// MessageChannelMain handling can be tested at scale without needing an
// unrealistic 100-peer local swarm.
//
// Usage: node spike/fixtures/echo-server.mjs [outJsonPath]
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'

const OUT = process.argv[2] ?? null

const server = createServer((socket) => {
  socket.on('data', (chunk) => socket.write(chunk))
  socket.on('error', () => { /* client-side disconnects are expected */ })
})

server.listen(0, '127.0.0.1', () => {
  const info = { host: '127.0.0.1', port: server.address().port }
  if (OUT !== null) writeFileSync(OUT, JSON.stringify(info, null, 2))
  console.log(JSON.stringify(info))
  console.error(`[echo-server] listening on 127.0.0.1:${info.port}`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
