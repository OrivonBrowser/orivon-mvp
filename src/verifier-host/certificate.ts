// The loopback server's per-run certificate: a fresh P-256 key and a
// self-signed X.509 v3 certificate for `*.eth`, DER-encoded here. Chromium
// accepts it only because the shell's verify proc matches its fingerprint;
// the name in it decides nothing. README.md's Design notes say why this is
// not a library.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

const SEQUENCE = 0x30
const SET = 0x31
const INTEGER = 0x02
const BIT_STRING = 0x03
const OCTET_STRING = 0x04
const OID = 0x06
const UTF8_STRING = 0x0c
const UTC_TIME = 0x17
const GENERALIZED_TIME = 0x18

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2'
const COMMON_NAME = '2.5.4.3'
const SUBJECT_ALT_NAME = '2.5.29.17'

function der (tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  const n = body.length
  if (n < 0x80) return Buffer.concat([Buffer.from([tag, n]), body])
  const length = Buffer.from(n.toString(16).padStart(n > 0xffff ? 6 : n > 0xff ? 4 : 2, '0'), 'hex')
  return Buffer.concat([Buffer.from([tag, 0x80 | length.length]), length, body])
}

function oid (dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number)
  const bytes = [a * 40 + b]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let v = arc >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return der(OID, Buffer.from(bytes))
}

/** A positive INTEGER: a leading 0x00 keeps a high first bit from reading as negative. */
function positiveInteger (value: Buffer): Buffer {
  return der(INTEGER, value[0] !== undefined && value[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value)
}

/** UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires. */
function time (date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  return date.getUTCFullYear() < 2050 ? der(UTC_TIME, Buffer.from(iso.slice(2))) : der(GENERALIZED_TIME, Buffer.from(iso))
}

function commonName (name: string): Buffer {
  return der(SEQUENCE, der(SET, der(SEQUENCE, oid(COMMON_NAME), der(UTF8_STRING, Buffer.from(name)))))
}

export interface RunCertificate {
  readonly keyPem: string
  readonly certPem: string
  /** Electron's form: `sha256/` and the base64 SHA-256 of the DER. */
  readonly fingerprint: string
}

export function createRunCertificate (now = new Date(), validDays = 30): RunCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const algorithm = der(SEQUENCE, oid(ECDSA_WITH_SHA256))
  const name = commonName('Orivon .eth verifier')
  const sanDnsName = Buffer.concat([Buffer.from([0x82, 5]), Buffer.from('*.eth')])
  const tbs = der(SEQUENCE,
    der(0xa0, der(INTEGER, Buffer.from([2]))),
    positiveInteger(randomBytes(16)),
    algorithm,
    name,
    der(SEQUENCE, time(new Date(now.getTime() - 60_000)), time(new Date(now.getTime() + validDays * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, der(SEQUENCE, der(SEQUENCE, oid(SUBJECT_ALT_NAME), der(OCTET_STRING, der(SEQUENCE, sanDnsName)))))
  )
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
  const certificate = der(SEQUENCE, tbs, algorithm, der(BIT_STRING, Buffer.from([0]), signature))
  const base64 = certificate.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certPem: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    fingerprint: `sha256/${createHash('sha256').update(certificate).digest('base64')}`
  }
}
