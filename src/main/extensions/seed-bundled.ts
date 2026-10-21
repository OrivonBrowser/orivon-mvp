// Installs the extensions that ship with Orivon into a profile that has never installed one.
import { bundledExtensions } from '../default-profile/default-profile.js'
import { installBundled, type InstallContext } from './install-runner.js'

/** One extension that fails to install is logged and the rest still go in: the browser starts either way. */
export async function seedBundledExtensions (install: InstallContext, dir: string): Promise<void> {
  const log = (problem: string): void => { console.error(`[extensions] bundled: ${problem}`) }
  for (const extension of await bundledExtensions(dir, log)) {
    try {
      const outcome = await installBundled(install, extension.path, { pinned: extension.pinned })
      if (!outcome.installed) log(`${extension.name} was not installed: ${outcome.reason}`)
    } catch (error) {
      log(`${extension.name} was not installed: ${String(error)}`)
    }
  }
}
