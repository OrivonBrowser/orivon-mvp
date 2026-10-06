// What the Settings page may ask about usage statistics: whether they are on, the literal text of the
// two reports that would be sent and what has been sent, to turn them on or off, and to delete what the
// server holds. Nothing is sent before a choice (ADR-0004), so an undecided state is shown as undecided
// and never as either answer. A private session measures nothing, and a development build or a test
// launch never runs telemetry: neither has anything to decide.
import { eraseTelemetry, getTelemetryStatus, setTelemetryOn } from '../../telemetry/runner.js'
import type { InternalDomain } from './internal-ipc.js'

export function telemetryDomain (isPrivate: boolean): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, on?: unknown }
      if (isPrivate) return request.type === 'status' ? { private: true } : undefined
      switch (request.type) {
        case 'status': {
          const reply = await getTelemetryStatus()
          return reply.off === undefined ? { private: false, ...reply.status } : { private: false, off: reply.off }
        }
        case 'set':
          if (typeof request.on !== 'boolean') return { ok: false }
          return { ok: await setTelemetryOn(request.on, 'settings') }
        case 'erase': {
          const outcome = await eraseTelemetry()
          return { ok: outcome === 'done', nothing: outcome === 'nothing' }
        }
        default:
          return undefined
      }
    }
  }
}
