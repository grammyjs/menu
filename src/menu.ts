import {
    Composer,
    Context,
    Filter,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LoginUrl,
    Middleware,
    MiddlewareObj,
} from './deps.deno.ts'

const textEncoder = new TextEncoder()
function countBytes(str: string): number {
    return textEncoder.encode(str).length
}

/**
 * Context flavor for context objects in listeners that react to menus. Provides
 * `ctx.menu`, a control pane for the respective menu.
 */
export interface MenuFlavor {
    /**
     * Control panel for the currently active menu. `ctx.menu` is only available
     * for listeners that are passed as handlers to a menu, and it allows you to
     * perform simple actions such as navigating the menu, or updating or
     * closing it.
     *
     * As an example, it you have a text button that changes its label based on
     * `ctx`, then you should call
     *
     * ```ts
     * await ctx.menu.update()
     * ```
     *
     * whenever you alter the context object in such a way that the label should
     * update.
     */
    menu: {
        /**
         * Call this method to update the menu. For instance, if you have a
         * button that changes its text based on `ctx`, then you should call
         * this method to update it.
         */
        update: () => Promise<void>
        /**
         * Closes the menu. Removes all buttons underneath the message.
         */
        close: () => Promise<void>
        /**
         * Navigates to the parent menu. The parent menu is the menu on which
         * you called `subMenu` when installing this menu.
         *
         * Throws an error if this menu does not have a parent menu.
         */
        back: () => Promise<void>
        /**
         * Navigates to the specified submenu. The given identifier is the same
         * string that you pass to `new Menu('')`. If you specify the identifier
         * of the current menu itself, this method is equivalent to `await
         * ctx.menu.update()`.
         *
         * If you want to navigate to a distant other menu, such as a
         * subsubmenu, you cannot use this method directly. Instead, you should
         * use `editMessageReplyMarkup` and send the given menu object directly
         * in the `reply_markup`, similar to how you would send a new menu.
         */
        nav: (to: string) => Promise<void>
    }
}

type MenuButton<C extends Context> = RemoveAllTexts<InlineKeyboardButton> & {
    /**
     * Label text on the button, or a function that can generate this text. The
     * function is supplied with the context object that is used to make the
     * request.
     */
    text: string | ((ctx: C) => string | Promise<string>)
}
type RemoveAllTexts<T> = T extends { text: string } ? Omit<T, 'text'> : T

/**
 * A menu is a set of interactive buttons that is displayed beneath a message.
 * It uses an [inline keyboard](https://grammy.dev/plugins/keyboard.html) for
 * that, so in a sense, a menu is just an inline keyboard spiced up with
 * interactivity (such as navigation between multiple pages).
 *
 * ```ts
 * // Creating a simple menu
 * const menu = new Menu('my-menu-identifier')
 *   .text('A', ctx => ctx.reply('You pressed A!')).row()
 *   .text('B', ctx => ctx.reply('You pressed B!'))
 *
 * // Make it interactive
 * bot.use(menu)
 *
 * bot.command('start', async ctx => {
 *   // Send the menu:
 *   await ctx.reply(12345, 'Check out this menu:', {
 *     reply_markup: menu
 *   })
 * })
 * ```
 *
 * Sending the menu is not directly possible via `bot.api.sendMessage`, only via
 * the context object, at least not yet.
 *
 * Check out the [official documentation](https://grammy.dev/plugins/menu.html)
 * to see how you can create menus that span several pages, how to navigate
 * between them, and more.
 */
