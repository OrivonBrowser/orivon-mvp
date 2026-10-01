import type { Crx } from './crx.js'

/** `chrome.commands.onChanged`: main tells an extension when the key of one of its commands changes. */
export function commandsApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  crx.define('commands', (base) => ({ ...base, onChanged: crx.event('commands.onChanged') }))
}
