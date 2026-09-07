#!/usr/bin/env node
// A local UDP echo server: send it a datagram, get the same bytes back from
// wherever it was bound. The UDP counterpart of apps/fixture/echo-server.mjs,
// living under test/ rather than apps/fixture/ because apps/fixture/ belongs
// to the `fixture-app` stream (docs/development/parallel-work.md's ownership
// map) and this is the `broker` stream's own e2e fixture.
//
// PRINTS A READY LINE ON STDOUT, and the test waits for it. There is no UDP
// equivalent of "poll a connect until it succeeds" -- a datagram to an unbound
// port is silently discarded, so a probe cannot tell "not up yet" from "up and
// ignoring me", which is exactly the ambiguity a fixed sleep would paper over.
import { createSocket } from 'node:dgram'

const port = Number.parseInt(process.argv[2] ?? '0', 10)
const host = process.argv[3] ?? '127.0.0.1'

const socket = createSocket('udp4')

socket.on('message', (data, rinfo) => {
  socket.send(data, rinfo.port, rinfo.address)
})

socket.on('error', (error) => {
  console.error(`[udp-echo] failed: ${error.message}`)
  process.exitCode = 1
  socket.close()
})

socket.bind(port, host, () => {
  const bound = socket.address()
  console.log(`[udp-echo] listening on ${bound.address}:${bound.port}`)
})

function shutdown () {
  socket.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
