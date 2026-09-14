/**
 * Fails the build if src/contracts/manifest.ts declares an interface field
 * the loader's own manifest parser does not list in its allowlist.
 *
 * Both sides are read from their REAL source text, never copied into this
 * script -- a list compared against a second hand-typed list is just a
 * third list to forget. This is exactly how A164 and the consentGranularity
 * gap happened (docs/open-questions.md A164): a contract interface grew a
 * field its loader-side allowlist never learned about, twice in one day,
 * and nothing noticed until a real manifest hit it.
 *
 * A field the loader deliberately does not accept YET is not a bug, but it
 * must be named in DELIBERATELY_DEFERRED below, with a reason -- otherwise
 * this check cannot tell "on purpose" from "forgotten" and fails closed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

export const CONTRACT_FILE = 'src/contracts/manifest.ts'

/**
 * Every interface this check ties to the loader's own field allowlist, and
 * which array in which loader file is supposed to accept its keys. A
 * brand-new capability interface (not just a new field on an existing one)
 * needs a new row here as well as new loader code -- that is a structural
 * addition on both sides, not the silent-drift failure mode this check
 * exists for.
 */
export const PARITY_MAP = [
  { interfaceName: 'Manifest', loaderFile: 'src/loader/manifest.ts', arrayName: 'MANIFEST_KEYS' },
  { interfaceName: 'Capabilities', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'CAPABILITIES_KEYS' },
  { interfaceName: 'NetCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'NET_KEYS' },
  { interfaceName: 'TcpCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'TCP_KEYS' },
  { interfaceName: 'UdpCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'UDP_KEYS' },
  { interfaceName: 'HttpsCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'HTTPS_KEYS' },
  { interfaceName: 'FsCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'FS_KEYS' },
  { interfaceName: 'IdCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'ID_CAPABILITY_KEYS' }
]

/**
 * Contract fields the loader deliberately does not accept yet -- a
 * capability specified but not implemented. Each entry needs `reason`: that
 * is the whole mechanism for telling "not yet built, on purpose" apart from
 * "forgotten". An entry here is a decision someone recorded, not a guess
 * this script made on its own.
 *
 * Empty today -- every field either interface currently declares is already
 * accepted (A164, the consentGranularity fix). Add a row here, with why,
 * the day that stops being true:
 * `{ interfaceName: 'NetCapability', field: 'example', reason: '...' }`.
 */
export const DELIBERATELY_DEFERRED = []

// Re-implemented rather than imported from check-contracts-pure.mjs -- see
// cli.mjs's own header on why the check:* scripts duplicate small
// scaffolding like this rather than sharing it.
function stripComments (source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/**
 * The `readonly <field>` member names declared directly inside
 * `export interface <interfaceName> { ... }` in `source` -- comments
 * stripped first, so doc-comment prose can never look like a field.
 *
 * @returns {string[] | null} null when the interface cannot be found at
 *   all -- a bug in THIS check (its regex is out of date with a reformatted
 *   file), which the caller must fail closed on rather than read as "zero
 *   fields, zero gaps".
 */
export function interfaceFields (source, interfaceName) {
  const stripped = stripComments(source)
  const open = new RegExp(`export interface ${interfaceName}\\b[^{]*\\{`).exec(stripped)
  if (open === null) return null

  let depth = 1
  let i = open.index + open[0].length
  while (i < stripped.length && depth > 0) {
    if (stripped[i] === '{') depth += 1
    else if (stripped[i] === '}') depth -= 1
    i += 1
  }
  const body = stripped.slice(open.index + open[0].length, i - 1)
  return [...body.matchAll(/readonly\s+(\w+)\??\s*:/g)].map((match) => match[1])
}

/**
 * The string-literal items inside `const <arrayName> = [ ... ]` in `source`.
 * Same fail-closed reasoning as interfaceFields: null, not [], when the
 * array cannot be found.
 */
export function arrayLiteralItems (source, arrayName) {
  const stripped = stripComments(source)
  const match = new RegExp(`const ${arrayName}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(stripped)
  if (match === null) return null
  return [...match[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
}

function readSafe (path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * @param {string} root Repository root.
 * @param {{ parityMap?: typeof PARITY_MAP, deferred?: typeof DELIBERATELY_DEFERRED }} [options]
 *   Overridable for this file's own tests; a real run uses the real
 *   PARITY_MAP and DELIBERATELY_DEFERRED above.
 * @returns {{ ok: boolean,
 *   gaps: Array<{interfaceName: string, field: string, loaderFile: string, arrayName: string}>,
 *   unreadable: string[] }}
 *   `unreadable` names an interface or array this check could not find at
 *   all. Non-empty `unreadable` always makes `ok` false, on its own.
 */
export function checkManifestParity (root, options = {}) {
  const parityMap = options.parityMap ?? PARITY_MAP
  const deferred = options.deferred ?? DELIBERATELY_DEFERRED
  const contractSource = readSafe(join(root, CONTRACT_FILE))

  const gaps = []
  const unreadable = []

  for (const { interfaceName, loaderFile, arrayName } of parityMap) {
    const contractFields = interfaceFields(contractSource, interfaceName)
    if (contractFields === null) {
      unreadable.push(`interface ${interfaceName} in ${CONTRACT_FILE}`)
      continue
    }

    const loaderSource = readSafe(join(root, loaderFile))
    const loaderKeys = arrayLiteralItems(loaderSource, arrayName)
    if (loaderKeys === null) {
      unreadable.push(`${arrayName} in ${loaderFile}`)
      continue
    }

    for (const field of contractFields) {
      if (loaderKeys.includes(field)) continue
      if (deferred.some((d) => d.interfaceName === interfaceName && d.field === field)) continue
      gaps.push({ interfaceName, field, loaderFile, arrayName })
    }
  }

  return { ok: gaps.length === 0 && unreadable.length === 0, gaps, unreadable }
}

if (isInvokedDirectly(import.meta.url)) {
  const { ok, gaps, unreadable } = checkManifestParity(process.cwd())

  if (!ok) {
    if (unreadable.length > 0) {
      console.error(
        '\nThis check could not find something it expects to exist -- its own regex' +
        '\nmay be out of date with a reformatted file. Fix the check before trusting it:\n'
      )
      for (const item of unreadable) console.error(`  ${item}`)
    }
    if (gaps.length > 0) {
      console.error(`\n${CONTRACT_FILE} declares a field the loader does not accept:\n`)
      for (const { interfaceName, field, loaderFile, arrayName } of gaps) {
        console.error(`  ${interfaceName}.${field} -- missing from ${arrayName} in ${loaderFile}`)
      }
      console.error(
        '\nAn app author reading the contract will use this field as documented and be' +
        '\nrefused at install, blamed for a gap that is not theirs (docs/open-questions.md' +
        '\nA164). Either implement it and add it to the array named above, or -- if it is' +
        "\ndeliberately not built yet -- add it to this script's own DELIBERATELY_DEFERRED" +
        '\nlist with a reason.\n'
      )
    }
    process.exit(1)
  }

  console.log(`${CONTRACT_FILE}'s fields are all accepted by the loader (or explicitly deferred).`)
}
