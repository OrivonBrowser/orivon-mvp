// Reads a registry entry's manifest, icon and locale catalogue off its
// loaded folder -- the I/O half of extensions-view.ts (src/main/README.md's
// suffix rule): every decision about what those bytes mean lives there, not
// here.
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readExtensionManifest } from '../../broker/policy/extension-manifest.js'
import type { ExtensionManifestFacts } from '../../broker/policy/extension-manifest.js'
import { iconMimeType, pickIconPath, resolveLocaleMessage } from './extensions-view.js'
import type { ExtensionFacts } from './extensions-view.js'
import type { InstalledExtension } from './registry.js'

const MAX_ICON_SIZE = 48

/** `relativePath`'s bytes, only if it stays inside `root` -- an icon or
 * locale path comes from the extension's own manifest, never trusted to
 * stay put (the same confinement `src/main/pages/serve.ts`'s `readInside`
 * applies to a page's own assets). */
async function readInside (root: string, relativePath: string): Promise<Buffer | null> {
  const target = resolve(root, relativePath)
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
  try {
    return await readFile(target)
  } catch {
    return null
  }
}

async function readLocaleCatalog (root: string, defaultLocale: string | undefined): Promise<Map<string, string> | undefined> {
  if (defaultLocale === undefined) return undefined
  const bytes = await readInside(root, `_locales/${defaultLocale}/messages.json`)
  if (bytes === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const catalog = new Map<string, string>()
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const message = typeof value === 'object' && value !== null ? (value as { message?: unknown }).message : undefined
    if (typeof message === 'string') catalog.set(key.toLowerCase(), message)
  }
  return catalog
}

function stringField (manifest: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = manifest?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * `entry`'s manifest, icon and locale catalogue, resolved into what the
 * extensions page shows. Never throws: a manifest that fails to read or
 * parse (should not happen for something Orivon itself installed) leaves
 * `manifestFacts` undefined and the entry's own recorded name in place of a
 * resolved one, rather than failing the whole list over one damaged entry.
 */
export async function readExtensionFacts (entry: InstalledExtension): Promise<ExtensionFacts> {
  let rawManifest: Record<string, unknown> | undefined
  try {
    const bytes = await readFile(join(entry.path, 'manifest.json'), 'utf8')
    const parsed: unknown = JSON.parse(bytes)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) rawManifest = parsed as Record<string, unknown>
  } catch {
    rawManifest = undefined
  }

  const parsedManifest = rawManifest === undefined ? undefined : readExtensionManifest(rawManifest)
  const manifestFacts: ExtensionManifestFacts | undefined = parsedManifest?.ok === true ? parsedManifest.facts : undefined

  const catalog = await readLocaleCatalog(entry.path, stringField(rawManifest, 'default_locale'))

  const rawName = stringField(rawManifest, 'name') ?? entry.name
  const rawDescription = stringField(rawManifest, 'description')
  const resolvedName = resolveLocaleMessage(rawName, catalog)
  const resolvedDescription = rawDescription === undefined ? undefined : resolveLocaleMessage(rawDescription, catalog)

  const iconsField = rawManifest?.['icons']
  const icons = typeof iconsField === 'object' && iconsField !== null ? iconsField as Record<string, unknown> : undefined
  const choice = pickIconPath(icons, MAX_ICON_SIZE)
  let iconDataUrl: string | undefined
  if (choice !== undefined) {
    const bytes = await readInside(entry.path, choice.path)
    if (bytes !== null) iconDataUrl = `data:${iconMimeType(choice.path)};base64,${bytes.toString('base64')}`
  }

  return { resolvedName, resolvedDescription, iconDataUrl, manifestFacts }
}
