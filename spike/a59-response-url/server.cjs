// A59 probe -- throwaway, not shipped source. See ../../docs/open-questions.md A59.
//
// Two real local servers (plain node:http/node:https, not Electron's protocol.handle)
// for net.fetch to hit from the Electron main process. Both are catch-all: every
// request gets 200 OK with a JSON body reporting exactly what the SERVER received
// (req.url, the Host header), so a probe case can cross-check the client-reported
// response.url against the server's own view of the request line.
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')

function catchAllHandler (req, res) {
  const body = JSON.stringify({ receivedUrl: req.url, receivedHost: req.headers.host ?? null })
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function listen (server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    // No host argument -- Node binds the unspecified dual-stack address (::)
    // when IPv6 is available, so 127.0.0.1, [::1] and *.localhost hostnames
    // (which Chromium resolves straight to loopback, per origin.ts) all reach
    // the same listening socket.
    server.listen(0, () => resolve(server.address().port))
  })
}

/** A throwaway self-signed cert, generated fresh per run and deleted after --
 * never checked in, never reused. SAN covers localhost/*.localhost/127.0.0.1.
 *
 * This probe does NOT disable certificate verification to make Electron
 * accept it (no `setCertificateVerifyProc`, no `rejectUnauthorized: false`):
 * `security-controls.md` forbids that unconditionally, correctly, with no
 * test-code carve-out, and this probe has no need to be the exception.
 * Instead `spkiHashBase64` (below) lets main.cjs allowlist this ONE exact
 * generated key via Chromium's `--ignore-certificate-errors-spki-list`,
 * which trusts nothing else -- a real, narrower mechanism, not a bypass. */
function makeSelfSignedCert () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orivon-a59-cert-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  const pubkeyDer = execFileSync('sh', ['-c',
    `openssl x509 -pubkey -noout -in "${certPath}" | openssl pkey -pubin -outform der`
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const spkiHashBase64 = createHash('sha256').update(pubkeyDer).digest('base64')

  return { dir, key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), spkiHashBase64 }
}

/** Starts both servers using an ALREADY-generated cert -- the SPKI hash has
 * to reach `app.commandLine.appendSwitch` before `app.whenReady()`, so
 * main.cjs generates the cert first and passes it in here rather than this
 * function making its own. */
async function startServers (certInfo) {
  const httpServer = http.createServer(catchAllHandler)
  const httpPort = await listen(httpServer)

  const httpsServer = https.createServer({ key: certInfo.key, cert: certInfo.cert }, catchAllHandler)
  const httpsPort = await listen(httpsServer)

  return {
    httpPort,
    httpsPort,
    async stop () {
      await Promise.all([
        new Promise((resolve) => httpServer.close(resolve)),
        new Promise((resolve) => httpsServer.close(resolve))
      ])
      fs.rmSync(certInfo.dir, { recursive: true, force: true })
    }
  }
}

/** Best-effort: can this environment bind a real default port (80/443) at
 * all? Answered once, directly, rather than assumed -- see A59 probe result
 * writeup for what this returned. Never throws; a bind failure is itself the
 * measurement. */
function tryBindPrivilegedPort (port) {
  return new Promise((resolve) => {
    const probe = http.createServer(catchAllHandler)
    probe.once('error', (err) => resolve({ bound: false, code: err.code ?? String(err) }))
    probe.listen(port, () => {
      probe.close(() => resolve({ bound: true, code: null }))
    })
  })
}

module.exports = { makeSelfSignedCert, startServers, tryBindPrivilegedPort }
