// What the tab search page may ask main to do. The page is untrusted: each request is checked field by field
// and anything else is dropped.
export type TabSearchRequest =
  | { readonly type: 'activate', readonly id: string }
  | { readonly type: 'close', readonly id: string }
  | { readonly type: 'reopen', readonly entryId: number }

const MAX_ID_LENGTH = 64

export function asRequest (command: unknown): TabSearchRequest | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, id, entryId } = command as Record<string, unknown>
  if ((type === 'activate' || type === 'close') && typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH) return { type, id }
  if (type === 'reopen' && typeof entryId === 'number' && Number.isSafeInteger(entryId)) return { type, entryId }
  return undefined
}
