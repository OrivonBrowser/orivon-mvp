// Tiny plain-node HTTP server for the net.fetch/extensions probe. Not part
// of Electron at all -- just a target to fetch, on 127.0.0.1, so we can see
// whether a request from the Electron process under test actually arrived.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] || 19457)
const logFile = process.argv[3] || '/tmp/netfetch-probe-server.log'

const server = createServer((req, res) => {
  const entry = { t: Date.now(), method: req.method, url: req.url, headers: req.headers }
  appendFileSync(logFile, JSON.stringify(entry) + '\n')
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`probe-server listening on 127.0.0.1:${port}, logging to ${logFile}`)
})
