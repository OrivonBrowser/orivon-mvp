// A bound on a call that may never return: a change of a session's proxy, the question which proxy a session would use.
// Pure: no `electron` import.

/** `work`, or a rejection with `message` once `ms` have passed. The work itself is not stopped. */
export async function within<T> (work: Promise<T>, ms: number, message = 'a call did not finish'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(message)) }, ms) })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}
