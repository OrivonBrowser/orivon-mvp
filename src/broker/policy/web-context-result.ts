// WebContext.evaluate's own result grammar (contracts/handles.ts, ADR-0019):
// null, boolean, finite number, string, and arrays or plain objects of
// those -- nothing else. `../capabilities/web.ts`'s own evaluate() is the one
// caller; it substitutes `null` for a bare top-level `undefined` BEFORE
// calling this (contracts/handles.ts's own carve-out), then measures the
// byte cap over whatever this accepts. See README.md's Design notes for why
// a structured-clone-aware check replaced the original JSON.stringify one.

const MAX_RESULT_DEPTH = 64

export type WebContextResultRejection =
  | 'non-finite-number'
  | 'bigint'
  | 'symbol'
  | 'function'
  | 'undefined'
  | 'non-plain-object'
  | 'cycle'
  | 'too-deep'

/**
 * Why `value` is not a valid `WebContext.evaluate` result, or null if it is.
 * `ancestors` holds only the objects on the CURRENT path (added on entry,
 * removed on exit), so a value reachable twice through two different
 * branches -- not a cycle -- is never mistaken for one.
 */
function rejectionAt (value: unknown, ancestors: Set<object>, depth: number): WebContextResultRejection | null {
  if (value === null) return null

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return null
    case 'number':
      return Number.isFinite(value) ? null : 'non-finite-number'
    case 'bigint':
      return 'bigint'
    case 'symbol':
      return 'symbol'
    case 'function':
      return 'function'
    case 'undefined':
      return 'undefined'
    default:
      break
  }

  // Only 'object' reaches here (typeof's other cases all returned above).
  if (depth >= MAX_RESULT_DEPTH) return 'too-deep'

  const container = value as object
  if (ancestors.has(container)) return 'cycle'

  if (Array.isArray(value)) return rejectionInContainer(container, value, ancestors, depth)

  // Electron's structured clone reconstructs a Date/Map/Set/RegExp/Error/
  // TypedArray completion value as a REAL instance of that class, not a
  // JSON-ish stand-in -- so a prototype check is what actually distinguishes
  // "plain data" from "a live object the contract never promised to carry".
  // Array aside (handled above): everything else must be Object.prototype
  // or null.
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return 'non-plain-object'

  return rejectionInContainer(container, value as Record<string, unknown>, ancestors, depth)
}

function rejectionInContainer (
  container: object,
  items: readonly unknown[] | Record<string, unknown>,
  ancestors: Set<object>,
  depth: number
): WebContextResultRejection | null {
  ancestors.add(container)
  try {
    const values = Array.isArray(items) ? items : Object.values(items)
    for (const item of values) {
      const rejection = rejectionAt(item, ancestors, depth + 1)
      if (rejection !== null) return rejection
    }
    return null
  } finally {
    ancestors.delete(container)
  }
}

/** `webContextResultRejection(value) === null`, for a caller that only needs the boolean gate. */
export function isJsonCompatibleResult (value: unknown): boolean {
  return webContextResultRejection(value) === null
}

export function webContextResultRejection (value: unknown): WebContextResultRejection | null {
  return rejectionAt(value, new Set<object>(), 0)
}
