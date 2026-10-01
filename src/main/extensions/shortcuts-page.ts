// What the shortcuts page (orivon://extensions/shortcuts) may ask of main: the
// commands every extension declares with the key each holds, start and cancel
// recording a key for one, clear one, and move a key from the command that
// holds it. The domain has already checked the request came from the extensions
// page; a request names an extension and a command, both looked up in the
// table main keeps, never trusted as a path or a binding to apply.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseBinding } from '../shortcuts/accelerator.js'
import type { InternalCaller } from '../pages/internal-ipc.js'
import { resolveLocaleMessage } from './extensions-view.js'
import type { ExtensionPart } from './extensions-detail-parts.js'
import type { ExtensionsDomainDeps } from './extensions-domain.js'
import { readLocaleCatalog } from './extensions-view-runner.js'
import type { InstalledExtension } from './registry.js'

type Body = Readonly<Record<string, unknown>>

/** How many commands the extension declares, for its details page's link. */
export const shortcutsPart: ExtensionPart = (entry, _facts, deps) => {
  const group = deps.extensions.commandKeys.groups().find((candidate) => candidate.id === entry.id)
  return group === undefined ? {} : { shortcuts: { commands: group.commands.length } }
}

const text = (value: unknown): string => typeof value === 'string' ? value : ''

async function defaultLocale (entry: InstalledExtension): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(entry.path, 'manifest.json'), 'utf8')) as { default_locale?: unknown }
    return typeof manifest.default_locale === 'string' ? manifest.default_locale : undefined
  } catch {
    return undefined
  }
}

export async function shortcutsList (_body: Body, deps: ExtensionsDomainDeps): Promise<unknown> {
  const keys = deps.extensions.commandKeys
  const installed = deps.extensions.list()
  const extensions = await Promise.all(keys.groups().map(async (group) => {
    const entry = installed.find((candidate) => candidate.id === group.id)
    const facts = entry === undefined ? undefined : await deps.readFacts(entry)
    const catalog = entry === undefined || !group.commands.some((command) => command.description.startsWith('__MSG_'))
      ? undefined
      : await readLocaleCatalog(entry.path, await defaultLocale(entry))
    return {
      id: group.id,
      name: facts?.resolvedName ?? group.name,
      iconDataUrl: facts?.iconDataUrl,
      commands: group.commands.map((command) => ({ ...command, description: resolveLocaleMessage(command.description, catalog) }))
    }
  }))
  extensions.sort((a, b) => a.name.localeCompare(b.name))
  return { platform: keys.platform, installed: installed.length, extensions }
}

export function shortcutsRecord (body: Body, deps: ExtensionsDomainDeps, caller: InternalCaller): boolean {
  return deps.extensions.commandKeys.beginRecording(caller.contents, text(body['id']), text(body['name']))
}

export function shortcutsCancel (_body: Body, deps: ExtensionsDomainDeps, caller: InternalCaller): void {
  const keys = deps.extensions.commandKeys
  if (keys.isRecording(caller.contents)) keys.cancelRecording()
}

export function shortcutsClear (body: Body, deps: ExtensionsDomainDeps): boolean {
  return deps.extensions.commandKeys.clear(text(body['id']), text(body['name']))
}

/** Gives the command the key another extension's command holds, and clears that one. */
export function shortcutsMove (body: Body, deps: ExtensionsDomainDeps): unknown {
  const keys = deps.extensions.commandKeys
  const chord = parseBinding(text(body['binding']), keys.platform)
  if (chord === null) return { status: 'invalid', problem: 'unsupported' }
  return keys.move(text(body['id']), text(body['name']), chord)
}
