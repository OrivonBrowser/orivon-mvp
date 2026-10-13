// Runtime shape check for everything the Nym tunnel host posts to main over its parent port. The host runs
// WebAssembly that talks to the network, so a message is checked structurally before anything acts on it.

import { MAX_FAILURE_MESSAGE } from '../../protocols/nym-tunnel/protocol.js'
import type { FailureStage, FromHost } from '../../protocols/nym-tunnel/protocol.js'

const STAGES: readonly FailureStage[] = ['artifact', 'load', 'listen', 'run']
const MAX_COUNT = 10_000

function isCount (value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT
}

export function isFromHost (message: unknown): message is FromHost {
  if (typeof message !== 'object' || message === null) return false
  const record = message as Record<string, unknown>
  switch (record['type']) {
    case 'listening': return true
    case 'instances': return isCount(record['connecting']) && isCount(record['ready']) && isCount(record['started']) && (record['problem'] === undefined || (typeof record['problem'] === 'string' && record['problem'].length <= MAX_FAILURE_MESSAGE))
    case 'failed': return STAGES.includes(record['stage'] as FailureStage) && typeof record['message'] === 'string' && record['message'].length <= MAX_FAILURE_MESSAGE
    default: return false
  }
}
