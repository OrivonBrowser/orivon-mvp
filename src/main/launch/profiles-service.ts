// The profiles as the rest of the shell uses them: this process's own, the
// list, changes to them, and starting a browser for one. Starting one is
// handing it to another process (./peer-spawn.ts), so what this holds is the
// data and the request, never a second browser inside this one.
import { removePrivateDir, createPrivateDir } from './private-session.js'
import { flagsFor, urlsFromArgv, DEFAULT_PROFILE_ID } from './launch-context.js'
import { spawnPeer } from './peer-spawn.js'
import { watchProfiles } from './profiles-watcher.js'
import type { ProfilesWatcher } from './profiles-watcher.js'
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
  private watcher: ProfilesWatcher | undefined

  /** `kiosk`: this process is a kiosk, which starts no other browser: a second one would have the chrome the kiosk hides. */
  constructor (private readonly runtime: Runtime, private readonly spawn: typeof spawnPeer = spawnPeer, private readonly kiosk = false) {}

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
    const result = this.runtime.profiles.create(name, color, true)
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
    if (id !== DEFAULT_PROFILE_ID && id === this.runtime.profileId) return { ok: false, reason: 'running' }
    const result = this.runtime.profiles.remove(id)
    if (result.ok) this.notify()
    return result
  }

  /** Starts a browser for a profile, or opens a window in the one running (its second start hands over and stops). */
  open (id: string): boolean {
    if (this.kiosk || this.runtime.profiles.read(id) === null || (id === this.runtime.profileId && !this.runtime.isPrivate)) return false
    try {
      this.spawn(this.runtime.source, [...this.runtime.inherit, ...(id === DEFAULT_PROFILE_ID ? [] : flagsFor({ kind: 'profile', id }))])
      return true
    } catch (error) {
      console.error(`could not start the profile: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** Starts a private session: a fresh directory holding this profile's settings, and a process of its own for it. Deleted when it ends.
   * A shortcut calls this from an event handler, where a throw would end the browser: a failure is reported, not raised.
   * `url` is opened in it when it is an http or https address; anything else is dropped rather than passed on. */
  openPrivate (url?: string): boolean {
    if (this.kiosk) return false
    let dir: string | null = null
    try {
      const made = createPrivateDir(this.runtime.dir, this.runtime.launch.home)
      dir = made
      const address = url === undefined ? [] : urlsFromArgv([url])
      const child = this.spawn(this.runtime.source, [...this.runtime.inherit, ...flagsFor({ kind: 'private', dir: made }), ...address])
      child.once('exit', () => { removePrivateDir(made) })
      child.once('error', () => { removePrivateDir(made) })
      return true
    } catch (error) {
      if (dir !== null) removePrivateDir(dir)
      console.error(`could not start a private session: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Starts watching for a change another profile's own process makes to the
   * shared registry (profiles-watcher.ts's own header). Never called from a
   * plain `new ProfilesService(runtime)` in a test -- only main/index.ts's
   * real boot -- so no test gains a real `fs.watch` it did not ask for.
   * Idempotent.
   */
  startWatching (): void {
    if (this.watcher !== undefined) return
    this.watcher = watchProfiles(this.runtime.profiles.registryDir, () => { this.notify() })
  }

  /** Stops the watcher `startWatching` began, if any. Call once, at quit. */
  stopWatching (): void {
    this.watcher?.close()
    this.watcher = undefined
  }

  private notify (): void {
    for (const listener of [...this.listeners]) listener()
  }
}
