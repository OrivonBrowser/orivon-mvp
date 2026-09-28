// What the Settings page may ask about usage statistics: the choice made, the
// literal payload that would be sent, and what has been sent, and to make the
// choice again. Nothing is sent before a choice (ADR-0004), so an undecided
// state is shown as undecided and never as either answer. A private session
// measures nothing, so it has nothing to show and nothing to decide.
import type { App } from 'electron'
import { DISCLOSURE_OPTIONS } from '../../telemetry/disclosure.js'
import type { DisclosureChoiceId } from '../../telemetry/disclosure.js'
import { decideConsent, getConsentState, getSentHistory, previewDisclosurePayload } from '../../telemetry/runner.js'
import type { InternalDomain } from './internal-ipc.js'

export function telemetryDomain (app: App, isPrivate: boolean): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, option?: unknown }
      if (isPrivate) return request.type === 'status' ? { private: true } : undefined
      switch (request.type) {
        case 'status': {
          const [consent, payload, history] = await Promise.all([getConsentState(app), previewDisclosurePayload(app), getSentHistory(app)])
          return { private: false, consent, options: DISCLOSURE_OPTIONS, payload, sent: history.entries }
        }
        case 'decide': {
          const option = DISCLOSURE_OPTIONS.find((candidate) => candidate.id === request.option)
          if (option === undefined) return { ok: false }
          await decideConsent(app, option.id as DisclosureChoiceId)
          return { ok: true }
        }
        default:
          return undefined
      }
    }
  }
}
