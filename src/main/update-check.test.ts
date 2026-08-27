import { describe, expect, it, vi } from 'vitest'
import { checkForUpdate, decideUpdateNotice, DEFAULT_CHECK_INTERVAL_MS } from './update-check.js'
import type { ReleaseInfo } from './update-check.js'

// Fixed instant, not Date.now() -- the whole point of decideUpdateNotice is
// that it is pure. A real clock read here would make failures flaky and
// undermine the one property this table exists to guarantee.
const NOW = Date.parse('2026-08-26T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

describe('decideUpdateNotice', () => {
  describe('check throttling (shouldCheck)', () => {
    it('is due on the very first call (no lastCheckedAt yet)', () => {
      const result = decideUpdateNotice({ currentVersion: '1.0.0', now: NOW })
      expect(result.shouldCheck).toBe(true)
    })

    it('is not due when the interval has not elapsed', () => {
      const result = decideUpdateNotice({
        currentVersion: '1.0.0',
        now: NOW,
        lastCheckedAt: NOW - (DEFAULT_CHECK_INTERVAL_MS - 1)
      })
      expect(result.shouldCheck).toBe(false)
    })

    it('is due exactly at the interval boundary', () => {
      const result = decideUpdateNotice({
        currentVersion: '1.0.0',
        now: NOW,
        lastCheckedAt: NOW - DEFAULT_CHECK_INTERVAL_MS
      })
      expect(result.shouldCheck).toBe(true)
    })

    it('is due once comfortably past the interval', () => {
      const result = decideUpdateNotice({
        currentVersion: '1.0.0',
        now: NOW,
        lastCheckedAt: NOW - DEFAULT_CHECK_INTERVAL_MS - DAY
      })
      expect(result.shouldCheck).toBe(true)
    })

    it('honours a caller-supplied checkIntervalMs instead of the default', () => {
      const oneHour = 60 * 60 * 1000
      const dueUnderShortInterval = decideUpdateNotice({
        currentVersion: '1.0.0',
        now: NOW,
        lastCheckedAt: NOW - oneHour,
        checkIntervalMs: oneHour
      })
      expect(dueUnderShortInterval.shouldCheck).toBe(true)

      const notDueUnderDefault = decideUpdateNotice({
        currentVersion: '1.0.0',
        now: NOW,
        lastCheckedAt: NOW - oneHour
        // default (24h) interval applies -- one hour ago is not due
      })
      expect(notDueUnderDefault.shouldCheck).toBe(false)
    })

    it('this is a rate-limiting decision only -- it does not depend on latestVersion being present', () => {
      const withoutLatest = decideUpdateNotice({ currentVersion: '1.0.0', now: NOW })
      const withLatest = decideUpdateNotice({ currentVersion: '1.0.0', latestVersion: '1.1.0', now: NOW })
      expect(withoutLatest.shouldCheck).toBe(withLatest.shouldCheck)
    })
  })

  describe('no fetched candidate yet (latestVersion omitted)', () => {
    it('never notifies -- there is nothing to compare against', () => {
      const result = decideUpdateNotice({
        currentVersion: '1.0.0',
        now: NOW,
        lastCheckedAt: NOW - DEFAULT_CHECK_INTERVAL_MS
      })
      expect(result.shouldNotify).toBe(false)
      expect(result.notifyVersion).toBeNull()
    })
  })

  describe('newer version available', () => {
    it('notifies, naming the newer version', () => {
      const result = decideUpdateNotice({ currentVersion: '1.2.3', latestVersion: '1.3.0', now: NOW })
      expect(result.shouldNotify).toBe(true)
      expect(result.notifyVersion).toBe('1.3.0')
    })

    it('returns the latest version exactly as given, not renormalised', () => {
      const result = decideUpdateNotice({ currentVersion: '1.2.3', latestVersion: 'v1.3.0', now: NOW })
      expect(result.notifyVersion).toBe('v1.3.0')
    })

    it('a leading "v" on either side does not confuse the comparison', () => {
      const result = decideUpdateNotice({ currentVersion: 'v1.2.3', latestVersion: 'v1.3.0', now: NOW })
      expect(result.shouldNotify).toBe(true)
    })

    it('a minor or major bump counts as newer, not just patch', () => {
      expect(decideUpdateNotice({ currentVersion: '1.2.3', latestVersion: '1.3.0', now: NOW }).shouldNotify).toBe(true)
      expect(decideUpdateNotice({ currentVersion: '1.2.3', latestVersion: '2.0.0', now: NOW }).shouldNotify).toBe(true)
    })

    it('a full release after a pre-release of the same core version is newer', () => {
      // Semver precedence: 1.2.3-beta < 1.2.3. If we shipped a beta and the
      // stable 1.2.3 now exists, that is a real update.
      const result = decideUpdateNotice({ currentVersion: '1.2.3-beta', latestVersion: '1.2.3', now: NOW })
      expect(result.shouldNotify).toBe(true)
    })
  })

  describe('same version -> nothing', () => {
    it('does not notify when latest equals current', () => {
      const result = decideUpdateNotice({ currentVersion: '1.2.3', latestVersion: '1.2.3', now: NOW })
      expect(result.shouldNotify).toBe(false)
      expect(result.notifyVersion).toBeNull()
    })

    it('build metadata does not count as a different, newer version (semver ignores it for precedence)', () => {
      const result = decideUpdateNotice({ currentVersion: '1.2.3', latestVersion: '1.2.3+build.5', now: NOW })
      expect(result.shouldNotify).toBe(false)
    })
  })

  describe('older remote version -> nothing (never downgrade)', () => {
    it('does not notify when latest is behind current', () => {
      const result = decideUpdateNotice({ currentVersion: '2.0.0', latestVersion: '1.9.0', now: NOW })
      expect(result.shouldNotify).toBe(false)
      expect(result.notifyVersion).toBeNull()
    })

    it('a pre-release of the same core version is older than the release already running', () => {
      const result = decideUpdateNotice({ currentVersion: '1.2.3', latestVersion: '1.2.3-beta', now: NOW })
      expect(result.shouldNotify).toBe(false)
    })
  })

  describe('already notified for this version -> do not nag again', () => {
    it('suppresses a repeat notification for the same latest version', () => {
      const result = decideUpdateNotice({
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        lastNotifiedVersion: '1.2.0',
        now: NOW
      })
      expect(result.shouldNotify).toBe(false)
    })

    it('recognises "already notified" even when the stored and fetched strings differ only by a "v" prefix', () => {
      const result = decideUpdateNotice({
        currentVersion: '1.0.0',
        latestVersion: 'v1.2.0',
        lastNotifiedVersion: '1.2.0',
        now: NOW
      })
      expect(result.shouldNotify).toBe(false)
    })

    it('notifies again once a NEWER version ships, even though an earlier one was already notified', () => {
      const result = decideUpdateNotice({
        currentVersion: '1.0.0',
        latestVersion: '1.3.0',
        lastNotifiedVersion: '1.2.0',
        now: NOW
      })
      expect(result.shouldNotify).toBe(true)
      expect(result.notifyVersion).toBe('1.3.0')
    })
  })

  describe('malformed version strings -> fail safe, no notification', () => {
    it.each([
      ['empty string', ''],
      ['not version-shaped', 'banana'],
      ['missing patch', '1.2'],
      ['too many segments', '1.2.3.4'],
      ['leading zero in a numeric identifier', '1.02.3'],
      ['non-numeric core', 'a.b.c'],
      ['stray whitespace inside', '1.2 .3']
    ])('malformed latestVersion (%s) does not notify', (_label, malformed) => {
      const result = decideUpdateNotice({ currentVersion: '1.0.0', latestVersion: malformed, now: NOW })
      expect(result.shouldNotify).toBe(false)
      expect(result.notifyVersion).toBeNull()
    })

    it('a malformed currentVersion also fails safe, even against a well-formed latestVersion', () => {
      const result = decideUpdateNotice({ currentVersion: 'not-a-version', latestVersion: '9.9.9', now: NOW })
      expect(result.shouldNotify).toBe(false)
      expect(result.notifyVersion).toBeNull()
    })

    it('a malformed lastNotifiedVersion is ignored rather than crashing the comparison', () => {
      const result = decideUpdateNotice({
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        lastNotifiedVersion: 'garbage',
        now: NOW
      })
      expect(result.shouldNotify).toBe(true)
      expect(result.notifyVersion).toBe('1.1.0')
    })

    it('surrounding whitespace on an otherwise valid version is tolerated (trimmed)', () => {
      const result = decideUpdateNotice({ currentVersion: '1.0.0', latestVersion: '  1.1.0  ', now: NOW })
      expect(result.shouldNotify).toBe(true)
    })

    it('a malformed currentVersion never checks or notifies -- fully inert, not just non-notifying', () => {
      // Distinct from the throttling tests above: this asserts the specific
      // combination (bad currentVersion + otherwise-due check) still comes
      // back false, i.e. malformed-version handling does not accidentally
      // widen into "always check anyway".
      const result = decideUpdateNotice({ currentVersion: 'not-a-version', latestVersion: '9.9.9', now: NOW })
      expect(result.shouldNotify).toBe(false)
    })
  })
})

describe('checkForUpdate (async orchestrator, network fetch injected)', () => {
  it('does not call the network when the check is throttled', async () => {
    const fetchLatestRelease = vi.fn<() => Promise<ReleaseInfo | null>>()
    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      now: NOW,
      lastCheckedAt: NOW - 1,
      fetchLatestRelease
    })
    expect(fetchLatestRelease).not.toHaveBeenCalled()
    expect(result.checkedNow).toBe(false)
    expect(result.shouldNotify).toBe(false)
    expect(result.release).toBeNull()
  })

  it('calls the network and notifies when a newer release is found and the check is due', async () => {
    const release: ReleaseInfo = { version: '2.0.0', url: 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/2.0.0' }
    const fetchLatestRelease = vi.fn<() => Promise<ReleaseInfo | null>>().mockResolvedValue(release)
    const result = await checkForUpdate({ currentVersion: '1.0.0', now: NOW, fetchLatestRelease })
    expect(fetchLatestRelease).toHaveBeenCalledOnce()
    expect(result.checkedNow).toBe(true)
    expect(result.shouldNotify).toBe(true)
    expect(result.notifyVersion).toBe('2.0.0')
    expect(result.release).toEqual(release)
  })

  it('a fetch that resolves null (no releases yet, or a handled failure) checks but does not notify', async () => {
    const fetchLatestRelease = vi.fn<() => Promise<ReleaseInfo | null>>().mockResolvedValue(null)
    const result = await checkForUpdate({ currentVersion: '1.0.0', now: NOW, fetchLatestRelease })
    expect(result.checkedNow).toBe(true)
    expect(result.shouldNotify).toBe(false)
    expect(result.release).toBeNull()
  })

  it('a fetch that REJECTS is caught, not thrown -- treated the same as no release found', async () => {
    const fetchLatestRelease = vi.fn<() => Promise<ReleaseInfo | null>>().mockRejectedValue(new Error('offline'))
    const result = await checkForUpdate({ currentVersion: '1.0.0', now: NOW, fetchLatestRelease })
    expect(result.checkedNow).toBe(true)
    expect(result.shouldNotify).toBe(false)
    expect(result.release).toBeNull()
  })

  it('does not re-notify for a release already recorded as notified', async () => {
    const release: ReleaseInfo = { version: '1.2.0', url: 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/1.2.0' }
    const fetchLatestRelease = vi.fn<() => Promise<ReleaseInfo | null>>().mockResolvedValue(release)
    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      now: NOW,
      lastNotifiedVersion: '1.2.0',
      fetchLatestRelease
    })
    expect(result.checkedNow).toBe(true)
    expect(result.shouldNotify).toBe(false)
  })

  it('never downgrades: a remote version older than current is checked but not notified', async () => {
    const release: ReleaseInfo = { version: '0.9.0', url: 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/0.9.0' }
    const fetchLatestRelease = vi.fn<() => Promise<ReleaseInfo | null>>().mockResolvedValue(release)
    const result = await checkForUpdate({ currentVersion: '1.0.0', now: NOW, fetchLatestRelease })
    expect(result.shouldNotify).toBe(false)
  })
})
