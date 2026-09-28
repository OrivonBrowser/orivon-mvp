// The profiles as the rest of the shell uses them: this process's own, the
// list, changes to them, and starting a browser for one. Starting one is
// handing it to another process (./peer-spawn.ts), so what this holds is the
// data and the request, never a second browser inside this one.
import { removePrivateDir, createPrivateDir } from './private-session.js'
import { flagsFor, DEFAULT_PROFILE_ID } from './launch-context.js'
import { spawnPeer } from './peer-spawn.js'
import type { Profile } from './profile-store.js'
import type { Outcome } from './profile-store.js'
import type { Runtime } from './start-launch.js'

export interface ProfileRow extends Profile {
  readonly running: boolean
  /** The profile this process is. */
  readonly current: boolean
}

export interface ProfileLook {
  readonly name: string
  readonly color: string
  readonly isPrivate: boolean
  /** Whether the chrome shows it: there is more than one profile, or this is a private session. */
  readonly shown: boolean
}

export class ProfilesService {
  private readonly listeners = new Set<() => void>()

  constructor (private readonly runtime: Runtime, private readonly spawn: typeof spawnPeer = spawnPeer) {}

  get isPrivate (): boolean {
    return this.runtime.isPrivate
  }

  list (): ProfileRow[] {
    return this.runtime.profiles.list().map((profile) => ({ ...profile, running: this.runtime.profiles.isRunning(profile.id), current: profile.id === this.runtime.profileId }))
  }

  /** How this process's profile shows in the chrome. */
  look (): ProfileLook {
    if (this.runtime.isPrivate) return { name: 'Private', color: 'purple', isPrivate: true, shown: true }
    const own = this.runtime.profiles.read(this.runtime.profileId)
    return { name: own?.name ?? 'Profile', color: own?.color ?? 'blue', isPrivate: false, shown: this.runtime.profiles.list().length > 1 }
  }

  create (name: unknown, color: unknown): ReturnType<Runtime['profiles']['create']> {
    // The light client's checkpoint is public and a new profile starts faster, and safer, with it.
    const result = this.runtime.profiles.create(name, color, ['verifier'])
    if (result.ok) this.notify()
    return result
  }

  rename (id: string, name: unknown): Outcome {
    const result = this.runtime.profiles.rename(id, name)
    if (result.ok) this.notify()
    return result
  }

  setColor (id: string, color: unknown): Outcome {
    const result = this.runtime.profiles.setColor(id, color)
    if (result.ok) this.notify()
    return result
  }

  /** Never the profile this process is: deleting the data of a browser that is running would only break it. */
  remove (id: string): Outcome {
    if (id === this.runtime.profileId) return { ok: false, reason: 'running' }
    const result = this.runtime.profiles.remove(id)
    if (result.ok) this.notify()
    return result
  }

  /** Starts a browser for a profile, or brings the one running forward (its second start hands over and stops). */
  open (id: string): boolean {
    if (this.runtime.profiles.read(id) === null || (id === this.runtime.profileId && !this.runtime.isPrivate)) return false
    this.spawn(this.runtime.source, [...this.runtime.inherit, ...(id === DEFAULT_PROFILE_ID ? [] : flagsFor({ kind: 'profile', id }))])
    return true
  }

  /** Starts a private session: a fresh directory holding this profile's settings, and a process of its own for it. Deleted when it ends. */
  openPrivate (): void {
    const dir = createPrivateDir(this.runtime.dir, this.runtime.launch.home)
    try {
      const child = this.spawn(this.runtime.source, [...this.runtime.inherit, ...flagsFor({ kind: 'private', dir })])
      child.once('exit', () => { removePrivateDir(dir) })
      child.once('error', () => { removePrivateDir(dir) })
    } catch {
      removePrivateDir(dir)
    }
  }

  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify (): void {
    for (const listener of [...this.listeners]) listener()
  }
}
