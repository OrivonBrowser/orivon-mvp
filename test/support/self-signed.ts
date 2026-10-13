// A self-signed certificate for fixture host names, and the key hash Chromium is told to trust it by
// (`--ignore-certificate-errors-spki-list`), for a spec that needs an https website on loopback.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function selfSigned (dir: string, names: readonly string[]): { cert: string, key: string, spki: string } {
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${names[0] ?? 'localhost'}`, '-addext', `subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}`, '-keyout', key, '-out', cert, '-days', '1'], { stdio: 'pipe' })
  const pem = execFileSync('openssl', ['x509', '-pubkey', '-noout', '-in', cert], { stdio: 'pipe' })
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pem, stdio: 'pipe' })
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8'), spki: createHash('sha256').update(der).digest('base64') }
}
