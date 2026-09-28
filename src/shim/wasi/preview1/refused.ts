// The preview1 calls this host does not serve, each refused by name with
// a console line, never a silent stub (A135).

import type { HostContext } from '../context.js'
import { Errno } from '../errno.js'
import type { ImportFamily } from './family.js'
import { Fstflags } from './flags.js'

const NO_SYMLINKS = 'orivon.fs has no links'
const NO_TIMES = 'orivon.fs cannot set file times'
const NO_SIGNALS = 'a WASI program has no signals here'

export function refusedFunctions (ctx: HostContext): ImportFamily {
  const refuse = (call: string, why: string, errno: number = Errno.NOTSUP) => {
    ctx.warnOnce(call, why)
    return errno
  }
  // A contradictory request is INVAL on every runtime, before any question of support.
  const setTimes = (call: string, fstFlags: number) => {
    const both = (a: number, b: number) => (fstFlags & a) !== 0 && (fstFlags & b) !== 0
    if (both(Fstflags.ATIM, Fstflags.ATIM_NOW) || both(Fstflags.MTIM, Fstflags.MTIM_NOW)) return Errno.INVAL
    return refuse(call, NO_TIMES)
  }
  // Preview 1 sockets act only on a descriptor the host handed over, and
  // this host hands over none, so a valid descriptor is never a socket.
  const socketCall = (fd: number) => ctx.fds.get(fd) === undefined ? Errno.BADF : Errno.NOTSOCK

  return {
    sync: {
      path_symlink: () => refuse('path_symlink', NO_SYMLINKS),
      path_link: () => refuse('path_link', NO_SYMLINKS),
      path_filestat_set_times: (_fd: number, _flags: number, _path: number, _len: number, _atim: bigint, _mtim: bigint, fstFlags: number) =>
        setTimes('path_filestat_set_times', fstFlags),
      fd_filestat_set_times: (_fd: number, _atim: bigint, _mtim: bigint, fstFlags: number) => setTimes('fd_filestat_set_times', fstFlags),
      proc_raise: () => refuse('proc_raise', NO_SIGNALS, Errno.NOSYS),
      sock_accept: socketCall,
      sock_recv: socketCall,
      sock_send: socketCall,
      sock_shutdown: socketCall
    },
    ops: {}
  }
}
