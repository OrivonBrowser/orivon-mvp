/**
 * Fails the build if src/contracts/manifest.ts declares an interface field
 * the loader's own manifest parser does not list in its allowlist, or the
 * allowlist names a field the contract does not declare.
 *
 * The loader ignores (with a warning) an unknown TOP-LEVEL manifest field and
 * rejects an unknown field anywhere inside `capabilities`. So a top-level gap
 * is silent at run time: the field the author wrote is dropped, not refused,
 * and this check is what still makes it loud. A stale top-level entry would
 * suppress the warning that names an unknown field, and a stale capability
 * entry would accept a field the contract never specified.
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
  { interfaceName: 'IdCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'ID_CAPABILITY_KEYS' },
  { interfaceName: 'WebCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'WEB_CAPABILITY_KEYS' },
  { interfaceName: 'MediaCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'MEDIA_CAPABILITY_KEYS' },
  { interfaceName: 'ClipboardCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'CLIPBOARD_CAPABILITY_KEYS' },
  // SecretsCapability declares zero fields today (ADR-0031, "presence alone
  // is the declaration"), so this row never finds a gap or a stale entry --
  // but it stays here rather than being omitted, so the day a field IS
  // added to either side, this check catches the drift immediately instead
  // of needing to be remembered.
  { interfaceName: 'SecretsCapability', loaderFile: 'src/loader/manifest-capabilities.ts', arrayName: 'SECRETS_CAPABILITY_KEYS' }
]

/**
 * Contract fields the loader deliberately does not accept yet -- a
 * capability specified but not implemented. Each entry needs `reason`: that
 * is the whole mechanism for telling "not yet built, on purpose" apart from
 * "forgotten". An entry here is a decision someone recorded, not a guess
 * this script made on its own.
 *
 * A field on a PARITY_MAP row whose loader array does not exist AT ALL
 * (rather than existing but missing this one field) is also covered here,
 * not treated as `unreadable`, PROVIDED every field the interface declares
 * has its own entry below -- see the loop in {@link checkManifestParity}.
 * That is what let ADR-0019's `WebCapability` -- a brand-new interface whose
 * loader array did not exist yet -- land in a contracts-only PR without
 * tripping this check: its two fields were named here, with a reason, until
 * the implementation PR that followed added `WEB_CAPABILITY_KEYS` and
 * removed them. Empty today -- nothing is currently deferred -- but the
 * whole-interface logic above stays, for the next capability that ships
 * contracts-first the same way.
 */
export const DELIBERATELY_DEFERRED = [
  {
    interfaceName: 'Capabilities',
    field: 'media',
    reason: 'ADR-0030: media (camera/microphone) is declared in this contracts-only PR. The ' +
      'loader starts accepting `media` in the implementation PR that follows, which removes ' +
      'this entry.'
  },
  {
    interfaceName: 'Capabilities',
    field: 'clipboard',
    reason: 'ADR-0030: clipboard.read is declared in this contracts-only PR. The loader starts ' +
      'accepting `clipboard` in the implementation PR that follows, which removes this entry.'
  },
  // Capabilities.secrets (ADR-0031) is no longer deferred: its own
  // implementation PR added CAPABILITIES_KEYS' 'secrets' entry and
  // readSecrets, so a real check now covers it.
  {
    interfaceName: 'MediaCapability',
    field: 'camera',
    reason: 'ADR-0030: MEDIA_CAPABILITY_KEYS does not exist yet -- added by the implementation ' +
      'PR that follows this one, which removes this entry.'
  },
  {
    interfaceName: 'MediaCapability',
    field: 'microphone',
    reason: 'ADR-0030: MEDIA_CAPABILITY_KEYS does not exist yet -- added by the implementation ' +
      'PR that follows this one, which removes this entry.'
  },
  {
    interfaceName: 'ClipboardCapability',
    field: 'read',
    reason: 'ADR-0030: CLIPBOARD_CAPABILITY_KEYS does not exist yet -- added by the ' +
      'implementation PR that follows this one, which removes this entry.'
  }
]

