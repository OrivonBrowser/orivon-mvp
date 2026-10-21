// Which origins have a given record file on disk: the startup enumeration of what `apps/` holds (pins, and consents
// whose pin has not landed). The directory name must be the hash of the origin the record itself claims.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appRootDirectoryName } from './storage.js'

/** `originOf` reads the origin a parsed record claims, or undefined for one that is not a record of its kind. */
export async function listOriginsWithRecord (userDataPath: string, fileName: string, originOf: (parsed: unknown) => string | undefined): Promise<readonly string[]> {
  const appsDir = join(userDataPath, 'apps')
  let entries
  try {
    entries = await readdir(appsDir, { withFileTypes: true })
  } catch (error) {
    // ENOENT means no app has ever been installed on this machine: an empty list. Anything else is logged, since
    // this is a startup enumeration, not a per-request path.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[loader] failed to list the apps directory', appsDir, error)
    return []
  }
  const origins: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(await readFile(join(appsDir, entry.name, fileName), 'utf8'))
    } catch {
      continue // an install interrupted before the record was written, or a file that is not JSON
    }
    // Without this cross-check, a record copied or hand-edited into a different app's directory would be handed
    // back as though it belonged there.
    const origin = originOf(parsedJson)
    if (origin !== undefined && appRootDirectoryName(origin) === entry.name) origins.push(origin)
  }
  return origins
}
