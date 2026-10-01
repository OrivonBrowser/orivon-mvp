// Requests the extensions page makes beyond the core ones in
// extensions-domain.ts: a feature adds its own here, keyed by the request's
// `type`. The domain has already checked that the request came from the
// extensions page; a command checks its own arguments, since every field is
// data from a document.
import type { ExtensionsDomainDeps } from './extensions-domain.js'

export type ExtensionPageCommand = (body: Readonly<Record<string, unknown>>, deps: ExtensionsDomainDeps) => unknown

/** One per line, alphabetical. */
export const EXTENSION_PAGE_COMMANDS: Readonly<Record<string, ExtensionPageCommand>> = {}
