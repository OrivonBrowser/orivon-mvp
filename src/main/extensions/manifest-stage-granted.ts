// Stage one of the effective manifest: the optional permissions and origins
// the person granted, merged into `permissions` and `host_permissions`. MV2
// has no `host_permissions`, so its origins join `permissions`.
import type { ExtensionPrefs } from './extension-prefs.js'
import type { ExtensionManifest } from './effective-manifest.js'
import { reconcileGranted } from './optional-permissions.js'

function listOf (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function withAll (current: string[], extra: readonly string[]): string[] {
  return [...new Set([...current, ...extra])]
}

export function applyGrantedStage (manifest: ExtensionManifest, prefs: ExtensionPrefs): ExtensionManifest {
  // Only what this manifest still lets the extension ask for: a stray grant never reaches the loaded copy.
  const { permissions, origins } = reconcileGranted(manifest, prefs.granted)
  if (permissions.length === 0 && origins.length === 0) return manifest
  if (manifest['manifest_version'] === 2) {
    return { ...manifest, permissions: withAll(listOf(manifest['permissions']), [...permissions, ...origins]) }
  }
  return {
    ...manifest,
    ...(permissions.length === 0 ? {} : { permissions: withAll(listOf(manifest['permissions']), permissions) }),
    ...(origins.length === 0 ? {} : { host_permissions: withAll(listOf(manifest['host_permissions']), origins) })
  }
}
