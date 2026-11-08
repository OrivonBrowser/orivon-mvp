// Chromium on Linux with no desktop proxy setting reads the proxy from `http_proxy`, `https_proxy` and their kin, and the
// names that proxy must not be asked about from `no_proxy`. A name the verifier serves is answered on this computer, so it
// goes in that list; an environment that carries a proxy then never hears it. Pure: the caller hands over the environment.

/** The two spellings Chromium (and the tools Orivon starts) read; the lower case wins when both are set. */
const VARIABLES = ['no_proxy', 'NO_PROXY'] as const

/** The suffix an entry exempts: `eth`, `.eth` and `*.eth` all name `eth`, and `*` names every host. */
function exemptedSuffix (entry: string): string {
  return entry.trim().toLowerCase().replace(/^\*?\./, '')
}

/**
 * `existing` with every suffix it does not already exempt added, as `.suffix`: the leading dot says "this suffix" to Chromium
 * and to curl, Go and Python alike, where `*.suffix` is Chromium's own form. What the person put there stays, untouched and first.
 */
export function composeNoProxy (existing: string | undefined, suffixes: readonly string[]): string {
  const kept = (existing ?? '').trim().replace(/[\s,;]+$/, '')
  const exempted = new Set(kept.split(/[,;]/).map(exemptedSuffix))
  const added = [...new Set(suffixes.map((suffix) => suffix.toLowerCase()))].filter((suffix) => !exempted.has('*') && !exempted.has(suffix))
  return [...(kept === '' ? [] : [kept]), ...added.map((suffix) => `.${suffix}`)].join(',')
}

/**
 * Adds the suffixes to both spellings in `env`. A spelling that is not set starts from the other's value, since a program that
 * reads only that one would otherwise lose the person's list. Idempotent, and a case-insensitive environment (Windows) reads
 * both names as one.
 */
export function exemptFromEnvironmentProxy (env: Record<string, string | undefined>, suffixes: readonly string[]): void {
  const inherited = env[VARIABLES[0]] ?? env[VARIABLES[1]]
  for (const name of VARIABLES) env[name] = composeNoProxy(env[name] ?? inherited, suffixes)
}
