#!/usr/bin/env node
// Serves apps/fixture/ itself over plain HTTP -- the frontend's static
// assets and .well-known/orivon.json -- so a loader or a browser can fetch
// this app the way any real Orivon app is fetched, over real localhost HTTP.
// No framework: a small MIME-type map and a file read.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST, STATIC_PORT } from './config.mjs'

// fileURLToPath on a directory URL keeps the trailing separator, which would
// make every ROOT + sep comparison below look for a DOUBLE separator and
// reject every direct child -- stripped here so resolveRequestPath's checks
// mean what they say.
const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[/\\]$/, '')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

/**
 * Maps a request pathname to a file inside ROOT, or null if it would resolve
 * outside it. Not the broker's fs capability -- this is a test fixture with
 * no security boundary of its own to defend -- but there is no reason to let
 * it serve outside its own directory either.
 */
function resolveRequestPath (pathname) {
  const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
  const resolved = normalize(join(ROOT, decoded))
  if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) return null
  return resolved
}

const server = createServer((req, res) => {
  void handleRequest(req, res)
})

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

server.on('error', (error) => {
  console.error(`[fixture-server] failed to start: ${error.message}`)
  process.exitCode = 1
})

server.listen(STATIC_PORT, HOST, () => {
  console.log(`[fixture-server] serving ${ROOT} on http://${HOST}:${STATIC_PORT}`)
})

function shutdown () {
  server.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
