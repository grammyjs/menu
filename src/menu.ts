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
     * As an example, if you have a text button that changes its label based on
     * `ctx`, then you should call
     *
     * ```ts
     * await ctx.menu.update()
     * ```
     *
     * whenever you alter the context object in such a way that the label should
     * update. The same is true for dynamic ranges that change their layout.
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
         * you called `register` when installing this menu.
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
         * Remember that you must register all submenus at the root menu using
         * the `register` method before you can navigate between them.
         */
        nav: (to: string) => Promise<void>
    }
}

/**
 * Middleware that has access to the `ctx.menu` control panel.
 */
type MenuMiddleware<C extends Context> = Middleware<
    Filter<C, 'callback_query:data'> & MenuFlavor
>

type Cb<C extends Context> = Omit<
    InlineKeyboardButton.CallbackButton,
    'callback_data'
> & {
    /**
     * Optional middleware that will be invoked if a callback query for this
     * button is received, i.e. only makes sense for callback buttons.
     */
    middleware: MenuMiddleware<C>[]
}
type NoCb = Exclude<InlineKeyboardButton, InlineKeyboardButton.CallbackButton>
type RemoveAllTexts<T, C extends Context> = T extends { text: DynamicString<C> }
    ? Omit<T, 'text'>
    : T

/**
 * Button of a menu. Almost the same type as InlineKeyboardButton but with texts
 * that can be generated on the fly, and middleware for callback buttons.
 */
export type MenuButton<C extends Context> = {
    /**
     * Label text on the button, or a function that can generate this text. The
     * function is supplied with the context object that is used to make the
     * request.
     */
    text: DynamicString<C>
} & RemoveAllTexts<NoCb | Cb<C>, C>

type MaybePromise<T> = T | Promise<T>
/** String or potentially async function that generates a string */
type DynamicString<C extends Context> =
    | string
    | ((ctx: C) => MaybePromise<string>)
type DynamicRange<C extends Context> = (
    ctx: C
) => MaybePromise<Range<C> | MenuButton<C>[][]>

const ops = Symbol('menu building operations')

/**
 * A range is a two-dimensional array of menu buttons.
 */
