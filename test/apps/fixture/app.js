// The fixture app's whole frontend. Deliberately framework-free and
// build-step-free, and written directly against orivon.net.connect()
// (src/contracts/capability-api.ts) rather than any orivon-node-shim API --
// the shim (build step 3) does not exist yet.
//
// This app has no real broker behind it when run standalone (no Electron,
// no app loader): `window.orivon` is simply absent in that case, and this
// page shows that state rather than throwing. See apps/fixture/README.md
// "Running it standalone" for what that looks like.

const statusEl = document.getElementById('status')
const resultEl = document.getElementById('result')

function setStatus (text) {
  statusEl.textContent = text
}

/**
 * Reads the one net.connect target this app's manifest declares, from the
 * manifest itself -- fetched over plain HTTP, which works whether or not an
 * Orivon runtime is present. The host:port is deliberately not also
 * hardcoded here: two copies of the same fact is exactly what
 * code-guidelines.md Rule 3 warns about, and here it would mean the page and
 * .well-known/orivon.json could silently drift apart.
 */
async function readConnectTarget () {
  const response = await fetch('/.well-known/orivon.json')
  const manifest = await response.json()
  const patterns = manifest.capabilities?.net?.tcp?.connect ?? []
  const pattern = patterns[0]
  if (typeof pattern !== 'string') {
    throw new Error('manifest declares no capabilities.net.tcp.connect pattern')
  }
  const split = pattern.lastIndexOf(':')
  return { host: pattern.slice(0, split), port: Number.parseInt(pattern.slice(split + 1), 10) }
}

/**
 * Connects, writes one message, and reads back exactly as many bytes as
 * were sent -- the echo server writes back whatever it reads, with no
 * framing, so the byte count is the only way to know the reply is complete.
 */
async function roundTrip (host, port) {
  const socket = await window.orivon.net.connect({ host, port })
  const message = `hello from the fixture app at ${new Date().toISOString()}`
  const sentBytes = new TextEncoder().encode(message)

  const writer = socket.writable.getWriter()
  await writer.write(sentBytes)
  await writer.close()

  const reader = socket.readable.getReader()
  let received = new Uint8Array(0)
  while (received.length < sentBytes.length) {
    const { value, done } = await reader.read()
    if (done) break
    const merged = new Uint8Array(received.length + value.length)
    merged.set(received)
    merged.set(value, received.length)
    received = merged
  }
  await socket.close()

  return { sent: message, received: new TextDecoder().decode(received) }
}

async function main () {
  const { host, port } = await readConnectTarget()

  if (typeof window.orivon === 'undefined') {
    setStatus(
      `No Orivon runtime detected in this tab -- this app would connect to ${host}:${port} ` +
      'if loaded through the Orivon app loader and granted its one declared capability. ' +
      'See apps/fixture/README.md.'
    )
    return
  }

  setStatus(`Orivon runtime detected. Connecting to ${host}:${port}...`)
  try {
    const { sent, received } = await roundTrip(host, port)
    setStatus('Round trip complete.')
    resultEl.textContent = `sent:     ${sent}\nreceived: ${received}\nmatch:    ${sent === received}`
  } catch (error) {
    setStatus('Connect failed.')
    resultEl.textContent = error instanceof Error ? error.message : String(error)
  }
}

main().catch((error) => {
  setStatus('Fixture app failed to start.')
  resultEl.textContent = error instanceof Error ? error.message : String(error)
})
