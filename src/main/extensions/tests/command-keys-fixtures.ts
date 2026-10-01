// A stand-in for the command keys an `ExtensionsApi` carries, for tests that
// build one without caring about shortcuts.
import type { AssignOutcome } from '../extension-commands.js'
import type { ExtensionCommandGroup, ExtensionCommandKeys } from '../extension-commands-runner.js'

export function fakeCommandKeys (overrides: Partial<ExtensionCommandKeys> = {}): ExtensionCommandKeys {
  const none: AssignOutcome = { status: 'invalid', problem: 'unsupported' }
  const groups: ExtensionCommandGroup[] = []
  return {
    platform: 'linux',
    capsOf: () => [],
    ready: () => {},
    whenReady: async () => {},
    handles: () => false,
    run: () => false,
    isRecording: () => false,
    record: () => {},
    beginRecording: () => false,
    cancelRecording: () => {},
    clear: () => false,
    move: () => none,
    groups: () => groups,
    getAll: () => [],
    onChange: () => () => {},
    ...overrides
  }
}