// Re-implemented rather than imported from check-contracts-pure.mjs -- see
// cli.mjs's own header on why the check:* scripts duplicate small
// scaffolding like this rather than sharing it.
function stripComments (source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/**
 * The interface's own top-level members -- name plus whether `readonly` was
 * present -- for `export interface <interfaceName> { ... }` in `source`.
 * Comments are stripped first, so doc-comment prose can never look like a
 * field.
 *
 * Two things this masks out on purpose, both from the interface's own
 * top-level view: text inside a NESTED `{ ... }` (an inline object type on
 * one of this interface's own fields -- A176 point 1, that field's own
 * members are not this interface's siblings), and text inside `( ... )` (a
 * function-typed field's parameter list, where a parameter name followed by
 * `:` would otherwise regex-match exactly like a field). Both are tracked as
 * depth counters over the body; only text at brace-depth 1, paren-depth 0
 * is a candidate member.
 *
 * Matches a member whether or not it says `readonly` (A176 point 2 -- a
 * missing keyword used to make the field vanish from this list entirely
 * rather than be reported as a convention violation); `readonly` on the
 * returned record says which.
 *
 * @returns {Array<{ name: string, readonly: boolean }> | null} null when the
 *   interface cannot be found at all -- a bug in THIS check (its regex is
 *   out of date with a reformatted file), which the caller must fail closed
 *   on rather than read as "zero members, zero gaps".
 */
function interfaceMembers (source, interfaceName) {
  const stripped = stripComments(source)
  const open = new RegExp(`export interface ${interfaceName}\\b[^{]*\\{`).exec(stripped)
  if (open === null) return null

  let braceDepth = 1
  let parenDepth = 0
  let i = open.index + open[0].length
  let topLevel = ''
  while (i < stripped.length && braceDepth > 0) {
    const ch = stripped[i]
    if (ch === '{') {
      braceDepth += 1
    } else if (ch === '}') {
      braceDepth -= 1
      if (braceDepth === 0) { i += 1; break }
    } else if (ch === '(') {
      parenDepth += 1
    } else if (ch === ')') {
      parenDepth -= 1
    }
    topLevel += (braceDepth === 1 && parenDepth === 0) ? ch : ' '
    i += 1
  }

  return [...topLevel.matchAll(/(readonly\s+)?(\w+)\??\s*:/g)]
    .map((match) => ({ name: match[2], readonly: match[1] !== undefined }))
}

/**
 * The member names from {@link interfaceMembers}, `readonly` or not --
 * see that function's own doc for what "top-level" excludes and why.
 *
 * @returns {string[] | null} null under the same condition as
 *   `interfaceMembers`.
 */
export function interfaceFields (source, interfaceName) {
  const members = interfaceMembers(source, interfaceName)
  return members === null ? null : members.map((member) => member.name)
}

/**
 * The subset of {@link interfaceMembers} missing the `readonly` keyword --
 * A176 point 2. Nothing in this repo lints for the keyword, so this is the
 * only mechanism that tells a dropped one apart from a field that was never
 * there; it fails the check even when the field's name is already present
 * in the loader's allowlist, because the missing keyword is itself the
 * defect being reported, not a proxy for one.
 *
 * @returns {string[] | null} null under the same condition as
 *   `interfaceMembers`.
 */
export function nonReadonlyInterfaceFields (source, interfaceName) {
  const members = interfaceMembers(source, interfaceName)
  if (members === null) return null
  return members.filter((member) => !member.readonly).map((member) => member.name)
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
 *   stale: Array<{interfaceName: string, field: string, loaderFile: string, arrayName: string}>,
 *   unreadable: string[],
 *   missingReadonly: Array<{interfaceName: string, field: string}> }}
 *   `gaps` are contract fields the loader array lacks; `stale` are loader
 *   array entries the contract does not declare. `unreadable` names an
 *   interface or array this check could not find at all. `missingReadonly`
 *   names a field this check found without the `readonly` keyword (A176
 *   point 2) -- reported on its own, independent of `gaps`, because the
 *   missing keyword is a defect even when the field's name already happens
 *   to be in the loader's allowlist. Any of the four non-empty makes `ok`
 *   false.
 */
