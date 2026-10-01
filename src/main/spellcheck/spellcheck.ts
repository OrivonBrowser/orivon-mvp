// Which sessions check spelling, and making them follow the setting. A
// Session does not say which partition it is, so the sessions to switch are
// the ones a tab was seen to use: the shell's own UI session and the sessions
// of embedded and child pages are never among them.

export interface SpellSession {
  setSpellCheckerEnabled: (enabled: boolean) => void
}

export class SpellcheckSessions {
  private readonly sessions = new Set<SpellSession>()

  constructor (private readonly enabled: () => boolean) {}

  /** Switches a tab's session to the setting, and keeps it there on later changes. */
  track (session: SpellSession): void {
    if (this.sessions.has(session)) return
    this.sessions.add(session)
    session.setSpellCheckerEnabled(this.enabled())
  }

  /** Puts every tracked session back in line with the setting. */
  refresh (): void {
    const on = this.enabled()
    for (const session of this.sessions) session.setSpellCheckerEnabled(on)
  }
}
