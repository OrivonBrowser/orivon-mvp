#!/usr/bin/env node
// A plain static file server for the prepared FreeTube build. It reads files
// off disk and returns them; it holds no state, talks to nothing, and knows
// nothing about Orivon. Everything Orivon-specific was baked in by
// ./prepare.mjs, so this stays the dumb half on purpose.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const HOST = '127.0.0.1'
const portIndex = process.argv.indexOf('--port')
const PORT = portIndex === -1 ? 8875 : Number(process.argv[portIndex + 1])
const DEFAULT_ROOT = '/home/jhon/git/freetube-src/dist/orivon-web'

const rootIndex = process.argv.indexOf('--root')
const ROOT = normalize(rootIndex === -1 ? DEFAULT_ROOT : process.argv[rootIndex + 1]).replace(/[/\\]$/, '')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

function resolveRequestPath (pathname) {
  const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
  const resolved = normalize(join(ROOT, decoded))
  if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) return null
  return resolved
}

async function sendFile (res, filePath) {
  const body = await readFile(filePath)
  const type = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type }).end(body)
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
    await sendFile(res, filePath)
  } catch {
    // Ordinary single-page-app hosting: a path with no file extension is a
    // client-side route, not a missing asset. A request that names an
    // extension still 404s, so a genuinely missing script stays visible
    // instead of being answered with HTML.
    if (extname(filePath) === '') {
      try {
        await sendFile(res, join(ROOT, 'index.html'))
        return
      } catch { /* fall through to 404 */ }
    }
    res.writeHead(404).end('not found')
  }
}

const server = createServer((req, res) => { void handleRequest(req, res) })

server.on('error', (error) => {
  console.error(`[freetube-real] failed to start: ${error.message}`)
  process.exitCode = 1
})

server.listen(PORT, HOST, () => {
  console.log(`[freetube-real] serving ${ROOT} on http://${HOST}:${PORT}`)
})

function shutdown () { server.close(() => process.exit(0)) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
