/**
 * Imports the verifier subsystem once, for a test file whose tests each start it from fresh module state
 * (`vi.resetModules()`, then an `await import`).
 *
 * The first import transforms the subsystem's whole module graph, which takes seconds on a busy machine, and
 * vitest charges an import made inside a test to that test's own timeout. Called at the top of the file, it is
 * charged to the file's collection instead; each test's reset then re-evaluates modules whose transforms are
 * cached, tens of milliseconds. The reset still gives every test fresh module state.
 */
export async function loadSubsystemGraphOnce (): Promise<void> {
  await import('../verifier-subsystem.js')
}
