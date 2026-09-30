// A small express and socket.io server, written the way a ported one is: it
// imports 'http', 'fs' and friends by their Node names and is bundled against
// the shim. Prints the port it listens on.

import { Buffer } from 'buffer'
import { prepareOrivon } from './express-socketio-host.mjs'
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'

globalThis.Buffer = Buffer
globalThis.orivon = await prepareOrivon()

const app = express()
app.use(express.json())
app.get('/api/hello', (req, res) => { res.json({ hello: 'world', query: req.query }) })
app.post('/api/echo', (req, res) => { res.status(201).json({ received: req.body }) })
app.use(express.static('/orivon/app/public'))

const server = http.createServer(app)
const io = new Server(server)
io.on('connection', (socket) => {
  socket.emit('welcome', { id: socket.id, transport: socket.conn.transport.name })
  socket.on('add', (a, b, ack) => { ack(a + b) })
  socket.on('shout', (text) => { io.emit('shouted', String(text).toUpperCase()) })
  socket.on('blob', (bytes, ack) => { ack(bytes.length) })
})
server.listen(0, '127.0.0.1', () => { console.log(`PORT ${server.address().port}`) })
