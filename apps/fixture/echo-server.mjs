#!/usr/bin/env node
// A local TCP echo server: write to it, read back exactly what you wrote.
// This is what the fixture app's one granted capability
// (net.connect -> 127.0.0.1:ECHO_PORT, declared in .well-known/orivon.json)
// targets, and later what the fixture's e2e test asserts against.
//
// No framing, no protocol -- every byte read is written straight back, in
// the order it arrived, for as long as the socket stays open.
import { createServer } from 'node:net'
import { ECHO_PORT, HOST } from './config.mjs'

const server = createServer((socket) => {
  socket.on('data', (chunk) => socket.write(chunk))
  // A client disconnecting mid-write is an ordinary event for a fixture like
  // this one, not a bug -- logging it would just be noise on every test run.
  socket.on('error', () => {})
})

server.on('error', (error) => {
  console.error(`[echo-server] failed to start: ${error.message}`)
  process.exitCode = 1
})

server.listen(ECHO_PORT, HOST, () => {
  console.log(`[echo-server] listening on ${HOST}:${ECHO_PORT}`)
})

function shutdown () {
  server.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
