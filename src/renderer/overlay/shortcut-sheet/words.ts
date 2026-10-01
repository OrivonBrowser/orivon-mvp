// What the "Create shortcut" sheet says once main has answered.
export type Result = { readonly ok: true, readonly where: 'applications' | 'desktop' } | { readonly ok: false, readonly reason: 'unsupported' | 'failed' }

/** A reply that is not one of main's is a failure too. */
export function resultWords (result: Result | undefined): { tone: 'ok' | 'error', text: string } {
  if (result?.ok === true) {
    return { tone: 'ok', text: result.where === 'desktop' ? 'Shortcut added to your desktop.' : 'Shortcut added to your applications menu.' }
  }
  if (result?.ok === false && result.reason === 'unsupported') return { tone: 'error', text: 'Shortcuts are not available on this system.' }
  return { tone: 'error', text: 'Could not create the shortcut. Check that the folder can be written to.' }
}
