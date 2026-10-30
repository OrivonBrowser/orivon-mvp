// What the person is told about the Nym tunnel, in one place for the Settings page and the site-info popover. Composed
// here from the state main reports, never from anything an app wrote.

import type { NymState, NymTestResult } from '../../../main/route/nym-status.js'

/** The status line: what Nym is doing now. */
export function nymStatusWords (state: NymState): string {
  switch (state.state) {
    case 'off':
    case 'idle': return 'Starts when an app that uses it connects.'
    case 'connecting': return 'Connecting to Nym…'
    case 'ready': return 'Nym tunnel ready'
    case 'failed': return 'Nym is not answering'
    case 'unavailable':
      if (state.cause === 'not-in-build') return 'Nym is not in this build'
      if (state.cause === 'proxy') return 'Nym is off while a proxy is set'
      return 'Nym is not available here'
  }
}

/** Why, for a state that has a reason worth reading; undefined for one that has none. */
export function nymReason (state: NymState): string | undefined {
  return state.state === 'failed' || state.state === 'unavailable' || state.state === 'ready' ? state.reason : undefined
}

/** What the Test of Nym found, in words. */
export function nymTestWords (result: NymTestResult): string {
  if (result.ok) return `Nym answered: a name was looked up and reached through it in ${(result.ms / 1000).toFixed(1)} s.`
  switch (result.reason) {
    case 'unavailable': return `Nym cannot start: ${result.detail}`
    case 'silent': return 'Nym did not answer in time.'
    case 'failed': return `Nym started, but a connection through it did not work${result.detail === '' ? '.' : `: ${result.detail}`}`
  }
}

/** What stands beside the button while a test runs: a tunnel can take a good while to come up. */
export function nymTestingWords (): string {
  return 'Testing: bringing a tunnel up through the mixnet can take up to a minute.'
}

/** The popover's line about an app routed through Nym. */
export function nymRouteLine (route: 'idle' | 'ok' | 'down' | 'no-proxy' | 'temporary', state: NymState, noun: 'app' | 'site' | 'tab' | 'browser' = 'app'): string {
  if (route === 'temporary') return 'This page goes through Nym, and nothing it stores is kept once its last tab is closed.'
  if (state.state === 'failed' || state.state === 'unavailable') return `${nymStatusWords(state)}, so this ${noun}'s traffic is stopped.`
  if (route === 'down') return `Nym is not answering, so this ${noun}'s traffic is stopped.`
  const base = `This ${noun}'s traffic goes through Nym.`
  if (state.state === 'ready') return `${base} ${nymStatusWords(state)}${state.reason === undefined ? '' : `. ${state.reason}`}`
  return state.state === 'connecting' ? `${base} ${nymStatusWords(state)}` : base
}
