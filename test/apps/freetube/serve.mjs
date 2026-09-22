#!/usr/bin/env node
// Serves this directory over plain HTTP so the app can be opened the way any
// real Orivon app is: over a URL, with its manifest at /.well-known/orivon.json.
//
// This is a DEVELOPMENT server only, and it is not the path an installed app
// takes. A loopback origin can never complete a real install: the loader
// refuses any install origin that does not resolve as public unicast, with no
// exception for loopback, because the only discovery trigger is a hint in a
// page the browser already loaded. See README.md's "Running it".
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST, STATIC_PORT } from './config.mjs'

const portIndex = process.argv.indexOf('--port')
const PORT = portIndex === -1 ? STATIC_PORT : Number(process.argv[portIndex + 1])

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[/\\]$/, '')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

function resolveRequestPath (pathname) {
  const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
  const resolved = normalize(join(ROOT, decoded))
  if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) return null
  return resolved
}

async function handleRequest (req, res) {
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  const filePath = resolveRequestPath(url.pathname)
  if (filePath === null) {
    res.writeHead(400).end('bad path')
    return
  }
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
    const body = await readFile(filePath)
    const type = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type }).end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}

const server = createServer((req, res) => { void handleRequest(req, res) })

server.on('error', (error) => {
  console.error(`[freetube-server] failed to start: ${error.message}`)
  process.exitCode = 1
})

server.listen(PORT, HOST, () => {
  console.log(`[freetube-server] serving ${ROOT} on http://${HOST}:${PORT}`)
})

function shutdown () { server.close(() => process.exit(0)) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
