import {
    Composer,
    Context,
    Filter,
    Middleware,
    MiddlewareObj,
} from './deps.deno.ts'
import {
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LoginUrl,
} from './deps.deno.ts'

const textEncoder = new TextEncoder()
function countBytes(str: string): number {
    return textEncoder.encode(str).length
}

export interface MenuControls<C extends Context> {
    menu: {
        current: Menu<C>
        update: () => Promise<void>
        back: () => Promise<void>
        nav: (to: string) => Promise<void>
    }
}

type MenuContext<C extends Context> = MenuControls<C> &
    Filter<C, 'callback_query:data'>

type MenuButton<C extends Context> = RemoveAllTexts<InlineKeyboardButton> & {
    /**
     * Label text on the button, or a function that can generate this text.
     * The function is supplied with the context object that is used to make
     * the request.
     */
    text: string | ((ctx: C) => string | Promise<string>)
}
type RemoveAllTexts<T> = T extends { text: string } ? Omit<T, 'text'> : T

export class Menu<C extends Context = Context>
    implements MiddlewareObj<C>, InlineKeyboardMarkup {
    private readonly id: string
    private readonly buttons: MenuButton<C>[][] = [[]]

    private parent: Menu<C> | undefined = undefined
    private readonly subMenus = new Map<string, Menu<C>>()

    private readonly mw = new Map<string, Array<Middleware<MenuContext<C>>>>()

    private readonly autoAnswer: boolean

    constructor(id: string, autoAnswer = true) {
        if (id.includes('/'))
            throw new Error(`You cannot use '/' in a menu identifier ('${id}')`)
        this.id = id
        this.autoAnswer = autoAnswer
    }

    public readonly inline_keyboard = new Proxy([], {
        get: () => {
            throw new Error(
                `Cannot send menu '${this.id}'! Did you forget to use bot.use() for it, or for a parent menu?`
            )
        },
    })

    private add(button: MenuButton<C>) {
        this.buttons[this.buttons.length - 1]?.push(button)
        return this
    }

    row() {
        this.buttons.push([])
        return this
    }

    url(text: string, url: string) {
        return this.add({ text, url })
    }

    login(text: string, loginUrl: string | LoginUrl) {
        return this.add({
            text,
            login_url:
                typeof loginUrl === 'string' ? { url: loginUrl } : loginUrl,
        })
    }

    text(
        text: string | ((ctx: C) => string | Promise<string>),
        ...middleware: Array<Middleware<MenuContext<C>>>
    ) {
        const row = this.buttons.length - 1
        const col = this.buttons[row]!.length
        const path = `${this.id}/${row}/${col}`
        if (countBytes(path) > 64)
            throw new Error(
                `Button path '${path}' would exceed payload size of 64 bytes! Please use a shorter menu identifier than '${this.id}'`
            )
        this.mw.set(path, middleware)
        return this.add({ text, callback_data: path })
    }

    switchInline(text: string, query = '') {
        return this.add({ text, switch_inline_query: query })
    }

    switchInlineCurrent(text: string, query = '') {
        return this.add({ text, switch_inline_query_current_chat: query })
    }

    game(text: string) {
        return this.add({ text, callback_game: {} })
    }

    pay(text: string) {
        return this.add({ text, pay: true })
    }

    subMenu(
        text: string | ((ctx: C) => string | Promise<string>),
        menu: Menu<C>,
        options: {
            noBackButton?: boolean
            onAction?: Middleware<MenuContext<C>>
        } = {}
    ) {
        // treat undefined as false
        if (options.noBackButton !== true) {
            const existingParent = menu.parent
            if (existingParent !== undefined) {
                throw new Error(
                    `Cannot add the menu '${menu.id}' to '${this.id}' \
because it is already added to '${existingParent.id}' \
and doing so would break overwrite where the back \
button returns to! You can call 'subMenu' with \
'noBackButton: true' to specify that a back button \
should not be provided, hence preventing this error.`
                )
            }
            menu.parent = this
        }
        this.subMenus.set(menu.id, menu)
        return this.text(
            text,
            ...(options.onAction === undefined ? [] : [options.onAction]),
            ctx => ctx.menu.nav(menu.id)
        )
    }

    back(
        text: string | ((ctx: C) => string | Promise<string>),
        options: {
            onAction?: Middleware<MenuContext<C>>
        } = {}
    ) {
        return this.text(
            text,
            ...(options.onAction === undefined ? [] : [options.onAction]),
            ctx => ctx.menu.back()
        )
    }

    at(id: string) {
        if (this.id === id) return this
        const menu = this.subMenus.get(id)
        if (menu === undefined) {
            const validIds = Array.from(this.subMenus.keys())
                .map(k => `'${k}'`)
                .join(', ')
            throw new Error(
                `Menu '${id}' is not a submenu of '${this.id}'! Known subMenus are: ${validIds}`
            )
        }
        return menu
    }

    private async fitPayload(payload: Record<string, unknown>, ctx: C) {
        if (payload.reply_markup !== this) return
        payload.reply_markup = {
            inline_keyboard: await Promise.all(
                this.buttons.map(row =>
                    Promise.all(
                        row.map(async btn => ({
                            ...btn,
                            text:
                                typeof btn.text === 'string'
                                    ? btn.text
                                    : await btn.text(ctx),
                        }))
                    )
                )
            ),
        }
    }

    middleware() {
        const navInstaller = this.navInstaller()
        const composer = new Composer<C>()
        composer
            .use((ctx, next) => {
                ctx.api.config.use(async (prev, method, payload) => {
                    const p: Record<string, unknown> = payload
                    if (Array.isArray(p.results)) {
                        await Promise.all(
                            p.results.map(r => this.fitPayload(r, ctx))
                        )
                    } else {
                        await this.fitPayload(p, ctx)
                    }
                    return await prev(method, payload)
                })
                return next()
            })
            .use(...this.subMenus.values())
            .on('callback_query:data')
            .lazy(ctx => {
                const path = ctx.callbackQuery.data
                if (!this.mw.has(path)) return []
                const handler = this.mw.get(path) as Middleware<C>[]
                const mw = [navInstaller, ...handler]
                if (!this.autoAnswer) return mw
                const c = new Composer<C>()
                c.fork(ctx => ctx.answerCallbackQuery())
                c.use(...mw)
                return c
            })
        return composer.middleware()
    }

    private navInstaller<C extends Context>(): Middleware<C> {
        return async (ctx, next) => {
            // register ctx.menu
            Object.assign(ctx, {
                menu: {
                    nav: async (to: string) => {
                        await ctx.editMessageReplyMarkup({
                            reply_markup: this.at(to),
                        })
                    },
                    back: async () => {
                        const parent = this.parent
                        if (parent === undefined)
                            throw new Error(
                                `Cannot navigate back from this ${this.id}, no known parent!`
                            )
                        await ctx.editMessageReplyMarkup({
                            reply_markup: this.parent,
                        })
                    },
                    update: async () => {
                        await ctx.editMessageReplyMarkup({ reply_markup: this })
                    },
                },
            })
            try {
                // call handlers
                await next()
            } finally {
                // unregister ctx.menu
                Object.assign(ctx, { menu: undefined })
            }
        }
    }
}