class Range<C extends Context> {
    [ops]: Array<DynamicRange<C>> = []
    /**
     * This method is used internally whenever a new button object is added.
     *
     * @param button A button object
     */
    private add(button: MenuButton<C> | DynamicRange<C>) {
        this[ops].push(typeof button === 'function' ? button : () => [[button]])
        return this
    }
    /**
     * Adds a 'line break'. Call this method to make sure that the next added
     * buttons will be on a new row.
     */
    row() {
        this[ops].push(() => [[], []])
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
    url(text: DynamicString<C>, url: string) {
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
    login(text: DynamicString<C>, loginUrl: string | LoginUrl) {
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
     * menu.text(ctx => ctx.session.flag ? 'Yes' : 'No', async ctx => {
     *   ctx.session.flag = !ctx.session.flag
     *   await ctx.menu.update()
     * })
     * ```
     *
     * @param text The text to display
     * @param middleware The listeners to call when the button is pressed
     */
    text(text: DynamicString<C>, ...middleware: MenuMiddleware<C>[]) {
        return this.add(() => [[{ text, middleware }]])
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
     * // Listen for specifc query
     * bot.inlineQuery('my-query', ctx => { ... })
     * // Listen for any query
     * bot.on('inline_query', ctx => { ... })
     * ```
     *
     * @param text The text to display
     * @param query The (optional) inline query string to prefill
     */
    switchInline(text: DynamicString<C>, query = '') {
        return this.add({ text, switch_inline_query: query })
    }
    /**
     * Adds a new inline query button that acts on the current chat. The
     * selected chat will be prefilled with the name of your bot. You may
     * provide a text that is specified along with it. This will start an inline
     * query.
     *
     * Your bot will in turn receive updates for inline queries. You can listen
     * to inline query updates like this:
     * ```ts
     * // Listen for specifc query
     * bot.inlineQuery('my-query', ctx => { ... })
     * // Listen for any query
     * bot.on('inline_query', ctx => { ... })
     * ```
     *
     * @param text The text to display
     * @param query The (optional) inline query string to prefill
     */
    switchInlineCurrent(text: DynamicString<C>, query = '') {
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
    game(text: DynamicString<C>) {
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
    pay(text: DynamicString<C>) {
        return this.add({ text, pay: true })
    }
    /**
     * Adds a button that navigates to a given submenu when pressed. You can
     * pass in the identifier of another menu instance. This way, you can
     * effectively create a network of menus with navigation between them.
     *
     * It is necessary that you register the targeted submenu by calling
     * `menu.register(subMenu)`. Otherwise, no navigation can be performed. Note
     * that you then don't need to call `bot.use(subMenu)` anymore, all
     * registered submenus will automatically become interactive, too.
     *
     * You can also navigate to this submenu manually by calling
     * `ctx.menu.nav('sub-id')`, where `'sub-id'` is the identifier of the
     * submenu.
     *
     * You can call `subMenu.back()` to add a button that navigates back to the
     * parent menu, i.e. the menu at which you registered the submenu.
     *
     * You can get back the `subMenu` instance by calling `parent.at('sub-id')`,
     * where `'sub-id'` is the identifier you passed to the submenu.
     *
     * @param text The text to display
     * @param menu The submenu to open when the button is pressed
     * @param options Further options
     */
    subMenu(
        text: DynamicString<C>,
        menu: string,
        options: {
            /**
             * Middleware to run when the navigation is performed.
             */
            onAction?: MenuMiddleware<C>
        } = {}
    ) {
        return this.text(
            text,
            ...(options.onAction === undefined ? [] : [options.onAction]),
            ctx => ctx.menu.nav(menu)
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
        text: DynamicString<C>,
        options: {
            /**
             * Middleware to run when the navigation is performed.
             */
            onAction?: MenuMiddleware<C>
        } = {}
    ) {
        return this.text(
            text,
            ...(options.onAction === undefined ? [] : [options.onAction]),
            ctx => ctx.menu.back()
        )
    }
    /**
     * This is a dynamic way to initialize menu. A typical use case is when you
     * want to create an arbitrary menu, using the data from `ctx.session`:
     *
     * ```ts
     * const menu = new Menu('root')
     * menu.dynamic(ctx => ctx.session.data.reduce((range, entry) => range.text(entry)), new Menu.Builder())
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
    dynamic(
        rangeBuilder: (
            ctx: C,
            range: Range<C>
        ) => MaybePromise<Range<C> | MenuButton<C>[][] | void>
    ) {
        this.add(async (ctx: C) => {
            const range = new Range<C>()
            const res = await rangeBuilder(ctx, range)
            if (res instanceof Menu)
                throw new Error(
                    'Cannot use a `Menu` instance as a dynamic range, did you mean to use `Menu.Range` instead?'
                )
            return res instanceof Range ? res : range
        })
        return this
    }
}

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
    extends Range<C>
    implements MiddlewareObj<C>, InlineKeyboardMarkup
{
    private parent: string | undefined = undefined
    private index: Map<string, Menu<C>> = new Map()

    /**
     * A menu range is a part of the two-dimensional array of menu buttons. This
     * is mostly useful if you want to dynamically generate the structure of the
     * menu on the fly.
     */
    static Range = Range

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
        super()
        if (countBytes(id + '/xx/yy') > 64)
            throw new Error(
                ` Please use a shorter menu identifier than '${this.id}'! It causes the payload sizes to exceed 64 bytes!`
            )
        if (id.includes('/'))
            throw new Error(`You cannot use '/' in a menu identifier ('${id}')`)
        this.index.set(id, this)
    }
    /**
     * Used internally by the menu, do not touch or you'll burn yourself.
     */
    public readonly inline_keyboard = new Proxy([], {
        get: () => {
            throw new Error(
                `Cannot send menu '${this.id}'! Did you forget to use bot.use() for it?`
            )
        },
    })
    /**
     * Registers a submenu. This makes it accessible for navigation, and sets
     * its parent menu to this menu.
     *
     * Optionally, you can specify the identifier of a different parent menu as
     * a second argument. The parent menu is the menu that is targeted when
     * backwards navigation is performed.
     *
     * Note that once you registered a submenu, it is sufficient to call
     * `bot.use(menu)` for the parent menu only. You do not need to make all
     * submenus interactive by passing them to `bot.use`.
     *
     * @param menu The menu to register
     * @param parent An optional parent menu identifier
     */
    register(menu: Menu<C>, parent = this.id) {
        if (this.index.has(menu.id))
            throw new Error(`Menu 'menu.id' already registered!`)
        this.index.set(menu.id, menu)
        menu.index.forEach((v, k) => this.index.set(k, v))
        menu.parent = parent
        menu.index = this.index
    }
    /**
     * Returns the menu instance for the given identifier. If the identifier is
     * the same as this menu's identifier, `this` is returned.
     *
     * @param id Menu identifier
     * @returns The identified menu
     */
    at(id: string) {
        const menu = this.index.get(id)
        if (menu === undefined) {
            const validIds = Array.from(this.index.keys())
                .map(k => `'${k}'`)
                .join(', ')
            throw new Error(
                `Menu '${id}' is not a submenu of '${this.id}'! Known subMenus are: ${validIds}`
            )
        }
        return menu
    }

    private async render(ctx: C) {
        const layout = async (
            keyboard: Promise<InlineKeyboardButton[][]>,
            range: DynamicRange<C>
        ): Promise<InlineKeyboardButton[][]> => {
            const k = await keyboard
            const btns = await range(ctx)
            if (btns instanceof Range) return btns[ops].reduce(layout, keyboard)
            let first = true
            for (const row of btns) {
                if (!first) k.push([])
                for (const button of row) {
                    const text =
                        typeof button.text === 'string'
                            ? button.text
                            : await button.text(ctx)
                    k[k.length - 1].push(
                        'middleware' in button
                            ? {
                                  callback_data: `${this.id}/${k.length - 1}/${
                                      k[k.length - 1].length
                                  }`,
                                  text,
                              }
                            : { ...button, text }
                    )
                }
                first = false
            }
            return k
        }
        return await this[ops].reduce(layout, Promise.resolve([[]]))
    }

    private async fitPayload(payload: Record<string, unknown>, ctx: C) {
        if (payload.reply_markup instanceof Menu) {
            const menu = this.index.get(payload.reply_markup.id)
            if (menu !== undefined) {
                const rendered = await menu.render(ctx)
                payload.reply_markup = { inline_keyboard: rendered }
            }
        }
    }
    middleware() {
        const assert = <T>(value: T | undefined): T => {
            if (value === undefined)
                throw new Error(
                    `Layout of '${this.id}' changed since last render for this message!'`
                )
            return value
        }
        const composer = new Composer<C>((ctx, next) => {
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
        composer.on('callback_query:data').lazy(async ctx => {
            const [path, rowStr, colStr] = ctx.callbackQuery.data.split('/')
            if (!rowStr || !colStr) return []
            const menu = this.index.get(path)
            if (menu === undefined) return []
            const navInstaller = this.navInstaller(menu)
            let operations = [...menu[ops]]
            const row = parseInt(rowStr, 10)
            const col = parseInt(colStr, 10)
            let i = 0
            let targetRow: MenuButton<C>[] | undefined
            do {
                const range = await assert(operations.shift())(ctx)
                if (range instanceof Range) {
                    operations.unshift(...range[ops])
                } else {
                    const len = range.length
                    if (row - i < len) targetRow = range[row - i]
                    i += len - 1
                }
            } while (i < row)
            if (targetRow === undefined) throw new Error('Does not happen')
            let j = targetRow.length
            let targetBtn: MenuButton<C> | undefined
            if (col < j) {
                targetBtn = targetRow[col]
            } else
                while (j <= col) {
                    const range = await assert(operations.shift())(ctx)
                    if (range instanceof Range) {
                        operations.unshift(...range[ops])
                    } else {
                        const r0 = range[0]
                        const len = r0.length
                        if (col - j < len) targetBtn = r0[col - j]
                        j += len
                    }
                }
            if (targetBtn === undefined) throw new Error('Does not happen')
            if (!('middleware' in targetBtn)) throw new Error('Layout changed!')
            // FIXME: throw when a button on an outdated keyboard is pressed!!!
            const handler = targetBtn.middleware as Middleware<C>[]
            const mw = [navInstaller, ...handler]
            if (!menu.autoAnswer) return mw
            const c = new Composer<C>()
            c.fork(ctx => ctx.answerCallbackQuery())
            c.use(...mw)
            return c
        })
        return composer.middleware()
    }

    private navInstaller<C extends Context>(menu: Menu<C>): Middleware<C> {
        return async (ctx, next) => {
            const controlPanel: MenuFlavor = {
                // TODO: do not update menu immediately!

                // Instead, only set a flag that the menu must be updated. Then,
                // wait for calls that edit the same message, and inject the
                // payload there. This will both prevent flickering and save an
                // API call. If no such call is performed, fall back to
                // performing an extra API call.
                menu: {
                    update: async () => {
                        await ctx.editMessageReplyMarkup({ reply_markup: menu })
                    },
                    close: async () => {
                        await ctx.editMessageReplyMarkup()
                    },
                    nav: async (to: string) => {
                        await ctx.editMessageReplyMarkup({
                            reply_markup: menu.at(to),
                        })
                    },
                    back: async () => {
                        const parent = menu.parent
                        if (parent === undefined)
                            throw new Error(
                                `Cannot navigate back from menu '${menu.id}', no known parent!`
                            )
                        await ctx.editMessageReplyMarkup({
                            reply_markup: menu.index.get(parent),
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