export class Menu<C extends Context = Context>
    implements MiddlewareObj<C>, InlineKeyboardMarkup
{
    private readonly buttons: MenuButton<C>[][] = [[]]

    private parent: Menu<C> | undefined = undefined
    private readonly subMenus = new Map<string, Menu<C>>()

    private readonly mw = new Map<
        string,
        Array<Middleware<Filter<C, 'callback_query:data'> & MenuFlavor>>
    >()

    /**
     * Creates a new menu with the given identifier.
     *
     * Menus will automatically call `ctx.answerCallbackQuery` with no
     * arguments. If you need to send custom messages via that method, you can
     * set `autoAnswer` to `false` to disable this behavior.
     *
     * Check out the [official
     * documentation](https://grammy.dev/plugins/menu.html) to see how you can
     * create menus that span several pages, how to navigate between them, and
     * more.
     *
     * @param id Identifier of the menu
     * @param autoAnswer Flag to disable automatic query answering
     */
    constructor(
        private readonly id: string,
        private readonly autoAnswer = true
    ) {
        if (id.includes('/'))
            throw new Error(`You cannot use '/' in a menu identifier ('${id}')`)
    }
    /**
     * Used internally by the menu, do not touch or you'll burn yourself.
     */
    public readonly inline_keyboard = new Proxy([], {
        get: () => {
            throw new Error(
                `Cannot send menu '${this.id}'! Did you forget to use bot.use() for it, or for a parent menu?`
            )
        },
    })
    /**
     * This method is used internally whenever a new button object is added. You
     * most likely don't ever need to call it, unless you want to add a dead
     * dummy button that the menu will not react to.
     *
     * @param button A button object
     */
    add(button: MenuButton<C>) {
        this.buttons[this.buttons.length - 1]?.push(button)
        return this
    }
    /**
     * Adds a 'line break'. Call this method to make sure that the next added
     * buttons will be on a new row.
     */
    row() {
        this.buttons.push([])
        return this
    }
    /**
     * Adds a new URL button. Telegram clients will open the provided URL when
     * the button is pressed. Note that they will not notify your bot when that
     * happens, so you cannot react to this button.
     *
     * @param text The text to display
     * @param url HTTP or tg:// url to be opened when button is pressed
     */
    url(text: string, url: string) {
        return this.add({ text, url })
    }
    /**
     * Adds a new login button. This can be used as a replacement for the
     * Telegram Login Widget. You must specify an HTTP URL used to automatically
     * authorize the user.
     *
     * @param text The text to display
     * @param loginUrl The login URL as string or `LoginUrl` object
     */
    login(text: string, loginUrl: string | LoginUrl) {
        return this.add({
            text,
            login_url:
                typeof loginUrl === 'string' ? { url: loginUrl } : loginUrl,
        })
    }
    /**
     * Adds a new text button. You may pass any number of listeners. They will
     * be called when the button is pressed.
     *
     * ```ts
     * menu.text('Hit me!', ctx => ctx.reply('Ouch!'))
     * ```
     *
     * If you pass several listeners, make sure that you understand what
     * [middleware](https://grammy.dev/guide/middleware.html) is.
     *
     * You can also use this method to register a button that depends on the
     * current context.
     *
     * ```ts
     * function greetInstruction(ctx: Context): string {
     *   const username = ctx.from?.first_name
     *   return `Greet ${username ?? 'me'}!`,
     * }
     *
     * const menu = new Menu('my-menu')
     *   .text(greetInstruction, ctx => ctx.reply("I'm too shy."))
     * bot.use(menu)
     *
     * // This will send a menu with one text button, and the text has the name
     * // of the user that the bot is replying to.
     * bot.on('message', ctx => ctx.reply('What shall I do?', { reply_markup: menu }))
     * ```
     *
     * If you base the text on [session
     * data](https://grammy.dev/plugins/session.html), you can easily create a
     * settings panel with toggle buttons.
     *
     * ```ts
     * // Button will toggle between 'Yes' and 'No' when pressed
     * menu.text(ctx => ctx.session.flag ? 'Yes' : 'No', await ctx => {
     *   ctx.session.flag = !ctx.session.flag
     *   await ctx.menu.update()
     * })
     * ```
     *
     * @param text The text to display
     * @param middleware The listeners to call when the button is pressed
     */
    text(
        text: string | ((ctx: C) => string | Promise<string>),
        ...middleware: Array<
            Middleware<Filter<C, 'callback_query:data'> & MenuFlavor>
        >
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
    /**
     * Adds a new inline query button. Telegram clients will let the user pick a
     * chat when this button is pressed. This will start an inline query. The
     * selected chat will be prefilled with the name of your bot. You may
     * provide a text that is specified along with it.
     *
     * Your bot will in turn receive updates for inline queries. You can listen
     * to inline query updates like this:
     * ```ts
     * bot.on('inline_query', ctx => { ... })
     * ```
     *
     * @param text The text to display
     * @param query The (optional) inline query string to prefill
     */
    switchInline(text: string, query = '') {
        return this.add({ text, switch_inline_query: query })
    }
    /**
     * Adds a new inline query button that act on the current chat. The selected
     * chat will be prefilled with the name of your bot. You may provide a text
     * that is specified along with it. This will start an inline query.
     *
     * Your bot will in turn receive updates for inline queries. You can listen
     * to inline query updates like this:
     * ```ts
     * bot.on('inline_query', ctx => { ... })
     * ```
     *
     * @param text The text to display
     * @param query The (optional) inline query string to prefill
     */
    switchInlineCurrent(text: string, query = '') {
        return this.add({ text, switch_inline_query_current_chat: query })
    }
    /**
     * Adds a new game query button, confer
     * https://core.telegram.org/bots/api#games
     *
     * This type of button must always be the first button in the first row.
     *
     * @param text The text to display
     */
    game(text: string) {
        return this.add({ text, callback_game: {} })
    }
    /**
     * Adds a new payment button, confer
     * https://core.telegram.org/bots/api#payments
     *
     * This type of button must always be the first button in the first row.
     *
     * @param text The text to display
     */
    pay(text: string) {
        return this.add({ text, pay: true })
    }
    /**
     * Adds a button that navigates to a given sub menu when pressed. You can
     * pass in another menu instance. This way, you can effectively create a
     * tree of menus.
     *
     * If you call
     * ```ts
     * parent.subMenu(subMenu)
     * ```
     * then we call `parent` the _parent menu_ of `subMenu`, and we call
     * `subMenu` the _child menu_ or _sub menu_ of `parent`.
     *
     * Note that it is sufficient to register the root menu (=topmost parent
     * menu) of the tree with `bot.use(menu)`, all sub menus will automatically
     * become interactive, too.
     *
     * You can call `subMenu.back()` to add a button that navigates back to the
     * parent menu.
     *
     * You can get back the `subMenu` instance by calling `parent.at('sub-id')`,
     * where `'sub-id'` is the identifier you passed to the sub menu.
     *
     * Check out the [official
     * documentation](https://grammy.dev/plugins/menu.html) to find out how to
     * navigate between menus.
     *
     * @param text The text to display
     * @param menu The sub menu to open when the button is pressed
     * @param options Further options
     */
    subMenu(
        text: string | ((ctx: C) => string | Promise<string>),
        menu: Menu<C>,
        options: {
            /**
             * Set this option to `true` to specify that no back button should
             * be provided. Useful if you want to add the same sub menu instance
             * to several parent menus.
             */
            noBackButton?: boolean
            /**
             * Middleware to run when the navigation is performed.
             */
            onAction?: Middleware<Filter<C, 'callback_query:data'> & MenuFlavor>
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
    /**
     * Adds a text button that performs a navigation to the parent menu via
     * `ctx.menu.back()`.
     *
     * @param text The text to display
     * @param options Further options
     */
    back(
        text: string | ((ctx: C) => string | Promise<string>),
        options: {
            onAction?: Middleware<Filter<C, 'callback_query:data'> & MenuFlavor>
        } = {}
    ) {
        return this.text(
            text,
            ...(options.onAction === undefined ? [] : [options.onAction]),
            ctx => ctx.menu.back()
        )
    }
    /**
     * Does not add any button to the menu, but instead returns the menu
     * instance for the given identifier. If the identifier is the same as this
     * menu's identifier, `this` is returned. Otherwise, the child menu with the
     * given identifier is returned.
     *
     * @param id Menu identifier
     * @returns Either `this` or the identified child menu
     */
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
    /**
     * This is an alternative way to initialize menu.
     * Typical use case is when you want to create an arbitrary menu, using the data from `ctx.session`:
     * ```ts
     * const menuFactory = async (ctx, rootMenu) => ctx.session.data.reduce((menu, entry) => menu.text(entry), rootMenu)
     * const menu = new Menu("root")
     * bot.use(menu.build(menuFactory))
     * bot.command("start", async (ctx) => {
     *   await ctx.reply("Menu", {
     *      reply_markup: menu,
     *   });
     * });
     * ```
     *
     * @param menuFactory async menu factory function
     * @returns MiddlewareObj
     */
    build(
        menuFactory: (ctx: C, root: Menu<C>) => Promise<Menu<C>>
    ): MiddlewareObj<C> {
        const composer = new Composer<C>()
        let initialized = false
        composer.lazy(async (ctx: C) => {
            if (!initialized) {
                await menuFactory(ctx, this)
                initialized = true
            }
            const c = new Composer<C>()
            c.use(this.middleware())
            return c
        })
        return {
            middleware: () => composer.middleware(),
        }
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
                ctx.api.config.use(async (prev, method, payload, signal) => {
                    const p: Record<string, unknown> = payload
                    if (Array.isArray(p.results)) {
                        await Promise.all(
                            p.results.map(r => this.fitPayload(r, ctx))
                        )
                    } else {
                        await this.fitPayload(p, ctx)
                    }
                    return await prev(method, payload, signal)
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
            const controlPanel: MenuFlavor = {
                menu: {
                    update: async () => {
                        await ctx.editMessageReplyMarkup({ reply_markup: this })
                    },
                    close: async () => {
                        await ctx.editMessageReplyMarkup()
                    },
                    nav: async (to: string) => {
                        await ctx.editMessageReplyMarkup({
                            reply_markup: this.at(to),
                        })
                    },
                    back: async () => {
                        const parent = this.parent
                        if (parent === undefined)
                            throw new Error(
                                `Cannot navigate back from menu '${this.id}', no known parent!`
                            )
                        await ctx.editMessageReplyMarkup({
                            reply_markup: this.parent,
                        })
                    },
                },
            }
            // register ctx.menu
            Object.assign(ctx, controlPanel)
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
