// The one name for the session Orivon's own UI runs in: the chrome view, its
// popovers, the intro screen, the exclusive-access notice. ./README.md's
// Design notes say why no tab and no extension may share it. Also which
// renderer entries load from the `orivon-shell:` scheme, and in which session.
export const SHELL_PARTITION = 'persist:orivon-shell'

/** The scheme the shell's own renderer entries load from, and its one host: `orivon-shell://renderer/<path inside out/renderer>`. */
export const SHELL_SCHEME = 'orivon-shell'
export const SHELL_HOST = 'renderer'

/** The entries that run in `SHELL_PARTITION`; they may read every file under `assets/`. Keys of the renderer's `rollupOptions.input`. */
export const SHELL_SESSION_ENTRIES = ['index', 'intro', 'permissions', 'site-info', 'overlay', 'split-frame', 'drop-catcher'] as const

/** The entries that run in the default session, beside websites: only the new-tab page. It may read only the files its own build reaches. */
export const DEFAULT_SESSION_ENTRIES = ['newtab'] as const

export type ShellEntry = (typeof SHELL_SESSION_ENTRIES)[number] | (typeof DEFAULT_SESSION_ENTRIES)[number]

/** Where an entry's page sits inside `out/renderer`. */
export function shellEntryFile (entry: ShellEntry): string {
  return entry === 'index' ? 'index.html' : `${entry}/index.html`
}

/** The address an entry loads from in a built shell: one origin for every entry, so relative URLs resolve as they do on disk. */
export function shellEntryUrl (entry: ShellEntry): string {
  return `${SHELL_SCHEME}://${SHELL_HOST}/${shellEntryFile(entry)}`
}
