export interface ChordEvent {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly isComposing: boolean
  readonly repeat: boolean
}

/** The browser's default find key: Ctrl+F, or Cmd+F on macOS. Only the default binding: a rebound key is not told to the page. */
export function isFindChord (event: ChordEvent, platform: string): boolean {
  if (event.key.toLowerCase() !== 'f' || event.isComposing || event.repeat || event.altKey || event.shiftKey) return false
  return platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