export function checkManifestParity (root, options = {}) {
  const parityMap = options.parityMap ?? PARITY_MAP
  const deferred = options.deferred ?? DELIBERATELY_DEFERRED
  const contractSource = readSafe(join(root, CONTRACT_FILE))

  const gaps = []
  const stale = []
  const unreadable = []
  const missingReadonly = []

  for (const { interfaceName, loaderFile, arrayName } of parityMap) {
    const contractFields = interfaceFields(contractSource, interfaceName)
    if (contractFields === null) {
      unreadable.push(`interface ${interfaceName} in ${CONTRACT_FILE}`)
      continue
    }

    for (const field of nonReadonlyInterfaceFields(contractSource, interfaceName)) {
      missingReadonly.push({ interfaceName, field })
    }

    const loaderSource = readSafe(join(root, loaderFile))
    const loaderKeys = arrayLiteralItems(loaderSource, arrayName)
    if (loaderKeys === null) {
      // Two reasons this array can be unreadable: this check's own regex is
      // stale (a real bug -- fail closed), or the array has not been written
      // yet because every field the interface declares is a recorded,
      // reasoned DELIBERATELY_DEFERRED entry (ADR-0019's WebCapability). Only
      // the second is fine, and only when EVERY field says so -- a mix of
      // deferred and forgotten fields must still fail loud.
      const entirelyDeferred = contractFields.length > 0 && contractFields.every((field) =>
        deferred.some((d) => d.interfaceName === interfaceName && d.field === field))
      if (entirelyDeferred) continue
      unreadable.push(`${arrayName} in ${loaderFile}`)
      continue
    }

    for (const field of contractFields) {
      if (loaderKeys.includes(field)) continue
      if (deferred.some((d) => d.interfaceName === interfaceName && d.field === field)) continue
      gaps.push({ interfaceName, field, loaderFile, arrayName })
    }
    for (const field of loaderKeys) {
      if (!contractFields.includes(field)) stale.push({ interfaceName, field, loaderFile, arrayName })
    }
  }

  const ok = gaps.length === 0 && stale.length === 0 && unreadable.length === 0 && missingReadonly.length === 0
  return { ok, gaps, stale, unreadable, missingReadonly }
}

if (isInvokedDirectly(import.meta.url)) {
  const { ok, gaps, stale, unreadable, missingReadonly } = checkManifestParity(process.cwd())

  if (!ok) {
    if (unreadable.length > 0) {
      console.error(
        '\nThis check could not find something it expects to exist -- its own regex' +
        '\nmay be out of date with a reformatted file. Fix the check before trusting it:\n'
      )
      for (const item of unreadable) console.error(`  ${item}`)
    }
    if (missingReadonly.length > 0) {
      console.error(`\n${CONTRACT_FILE} declares a field without the readonly keyword:\n`)
      for (const { interfaceName, field } of missingReadonly) {
        console.error(`  ${interfaceName}.${field} -- missing 'readonly'`)
      }
      console.error(
        '\nNothing in this repo lints for readonly (docs/open-questions.md A176), so a' +
        '\ndropped keyword is invisible everywhere else this check is not run. Add it back.\n'
      )
    }
    if (gaps.length > 0) {
      console.error(`\n${CONTRACT_FILE} declares a field the loader does not accept:\n`)
      for (const { interfaceName, field, loaderFile, arrayName } of gaps) {
        console.error(`  ${interfaceName}.${field} -- missing from ${arrayName} in ${loaderFile}`)
      }
      console.error(
        '\nAn app author reading the contract will use this field as documented and have it' +
        '\nrefused (inside capabilities) or silently dropped with a warning (at the top level),' +
        '\na gap that is not theirs (docs/open-questions.md A164). Either implement it and add' +
        "\nit to the array named above, or -- if it is deliberately not built yet -- add it to" +
        "\nthis script's own DELIBERATELY_DEFERRED list with a reason.\n"
      )
    }
    if (stale.length > 0) {
      console.error(`\nThe loader accepts a field ${CONTRACT_FILE} does not declare:\n`)
      for (const { interfaceName, field, loaderFile, arrayName } of stale) {
        console.error(`  ${interfaceName}.${field} -- listed in ${arrayName} in ${loaderFile}`)
      }
      console.error(
        '\nA renamed or removed contract field left behind in the loader. Remove it from the' +
        '\narray, or declare it in the contract.\n'
      )
    }
    process.exit(1)
  }

  console.log(`${CONTRACT_FILE}'s fields are all accepted by the loader (or explicitly deferred).`)
}
