// A document the system hands to the running browser (macOS's `open-file`: Open with, a drop on the dock icon) joins the queue a
// second launch's addresses join, so one rule decides what may be opened. A path becomes a `file:` URL here; nothing else does.
import { localOperandUrl } from '../launch/local-operand.js'

export interface OpenFileEvent {
  preventDefault: () => void
}

/** Claims the event and queues the file's address when `path` is a file or folder that exists; anything else is dropped, as it is on a command line. */
export function handleOpenFile (event: OpenFileEvent, path: string, queue: (urls: string[]) => void): void {
  event.preventDefault()
  const url = localOperandUrl(path, '/')
  if (url !== null) queue([url])
}
