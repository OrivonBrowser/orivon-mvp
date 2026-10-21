// The apps a package can be tagged to open on first run, and how a tag is read. Pure: reading names and lists, and no more.
// A tag only ever selects an entry of the allowlist (`resources/flavours.json`); it never carries an address or free text.

export interface Flavour {
  /** What a tag says: lowercase letters and digits only, so it survives a file name and a command line. */
  readonly id: string
  /** The app's address, `<name>.orivonstack.eth`. */
  readonly app: string
  /** What its Featured tile says when the app is not among the shipped entries. */
  readonly name: string
  /** The app's folder in the ports repository, whose `orivon.json` `domain` is `app`. */
  readonly port: string
}

export const FLAVOUR_ID = /^[a-z0-9]{2,24}$/
const APP_NAME = /^[a-z0-9-]{1,63}\.orivonstack\.eth$/
const PORT = /^[a-z0-9-]{1,40}$/

/** The problems with a list as it is written in the file; empty when it is sound. */
export function flavourProblems (raw: unknown): string[] {
  const list = typeof raw === 'object' && raw !== null ? (raw as { flavours?: unknown }).flavours : undefined
  if (!Array.isArray(list)) return ['the file has no "flavours" list']
  const problems: string[] = []
  const seen = new Set<string>()
  for (const item of list as unknown[]) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const { id, app, name, port } = entry
    const label = typeof id === 'string' ? id : JSON.stringify(id)
    if (typeof id !== 'string' || !FLAVOUR_ID.test(id)) problems.push(`${label}: the id is not 2 to 24 lowercase letters and digits`)
    else if (seen.has(id)) problems.push(`${label}: the id is used twice`)
    else seen.add(id)
    if (typeof app !== 'string' || !APP_NAME.test(app)) problems.push(`${label}: the app is not <name>.orivonstack.eth`)
    if (typeof name !== 'string' || name.trim() === '') problems.push(`${label}: the name is empty`)
    if (typeof port !== 'string' || !PORT.test(port)) problems.push(`${label}: the port is not a folder name`)
  }
  return problems
}

/** The entries of a list that are sound; an unsound list gives none, so a damaged file means no flavours. */
export function parseFlavours (raw: unknown): readonly Flavour[] {
  if (flavourProblems(raw).length > 0) return []
  return (raw as { flavours: Flavour[] }).flavours.map(({ id, app, name, port }) => ({ id, app, name, port }))
}

export function findFlavour (flavours: readonly Flavour[], id: string): Flavour | undefined {
  return FLAVOUR_ID.test(id) ? flavours.find((flavour) => flavour.id === id) : undefined
}

/** The tag in an installer's or an AppImage's file name: `Orivon-Setup-1.2.3-x64.<id>.exe`, `Orivon-1.2.3-x86_64.<id>.AppImage`.
 * The `(1)` or ` (1)` a browser adds to a second download is ignored. Null for a plain name, and for a tag of any other shape. */
export function flavourFromFileName (fileName: string): string | null {
  const name = fileName.replace(/\s*\(\d+\)(?=\.[^.]+$)/, '')
  return /^Orivon-[\w.+-]*-(?:x64|arm64|x86_64|aarch64)\.([a-z0-9]{2,24})\.(?:exe|AppImage)$/.exec(name)?.[1] ?? null
}

/** Where a first run may have been tagged. */
export interface Carriers {
  /** The value of `--orivon-flavour=`, when the switch was given at all. */
  readonly switchValue: string | undefined
  /** `basename($APPIMAGE)`, when this is a run of an AppImage. */
  readonly appImageName: string | null
  /** The first line of `installer-name.txt` beside the executable, which the Windows installer wrote. */
  readonly installerName: string | null
}

/** The id a first run was tagged with, from the first carrier that is present: the switch, then the AppImage's name, then the
 * installer's. A switch that is given decides even when it is empty or malformed; a name that carries no tag is not a carrier.
 * The id is not yet checked against the allowlist. */
export function taggedId (carriers: Carriers): string | null {
  if (carriers.switchValue !== undefined) return carriers.switchValue
  for (const name of [carriers.appImageName, carriers.installerName]) {
    const id = name === null ? null : flavourFromFileName(name)
    if (id !== null) return id
  }
  return null
}
