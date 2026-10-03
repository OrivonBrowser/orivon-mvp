import { randomUUID } from 'node:crypto'
import { app, Notification } from 'electron'
import type { Extension } from 'electron'
import type { ExtensionContext } from '../context'
import type { ExtensionEvent } from '../router'
import { validateExtensionResource } from './common'

enum TemplateType {
  Basic = 'basic',
  Image = 'image',
  List = 'list',
  Progress = 'progress',
}

const getBody = (opts: chrome.notifications.NotificationOptions) => {
  const { type = TemplateType.Basic } = opts

  switch (type) {
    case TemplateType.List: {
      if (!Array.isArray(opts.items)) {
        throw new Error('List items must be provided for list type')
      }
      return opts.items.map((item) => `${item.title} - ${item.message}`).join('\n')
    }
    default:
      return opts.message || ''
  }
}

const getUrgency = (
  priority?: number,
): Required<Electron.NotificationConstructorOptions>['urgency'] => {
  if (typeof priority !== 'number') {
    return 'normal'
  } else if (priority >= 2) {
    return 'critical'
  } else if (priority < 0) {
    return 'low'
  } else {
    return 'normal'
  }
}

const createScopedIdentifier = (extension: Extension, id: string) => `${extension.id}-${id}`
const stripScopeFromIdentifier = (id: string) => {
  const index = id.indexOf('-')
  return id.substr(index + 1)
}

export class NotificationsAPI {
  private registry = new Map<string, Notification>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    // Orivon patch: all five now declare `permission: 'notifications'`
    // (router.ts's own `permission` handler option) -- unset, any loaded
    // extension could raise OS notifications regardless of its declared
    // permissions. The renderer's own `notifications` factory gets a
    // matching `shouldInject` (UPSTREAM.md), the same shape `cookies` and
    // `webNavigation` already use.
    handle('notifications.clear', this.clear, { permission: 'notifications' })
    handle('notifications.create', this.create, { permission: 'notifications' })
    handle('notifications.getAll', this.getAll, { permission: 'notifications' })
    handle('notifications.getPermissionLevel', this.getPermissionLevel, { permission: 'notifications' })
    handle('notifications.update', this.update, { permission: 'notifications' })

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      for (const [key, notification] of this.registry) {
        if (key.startsWith(extension.id)) {
          notification.close()
        }
      }
    })
  }

  private clear = ({ extension }: ExtensionEvent, id: string) => {
    const notificationId = createScopedIdentifier(extension, id)
    if (this.registry.has(notificationId)) {
      this.registry.get(notificationId)?.close()
    }
  }

  private create = async ({ extension }: ExtensionEvent, arg1: unknown, arg2?: unknown) => {
    let id: string
    let opts: chrome.notifications.NotificationOptions

    if (typeof arg1 === 'object') {
      id = randomUUID()
      opts = arg1 as chrome.notifications.NotificationOptions
    } else if (typeof arg1 === 'string') {
      id = arg1
      opts = arg2 as chrome.notifications.NotificationOptions
    } else {
      throw new Error('Invalid arguments')
    }

    if (typeof opts !== 'object' || !opts.type || !opts.iconUrl || !opts.title || !opts.message) {
      throw new Error('Missing required notification options')
    }

    const notificationId = createScopedIdentifier(extension, id)

    if (this.registry.has(notificationId)) {
      this.registry.get(notificationId)?.close()
    }

    let icon

    if (opts.iconUrl) {
      let url
      try {
        url = new URL(opts.iconUrl)
      } catch {}

      if (url?.protocol === 'data:') {
        icon = opts.iconUrl
      } else {
        icon = await validateExtensionResource(extension, opts.iconUrl)
      }

      if (!icon) {
        throw new Error('Invalid iconUrl')
      }
    }

    // TODO: buttons, template types

    const notification = new Notification({
      title: opts.title,
      subtitle: app.name,
      body: getBody(opts),
      silent: opts.silent,
      icon,
      urgency: getUrgency(opts.priority),
      timeoutType: opts.requireInteraction ? 'never' : 'default',
      // Orivon patch: cast -- root tsconfig's exactOptionalPropertyTypes
      // (vendor/tsconfig.json does not set it) refuses `silent`/`icon`
      // typed `T | undefined` for an optional field declared `field?: T`;
      // Electron's own constructor treats an explicit `undefined` the same
      // as the field being absent, so this changes no behaviour.
    } as Electron.NotificationConstructorOptions)

    this.registry.set(notificationId, notification)

    notification.on('click', () => {
      this.ctx.router.sendEvent(extension.id, 'notifications.onClicked', id)
    })

    notification.once('close', () => {
      // Orivon patch (UPSTREAM.md patch 66): a notification replaced under the same id closes
      // after its replacement is registered, and must neither remove that entry nor be reported.
      if (this.registry.get(notificationId) !== notification) return
      const byUser = true // TODO
      this.ctx.router.sendEvent(extension.id, 'notifications.onClosed', id, byUser)
      this.registry.delete(notificationId)
    })

    notification.show()

    return id
  }

  private getAll = ({ extension }: ExtensionEvent) => {
    return Array.from(this.registry.keys())
      .filter((key) => key.startsWith(extension.id))
      .map(stripScopeFromIdentifier)
  }

  private getPermissionLevel = (event: ExtensionEvent) => {
    return Notification.isSupported() ? 'granted' : 'denied'
  }

  private update = (
    { extension }: ExtensionEvent,
    id: string,
    opts: chrome.notifications.NotificationOptions,
  ) => {
    const notificationId = createScopedIdentifier(extension, id)

    const notification = this.registry.get(notificationId)

    if (!notification) {
      return false
    }

    // TODO: remaining opts

    if (opts.priority) notification.urgency = getUrgency(opts.priority)
    if (opts.silent) notification.silent = opts.silent
  }
}
