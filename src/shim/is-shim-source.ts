// Shared by electron.vite.config.ts's isShimImporter and vitest.config.ts's
// isShimSource -- both need the identical answer to "is this importer a
// shim module itself, never one of its own tests" (tests drive real
// `node:*` servers and disks, so they must resolve to Node's own builtins).

/**
 * True when `importer` starts with `root`, and what follows starts with one
 * of `dirs` (each root-relative, e.g. `'src/shim/'`) with no `tests` path
 * segment of its own. `root` is stripped as a literal string PREFIX, never
 * resolved through `node:path`'s `relative()`: that is OS-aware (backslash
 * is not a separator on POSIX, so a Windows-style path run through it on
 * Linux does not come apart the way it would on Windows) and would also
 * require `importer` to genuinely sit on disk under `root`, which a unit
 * test giving both as plain strings does not need. Checked against what
 * remains after stripping that known prefix, never a substring search over
 * the raw path: a checkout whose own directory ancestry happens to contain
 * a segment literally named `tests` (or matching one of `dirs`, such as
 * `src/shim`) would otherwise satisfy or defeat a plain substring search for
 * every file in the repository, regardless of where each one actually
 * lives relative to `root`.
 */
export function isShimSource (root: string, importer: string | undefined, dirs: readonly string[] = ['src/shim/']): boolean {
  if (importer === undefined) return false
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedImporter = importer.replace(/\\/g, '/')
  const prefix = `${normalizedRoot}/`
  if (!normalizedImporter.startsWith(prefix)) return false
  const relativePath = normalizedImporter.slice(prefix.length)
  return dirs.some((dir) => relativePath.startsWith(dir)) && !relativePath.split('/').includes('tests')
}
