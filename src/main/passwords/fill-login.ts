// Puts a chosen account, or a generated password, into the page a person is looking at. Both run only
// from a choice made in Orivon's own chooser, and both hand the page its values only if the page is still
// at the origin the login belongs to when the message is sent: the password is read from the store
// asynchronously, and a page that navigated meanwhile receives nothing.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { fillFrame } from './form-watch-ipc.js'
import type { PasswordVault } from './vault.js'

type Send = typeof fillFrame

/** Fills the login `id` of the tab's current origin into its top frame. False when the login is not this page's, has no password, or the page moved. */
export async function fillLogin (contents: WebContents, vault: Pick<PasswordVault, 'list' | 'reveal' | 'touch'>, id: string, send: Send = fillFrame): Promise<boolean> {
  if (contents.isDestroyed()) return false
  const origin = originFromUrl(contents.mainFrame.url)
  if (origin === null) return false
  // The id is the chooser's claim; the login must belong to where the page is now.
  const login = vault.list(origin).find((candidate) => candidate.id === id)
  if (login === undefined) return false
  const password = await vault.reveal(login.id)
  if (password === undefined) return false
  const sent = send(contents, login.origin, { type: 'fill', username: login.username, password, both: false })
  if (sent) vault.touch?.(login.id)
  return sent
}

/** Fills `password` into every password field of the focused sign-up form, while the page is still at `origin`. */
export function fillGenerated (contents: WebContents, origin: string, password: string, send: Send = fillFrame): boolean {
  return send(contents, origin, { type: 'fill', username: null, password, both: true })
}
