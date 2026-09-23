// Throwaway certificates, generated fresh per test run via the system
// `openssl` binary -- never committed (npm run check:secrets would, rightly,
// fail a build that tried). This is fixture generation, not production code:
// ./tls-adapter.ts never shells out to anything, and nothing here is imported
// by it.
//
// Every server leaf's SAN is DNS:localhost ONLY -- no IP SAN for 127.0.0.1.
// That one fact is what lets the tests prove BOTH directions against the
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

/** A leaf that signs itself: what an Electrum server or a LAN node typically presents. */
export interface SelfSignedFixture {
  readonly cert: string
  readonly key: string
}

/** A client certificate signed by its own CA, in every form an app may hand `connectSecure`. */
export interface ClientCertFixture {
  readonly caCert: string
  readonly cert: string
  readonly key: string
  /** `key`, encrypted under `passphrase`. */
  readonly encryptedKey: string
  /** `cert` and `key` as a PKCS#12 bundle, encrypted under `passphrase`. */
  readonly pfx: Uint8Array
  readonly passphrase: string
  /** The CN the server should see. */
  readonly commonName: string
}

/** Runs `build` in a fresh temp directory with an `openssl` runner, then removes the directory: private keys have no reason to stay on disk once read. */
function inOpensslDir<T> (build: (run: (args: string[]) => void, read: (name: string) => string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-tls-fixture-'))
  const run = (args: string[]): void => { execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' }) }
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8')
  try {
    return build(run, read, dir)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup only */ }
  }
}

/** A CA, and a leaf it signed with `extension` (a file, not `/dev/stdin`: not every sandbox exposes that device). */
function caAndLeaf (run: (args: string[]) => void, dir: string, prefix: string, subject: string, extension: string): void {
  run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', `${prefix}ca-key.pem`, '-out', `${prefix}ca-cert.pem`,
    '-days', '2', '-nodes', '-subj', `/CN=Orivon Test ${prefix}CA`])
  run(['req', '-newkey', 'rsa:2048', '-keyout', `${prefix}leaf-key.pem`, '-out', `${prefix}leaf.csr`,
    '-nodes', '-subj', subject])
  writeFileSync(join(dir, `${prefix}leaf.ext`), extension)
  run(['x509', '-req', '-in', `${prefix}leaf.csr`, '-CA', `${prefix}ca-cert.pem`, '-CAkey', `${prefix}ca-key.pem`,
    '-CAcreateserial', '-out', `${prefix}leaf-cert.pem`, '-days', '2', '-extfile', `${prefix}leaf.ext`])
}

/** Runs once per test file -- openssl is not free, and every case in a file trusts the same CA. */
export function generateTlsFixture (): TlsFixture {
  return inOpensslDir((run, read, dir) => {
    caAndLeaf(run, dir, '', '/CN=localhost', 'subjectAltName=DNS:localhost\n')
    return { caCert: read('ca-cert.pem'), leafCert: read('leaf-cert.pem'), leafKey: read('leaf-key.pem') }
  })
}

export function generateSelfSignedFixture (): SelfSignedFixture {
  return inOpensslDir((run, read) => {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '2', '-nodes',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'])
    return { cert: read('cert.pem'), key: read('key.pem') }
  })
}

export function generateClientCertFixture (): ClientCertFixture {
  const passphrase = 'orivon-test-passphrase'
  const commonName = 'orivon-test-client'
  return inOpensslDir((run, read, dir) => {
    caAndLeaf(run, dir, 'client-', `/CN=${commonName}`, 'extendedKeyUsage=clientAuth\n')
    run(['pkey', '-in', 'client-leaf-key.pem', '-out', 'encrypted-key.pem', '-aes256', '-passout', `pass:${passphrase}`])
    run(['pkcs12', '-export', '-in', 'client-leaf-cert.pem', '-inkey', 'client-leaf-key.pem', '-out', 'client.p12',
      '-passout', `pass:${passphrase}`])
    return {
      caCert: read('client-ca-cert.pem'),
      cert: read('client-leaf-cert.pem'),
      key: read('client-leaf-key.pem'),
      encryptedKey: read('encrypted-key.pem'),
      pfx: new Uint8Array(readFileSync(join(dir, 'client.p12'))),
      passphrase,
      commonName
    }
  })
}
