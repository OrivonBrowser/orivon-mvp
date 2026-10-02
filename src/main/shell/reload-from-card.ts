// A tab manager's reload, asked for from the site card: the card closes first,
// so it cannot go on telling the person to reload the page that just did.
interface Card { close: () => void }
interface ReloadableTabs {
  getState: () => { activeTabId: string | null }
  reload: (id: string) => void
}

/** Closes the card, then reloads the tab in front. */
export function reloadFromCard (card: Card, tabs: ReloadableTabs): void {
  card.close()
  const { activeTabId } = tabs.getState()
  if (activeTabId !== null) tabs.reload(activeTabId)
}
