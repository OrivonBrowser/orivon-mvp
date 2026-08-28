#!/usr/bin/env node
// Independently recomputes every row of src/broker/policy/derive-vectors.json.
//
// THIS IS A VERIFIER, NOT A GENERATOR. It has no mode that writes the table.
// That is deliberate: a generator can be pointed at a failing row and re-run,
// which is precisely the move derive.test.ts's header forbids. This script can
// only ever say "the table matches an independent implementation" or "it does
// not".
//
// WHY IT EXISTS. The frozen table's whole value is that it was computed by
// something other than the code under test -- otherwise it records this
// implementation's bugs rather than catching them. Before this script that
// independence was a claim in a comment, referring to a reference
// implementation that lived on someone's disk and was never checked in. A
// prose assertion of independence is unfalsifiable, and because the table is
// frozen forever, its provenance could never be re-established later.
//
// INDEPENDENCE RULES, enforced by the self-check at the bottom of this file:
//   - node:crypto only. `hkdfSync`, plus PKCS#8 import for point derivation.
//     derive.ts uses WebCrypto (globalThis.crypto.subtle). Two stacks.
//   - This file must never import src/broker/policy/derive.ts, directly or
//     transitively. If it did, it would be checking the code against itself.
//
// WHAT IT DOES NOT CATCH, stated plainly: a change made consistently to
// derive.ts, this file and the table at once. Nothing automated can catch that.
// The controls for it are human -- the header in derive.test.ts, ADR-0010, and
// the fact that such a change shows up in review as an edit to the frozen
// table, which is the one edit a reviewer is told to reject.
//
// The construction implemented below is transcribed from ADR-0010, not from
// derive.ts. If the two disagree, that disagreement is the point of this file.

