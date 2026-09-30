// A page that has stopped answering never settles the calls made into it (a dead renderer, a wedged
// print path), so every wait on a page is bounded and a timeout reads as a failure.

export class TimedOut extends Error {
  constructor (what: string) { super(`${what} did not answer in time`) }
}

export async function withTimeout<T> (work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new TimedOut(what)) }, ms) })
  try {
    return await Promise.race([work, late])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
