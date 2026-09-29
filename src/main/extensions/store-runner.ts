// Wires the vendored Chrome Web Store integration (electron-chrome-web-
// store) into Orivon: registers its store-page preload on the default
// session, shows the install prompt from the store page's own manifest
// before any download, and routes every install, update and uninstall it
// drives through install-runner.ts's own functions -- Orivon writes every
// loaded extension copy itself; the library never touches the filesystem or
// calls `loadExtension` once the host below is installed (UPSTREAM.md
// patch 4).
import {
  installChromeWebStore, updateExtensions
} from '../../../vendor/electron-chrome-web-store/src/browser/index.js'
import type { UpdateCheckResult, VerifyCrx, WebStoreHost } from '../../../vendor/electron-chrome-web-store/src/browser/types.js'
import { describeExtensionInstall, readExtensionManifest } from '../../broker/policy/extension-manifest.js'
import { verifyCrx3 } from './crx.js'
import { patchStoreUpdater } from './registry-runner.js'
import {
  installFromStore, installFromStoreCrx, updateFromStore, uninstall,
  type InstallContext, type InstallOutcome
} from './install-runner.js'

export interface StoreApi {
  readonly installFromStore: (id: string) => Promise<InstallOutcome>
  readonly checkForUpdates: () => Promise<void>
  readonly updateFromStore: (id: string) => Promise<InstallOutcome>
}

/** Every download this library makes, host or no host, is checked against
 * this -- see installer.ts's own doc on why `host.installCrx` still gets a
 * second, stricter check (`requirePublisherProof: true`) on top of this
 * one's plain developer-proof check. */
const verifyCrx: VerifyCrx = (crx, expectedId) => {
  const result = verifyCrx3(crx, { requirePublisherProof: false })
  if (result.id !== expectedId) {
    throw new Error(`downloaded CRX id ${result.id} does not match the requested extension ${expectedId}`)
  }
}

/**
 * The vendored library's own write path (`WebStoreHost`): every actual
 * install and uninstall still goes through install-runner.ts's own
 * functions (this file's own header). `installCrx` throws when
 * `installFromStoreCrx` refuses the install (a download that asks for more
 * than what was approved, or no approved manifest at all) -- the library's
 * `beginInstall` (vendor/.../src/browser/api.ts) catches exactly this and
 * turns it into an `INSTALL_ERROR` result the store page shows as a failed
 * install; without the throw, a refused install silently reports success.
 */
export function buildWebStoreHost (ctx: InstallContext): WebStoreHost {
  return {
    installCrx: async (crx, expectedId, approvedManifest, downloadUrl) => {
      const outcome = await installFromStoreCrx(ctx, crx, expectedId, approvedManifest, {
        skipPrompt: true,
        ...(downloadUrl === undefined ? {} : { downloadUrl })
      })
      if (!outcome.installed) throw new Error(outcome.reason)
    },
    uninstall: async (id) => { await uninstall(ctx, id) }
  }
}

/** `state.session` is the default session for both the store's own IPC and
 * every extension Orivon loads, so an update check's
 * `session.extensions.getAllExtensions()` already sees what Orivon
 * installed with no bookkeeping of its own. */
export async function startWebStore (ctx: InstallContext, preloadPath: string): Promise<StoreApi> {
  const host = buildWebStoreHost(ctx)

  const onUpdateCheck = (result: UpdateCheckResult): void => {
    const lastResult = result.error !== undefined
      ? `check failed: ${result.error}`
      : result.to !== undefined ? `update to ${result.to} available` : 'up to date'
    patchStoreUpdater(ctx.userDataPath, result.extensionId, { lastCheckedAt: result.checkedAt, lastResult })
  }

  await installChromeWebStore({
    session: ctx.session,
    loadExtensions: false,
    autoUpdate: true,
    preloadPath,
    verifyCrx,
    beforeInstall: async ({ manifest }) => {
      const parsed = readExtensionManifest(manifest)
      if (!parsed.ok) return { action: 'deny' }
      const allowed = await ctx.prompt(describeExtensionInstall(parsed.facts, 'store'))
      return { action: allowed ? 'allow' : 'deny' }
    },
    onUpdateCheck,
    host
  })

  return {
    installFromStore: async (id) => await installFromStore(ctx, id),
    checkForUpdates: async () => { await updateExtensions(ctx.session, verifyCrx, onUpdateCheck, host) },
    updateFromStore: async (id) => await updateFromStore(ctx, id)
  }
}
