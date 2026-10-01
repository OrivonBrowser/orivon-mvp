// The manifest an extension was installed with (stripped of what Orivon does
// not run), before the person's grants are merged in. Held-permission and
// host-access answers start from this plus `prefs.granted`, never from the
// loaded manifest: a grant is merged into the loaded copy only when the
// extension next reloads, so the loaded copy still carries an item the person
// has since taken back.
export type BaseManifest = Readonly<Record<string, unknown>>
export type BaseManifestSource = (extensionId: string) => BaseManifest | undefined

let source: BaseManifestSource | undefined

/** `install-apis.ts` hands in the source when the APIs install. */
export function setBaseManifestSource (next: BaseManifestSource | undefined): void {
  source = next
}

/** The base manifest of `extensionId`, undefined when none is known. */
export function baseManifestOf (extensionId: string): BaseManifest | undefined {
  return source?.(extensionId)
}

/** The base manifest of `extensionId`; `fallback` (the loaded manifest) when none is known. */
export function baseManifestOr<T extends BaseManifest> (extensionId: string, fallback: T): BaseManifest {
  return source?.(extensionId) ?? fallback
}

export interface BaseManifestCacheDeps {
  /** The text of the extension's base manifest, undefined when there is none. */
  readonly readText: (extensionId: string) => string | undefined
}

export interface BaseManifestCache {
  readonly baseOf: BaseManifestSource
  /** Forgets what was read, for a load or unload of the extension (its base file may have changed). */
  readonly invalidate: (extensionId: string) => void
}

/** Reads each base manifest once per load. A missing or unreadable file is not remembered, so it is tried again. */
export function createBaseManifestCache (deps: BaseManifestCacheDeps): BaseManifestCache {
  const cached = new Map<string, BaseManifest>()
  return {
    baseOf: (extensionId) => {
      const known = cached.get(extensionId)
      if (known !== undefined) return known
      const text = deps.readText(extensionId)
      if (text === undefined) return undefined
      try {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
        cached.set(extensionId, parsed as BaseManifest)
        return parsed as BaseManifest
      } catch {
        return undefined
      }
    },
    invalidate: (extensionId) => { cached.delete(extensionId) }
  }
}