import { createPrivateKey, createPublicKey, hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TABLE = new URL('../src/broker/policy/derive-vectors.json', import.meta.url)
const DERIVE_TS = new URL('../src/broker/policy/derive.ts', import.meta.url)

/**
 * Coverage floor. Every row of the table is checked below, but "every row" is
 * vacuously true of an empty table -- an earlier version of this script printed
 * a cheerful success line and exited 0 after verifying nothing. These minimums
 * make deleting coverage as loud as changing it. Raise them when rows are
 * added; never lower them.
 */
const MINIMUM = {
  /** Distinct (label, scope, curve) tuples, not rows. */
  vectors: 7,
  publicKeys: 3,
  /** Both labels ('app', 'identity') and both curves must stay represented. */
  labels: 2,
  curves: 2,
  /**
   * Rows whose scope has a UTF-8 byte length different from its JS code-unit
   * length. Without at least two, substituting `value.length` for the byte
   * length in the info encoding passes the whole table while changing the key
   * for every non-ASCII scope. That mutation is why these rows exist.
   */
  multiByteScopes: 2
}

/** salt = "orivon-kdf-v1" (ADR-0010: the version tag rides in the salt). */
const KDF_SALT = Buffer.from('orivon-kdf-v1', 'utf8')

/** L = 48 bytes = 384 bits, reduced into [1, n-1]. */
const OKM_BYTES = 48

const CURVE_ORDER = {
  secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  'P-256': 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
}

/**
 * Published group orders in decimal, from SEC 2 v2 and FIPS 186-4 D.1.2.3.
 * Checking the hex constants against a differently-encoded published value
 * catches a transcription slip that re-reading the hex would not.
 */
const PUBLISHED_ORDER_DECIMAL = {
  secp256k1: '115792089237316195423570985008687907852837564279074904382605163141518161494337',
  'P-256': '115792089210356248762697446949407573529996955224135760342422259061068512044369'
}

/** LP(s) = uint32be(utf8ByteLength(s)) || utf8(s). BYTE length, not code units. */
function encodeField(value) {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

function derivePrivateScalar({ seed, label, scope, curve }) {
  const info = Buffer.concat([encodeField(label), encodeField(scope), encodeField(curve)])
  const okm = Buffer.from(hkdfSync('sha256', seed, KDF_SALT, info, OKM_BYTES))
  const reduced = (BigInt('0x' + okm.toString('hex')) % (CURVE_ORDER[curve] - 1n)) + 1n
  return reduced.toString(16).padStart(64, '0')
}

/**
 * P-256 point derivation via node:crypto rather than WebCrypto: build the
 * RFC 5915 ECPrivateKey with the OPTIONAL public key omitted and let OpenSSL
 * multiply the generator on import. Same trick as derive.ts, different engine.
 */
const PKCS8_P256_PREFIX = Buffer.from(
  '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420',
  'hex'
)

function derivePublicKey(request) {
  const scalar = Buffer.from(derivePrivateScalar(request), 'hex')
  const der = Buffer.concat([PKCS8_P256_PREFIX, scalar])
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  // The last 65 bytes of the SPKI encoding are the uncompressed SEC1 point.
  return createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-65).toString('hex')
}

function main() {
  const table = JSON.parse(readFileSync(TABLE, 'utf8'))
  const seed = Buffer.from(table.seed, 'hex')
  const failures = []

  // Count DISTINCT tuples, not rows. Counting rows lets five frozen tuples be
  // replaced by duplicates of the remaining two with every check still green --
  // confirmed, before this line existed.
  const tuples = new Set(
    table.vectors.map((v) => JSON.stringify([v.label, v.scope, v.curve]))
  )
  if (tuples.size !== table.vectors.length) {
    failures.push(
      `the table has ${table.vectors.length} rows but only ${tuples.size} distinct ` +
        '(label, scope, curve) tuples. A duplicated row is deleted coverage wearing a disguise.'
    )
  }
  if (tuples.size < MINIMUM.vectors) {
    failures.push(
      `the table has ${tuples.size} distinct tuples, below the floor of ${MINIMUM.vectors}. ` +
        'Rows are never removed -- see the header of derive.test.ts.'
    )
  }
  for (const [field, floor] of [
    ['label', MINIMUM.labels],
    ['curve', MINIMUM.curves]
  ]) {
    const distinct = new Set(table.vectors.map((v) => v[field])).size
    if (distinct < floor) {
      failures.push(
        `the table covers ${distinct} distinct ${field}s, below the floor of ${floor}. ` +
          'Both labels and both curves must stay pinned.'
      )
    }
  }
  const points = table.vectors.filter((v) => v.publicKey !== undefined).length
  if (points < MINIMUM.publicKeys) {
    failures.push(
      `${points} rows carry a publicKey, below the floor of ${MINIMUM.publicKeys}. ` +
        'A row keeps its point: the scalar alone does not pin the bytes an app receives.'
    )
  }
  const multiByte = table.vectors.filter(
    (v) => Buffer.byteLength(v.scope, 'utf8') !== v.scope.length
  ).length
  if (multiByte < MINIMUM.multiByteScopes) {
    failures.push(
      `${multiByte} rows have a multi-byte scope, below the floor of ` +
        `${MINIMUM.multiByteScopes}. An all-ASCII table cannot tell a UTF-8 byte length ` +
        'from a code-unit length.'
    )
  }

  // Check the constants THIS script uses against the published decimals...
  for (const [curve, decimal] of Object.entries(PUBLISHED_ORDER_DECIMAL)) {
    if (CURVE_ORDER[curve] !== BigInt(decimal)) {
      failures.push(`curve order for ${curve} does not match the published value`)
    }
  }

  // ...and then check derive.ts's OWN constants against them too, by reading
  // the source text. Comparing only this file's copy would verify a duplicate
  // and prove nothing about the implementation -- which is exactly what an
  // earlier version did while a comment in derive.ts claimed otherwise.
  // Reading the text rather than importing the module keeps the two
  // implementations independent.
  const deriveSource = readFileSync(DERIVE_TS, 'utf8')
  for (const [curve, decimal] of Object.entries(PUBLISHED_ORDER_DECIMAL)) {
    const key = curve === 'P-256' ? "'P-256'" : curve
    // Global, and require EXACTLY ONE hit. `.exec` returns the first match
    // anywhere in the file including comments, so a correct-looking decoy in a
    // comment above a corrupted constant would satisfy this check -- confirmed,
    // before this was made global.
    const hits = [...deriveSource.matchAll(new RegExp(`${key}:\\s*(0x[0-9a-fA-F]+)n`, 'g'))]
    if (hits.length !== 1) {
      failures.push(
        `expected exactly one ${curve} order constant in derive.ts, found ${hits.length}. ` +
          'A second occurrence (even in a comment) makes this check ambiguous.'
      )
      continue
    }
    if (BigInt(hits[0][1]) !== BigInt(decimal)) {
      failures.push(
        `derive.ts's ${curve} order does not match the published value\n` +
          `    derive.ts  ${hits[0][1]}\n    published  0x${BigInt(decimal).toString(16)}`
      )
    }
  }

  for (const vector of table.vectors) {
    const request = {
      seed,
      label: vector.label,
      scope: vector.scope,
      curve: vector.curve
    }
    const where = `${vector.curve} ${vector.label}/${JSON.stringify(vector.scope)}`

    const scalar = derivePrivateScalar(request)
    if (scalar !== vector.scalar) {
      failures.push(`${where}\n    scalar expected ${vector.scalar}\n           recomputed ${scalar}`)
    }

    if (vector.publicKey !== undefined) {
      const publicKey = derivePublicKey(request)
      if (publicKey !== vector.publicKey) {
        failures.push(
          `${where}\n    publicKey expected ${vector.publicKey}\n              recomputed ${publicKey}`
        )
      }
    }
  }

  // Independence tripwire: this file must not execute any src/broker/policy/
  // module. Widened 2026-08-27 from matching derive.ts by name to matching the
  // whole directory: derive.ts is about to be split into derive.ts plus
  // derive-encoding.ts/derive-p256.ts, and a name-specific regex would stop
  // matching the moment encodeField lives in a sibling file -- silently
  // reopening exactly the hole this check exists to close. It catches a
  // static or dynamic import, which is the form someone would reach for by
  // accident or convenience. It is NOT a sandbox -- createRequire, an odd path
  // spelling or importing the built output all evade it, and are meant to be
  // caught in review instead. Reading derive.ts as TEXT above is fine and
  // deliberate: it checks a constant without running the code.
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  if (/(?:from|import\s*\()\s*['"][^'"]*\/policy\/[^'"]*['"]/.test(self)) {
    failures.push('check-vectors.mjs imports from src/broker/policy/, so it is no longer an independent check')
  }

  if (failures.length > 0) {
    console.error('Golden vectors do NOT match the independent reference implementation:\n')
    for (const failure of failures) console.error(`  ${failure}\n`)
    console.error(
      'A mismatch means the frozen KDF changed, or this reference drifted from ADR-0010.\n' +
        'Do NOT edit derive-vectors.json to make this pass. See the header of\n' +
        'src/broker/policy/derive.test.ts and ADR-0010.'
    )
    process.exit(1)
  }

  console.log(
    `Golden vectors match an independent node:crypto implementation: ` +
      `${table.vectors.length} scalars, ${points} public keys, ` +
      `${multiByte} multi-byte scopes, 2 curve orders (checked in derive.ts too).`
  )
}

main()
