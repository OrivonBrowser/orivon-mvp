// A throwaway CA and leaf certificate, generated fresh per test run via the
// system `openssl` binary -- never committed (npm run check:secrets would,
// rightly, fail a build that tried). This is fixture generation, not
// production code: ./tls-adapter.ts never shells out to anything, and
// nothing here is imported by it.
//
// The leaf's SAN is DNS:localhost ONLY -- no IP SAN for 127.0.0.1. That one
// fact is what lets ./tls-adapter.test.ts prove BOTH directions against the
// exact same running server: dialling 'localhost' (which resolves to the
// loopback address the server is bound to) passes hostname verification,
// and dialling '127.0.0.1' -- the identical TCP peer -- fails it, because
// the certificate does not name that literal. No DNS trickery, no hosts
// file, just the one thing a certificate's SAN list actually promises.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TlsFixture {
  readonly caCert: string
  readonly leafCert: string
  readonly leafKey: string
}

/** Runs once per test file (see ./tls-adapter.test.ts's beforeAll) -- openssl is not free, and every case in that file trusts the same CA. */
export function generateTlsFixture (): TlsFixture {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-tls-fixture-'))
  const run = (args: string[]): void => { execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' }) }

  run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca-key.pem', '-out', 'ca-cert.pem',
    '-days', '2', '-nodes', '-subj', '/CN=Orivon Test CA'])
  run(['req', '-newkey', 'rsa:2048', '-keyout', 'leaf-key.pem', '-out', 'leaf.csr',
    '-nodes', '-subj', '/CN=localhost'])
  // A real file, not `/dev/stdin` -- not every sandbox exposes that device,
  // and this fixture only needs to exist for the length of this function.
  writeFileSync(join(dir, 'leaf.ext'), 'subjectAltName=DNS:localhost\n')
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca-cert.pem', '-CAkey', 'ca-key.pem',
    '-CAcreateserial', '-out', 'leaf-cert.pem', '-days', '2', '-extfile', 'leaf.ext'])

  const fixture: TlsFixture = {
    caCert: readFileSync(join(dir, 'ca-cert.pem'), 'utf8'),
    leafCert: readFileSync(join(dir, 'leaf-cert.pem'), 'utf8'),
    leafKey: readFileSync(join(dir, 'leaf-key.pem'), 'utf8')
  }
  // Everything needed is already read into memory above -- the private key
  // material has no reason to keep sitting on disk for the rest of the test
  // run. Best-effort: a cleanup failure here must not fail a test that never
  // touched this directory again.
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup only */ }
  return fixture
}
