import {
    Composer,
    type Context,
    type Filter,
    type InlineKeyboardButton,
    type InlineKeyboardMarkup,
    type LoginUrl,
    type Middleware,
    type MiddlewareObj,
    type SwitchInlineQueryChosenChat,
} from "./deps.deno.ts";

const b = 0xff; // mask for lowest byte
const toNums = (str: string) => Array.from(str).map((c) => c.codePointAt(0)!);
const dec = new TextDecoder();
/** Efficiently computes a 4-byte hash of an int32 array */
function tinyHash(nums: number[]): string {
    // Inspired by JDK7's hashCode with different primes for a better distribution
    let hash = 17;
    for (const n of nums) hash = ((hash << 5) + (hash << 2) + hash + n) >>> 0; // hash = 37 * hash + n
    const bytes = [hash >>> 24, (hash >> 16) & b, (hash >> 8) & b, hash & b];
    return dec.decode(Uint8Array.from(bytes)); // turn bytes into string
}

const INJECT_METHODS = new Set([
    "editMessageText",
    "editMessageCaption",
    "editMessageMedia",
    "editMessageReplyMarkup",
    "stopPoll",
]);

/**
 * Context flavor for context objects in listeners that react to menus. Provides
 * `ctx.menu`, a control pane for the respective menu.
 */
export interface MenuFlavor {
    match?: string;
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
     * ctx.menu.update()
     * ```
     *
     * whenever you alter the context object in such a way that the label should
     * update. The same is true for dynamic ranges that change their layout.
     *
     * If you edit the message yourself after calling one of the functions on
     * `ctx.menu`, the new menu will be automatically injected into the payload.
     * Otherwise, a dedicated API call will be performed after your middleware
     * completes.
     */
    menu: MenuControlPanel;
}

interface Immediate {
    immediate?: boolean;
}
/**
 * Menu control panel. Can be used to update or close the menu, or to perform
 * manual navigation between menus.
 */
export interface MenuControlPanel {
    /**
     * Call this method to update the menu. For instance, if you have a button
     * that changes its text based on `ctx`, then you should call this method to
     * update it.
     *
     * Calling this method will guarantee that the menu is updated, but note
     * that this will perform the update lazily. A new menu is injected into the
     * payload of the request the next time you edit the corresponding message.
     * If you let your middleware complete without editing the message itself
     * again, a dedicated API call will be performed that updates the menu.
     *
     * Pass `{ immediate: true }` to perform the update eagerly instead of
     * lazily. A dedicated API call that updates the menu is sent immediately.
     * In that case, the method returns a Promise that you should `await`. Eager
     * updating may cause flickering of the menu, and it may be slower in some
     * cases.
     */
    update(config: { immediate: true }): Promise<void>;
    update(config?: { immediate?: false }): void;
    /**
     * Closes the menu. Removes all buttons underneath the message.
     *
     * Calling this method will guarantee that the menu is closed, but note that
     * this will be done lazily. A new menu is injected into the payload of the
     * request the next time you edit the corresponding message. If you let your
     * middleware complete without editing the message itself again, a dedicated
     * API call will be performed that closes the menu.
     *
     * Pass `{ immediate: true }` to perform the update eagerly instead of
     * lazily. A dedicated API call that updates the menu is sent immediately.
     * In that case, the method returns a Promise that you should `await`. Eager
     * closing may be slower in some cases.
     */
    close(config: { immediate: true }): Promise<void>;
    close(config?: { immediate?: false }): void;
    /**
     * Navigates to the parent menu. By default, the parent menu is the menu on
     * which you called `register` when installing this menu.
     *
     * Throws an error if this menu does not have a parent menu.
     *
     * Calling this method will guarantee that the navigation is performed, but
     * note that this will be done lazily. A new menu is injected into the
     * payload of the request the next time you edit the corresponding message.
     * If you let your middleware complete without editing the message itself
     * again, a dedicated API call will be performed that performs the
     * navigation.
     *
     * Pass `{ immediate: true }` to navigate eagerly instead of lazily. A
     * dedicated API call is sent immediately. In that case, the method returns
     * a Promise that you should `await`. Eager navigation may cause flickering
     * of the menu, and it may be slower in some cases.
     */
    back(config: { immediate: true }): Promise<void>;
    back(config?: { immediate?: false }): void;
    /**
     * Navigates to the specified submenu. The given identifier is the same
     * string that you pass to `new Menu('')`. If you specify the identifier of
     * the current menu itself, this method is equivalent to
     * `ctx.menu.update()`.
     *
     * Remember that you must register all submenus at the root menu using the
     * `register` method before you can navigate between them.
     *
     * Calling this method will guarantee that the navigation is performed, but
     * note that this will be done lazily. A new menu is injected into the
     * payload of the request the next time you edit the corresponding message.
     * If you let your middleware complete without editing the message itself
     * again, a dedicated API call will be performed that performs the
     * navigation.
     *
     * Pass `{ immediate: true }` to navigate eagerly instead of lazily. A
     * dedicated API call is sent immediately. In that case, the method returns
     * a Promise that you should `await`. Eager navigation may cause flickering
     * of the menu, and it may be slower in some cases.
     */
    nav(to: string, config: { immediate: true }): Promise<void>;
    nav(to: string, config?: { immediate?: false }): void;
}

/**
 * Middleware that has access to the `ctx.menu` control panel.
 */
type MenuMiddleware<C extends Context> = Middleware<
    Filter<C, "callback_query:data"> & MenuFlavor
>;

/** A value, or a promise of a value */
type MaybePromise<T> = T | Promise<T>;
/** A potentially async function that takes a context and returns a string */
type DynamicString<C extends Context> = (ctx: C) => MaybePromise<string>;
/** A potentially dynamic string */
type MaybeDynamicString<C extends Context> = string | DynamicString<C>;

/** An object containing text and payload */
interface TextAndPayload<C extends Context> {
    /** Text to display */
    text: MaybeDynamicString<C>;
    /** Optional payload */
    payload?: MaybeDynamicString<C>;
}
/** A dynamic string, or an object with a text and a payload */
type MaybePayloadString<C extends Context> =
    | MaybeDynamicString<C>
    | TextAndPayload<C>;

type Cb<C extends Context> =
    & Omit<
        InlineKeyboardButton.CallbackButton,
        "callback_data"
    >
    & {
        /**
         * Middleware that will be invoked if a callback query for this button
         * is received.
         */
        middleware: MenuMiddleware<C>[];
        /**
         * Optional payload for this button
         */
        payload?: MaybeDynamicString<C>;
    };
type NoCb = Exclude<InlineKeyboardButton, InlineKeyboardButton.CallbackButton>;
type RemoveAllTexts<T> = T extends { text: string } ? Omit<T, "text"> : T;
type MakeUrlDynamic<C extends Context, T> = T extends { url: string }
    ? Omit<T, "url"> & { url: MaybeDynamicString<C> }
    : T;
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
    text: MaybeDynamicString<C>;
} & MakeUrlDynamic<C, RemoveAllTexts<NoCb | Cb<C>>>;

/**
 * Raw menu range, i.e. a two-dimensional array of menu buttons.
 */
type RawRange<C extends Context> = MenuButton<C>[][];
/**
 * Range instance, or a raw (static) range that consists of a two-dimensional
 * menu button array.
 */
type MaybeRawRange<C extends Context> = MenuRange<C> | RawRange<C>;
/**
 * Potentially async function that generates a potentially raw range.
 */
type DynamicRange<C extends Context> = (
    ctx: C,
) => MaybePromise<MaybeRawRange<C>>;
/**
 * Potentially dynamic range.
 */
type MaybeDynamicRange<C extends Context> = MaybeRawRange<C> | DynamicRange<C>;

const ops = Symbol("menu building operations");

/**
 * A menu range is a two-dimensional array of menu buttons.
 *
 * This array is a part of the total two-dimensional array of menu buttons. This
 * is mostly useful if you want to dynamically generate the structure of the
 * menu on the fly.
 */
export class MenuRange<C extends Context> {
    /** Internal list of range generator functions */
    [ops]: MaybeDynamicRange<C>[] = [];
    /**
     * This method is used internally whenever a new range is added.
     *
     * @param range A range object or a two-dimensional array of menu buttons
     */
    addRange(...range: MaybeDynamicRange<C>[]) {
        this[ops].push(...range);
        return this;
    }
    /**
     * This method is used internally whenever new buttons are added. Adds the
     * buttons to the current row.
     *
     * @param btns Menu button object
     */
    add(...btns: MenuButton<C>[]) {
        return this.addRange([btns]);
    }
    /**
     * Adds a 'line break'. Call this method to make sure that the next added
     * buttons will be on a new row.
     */
    row() {
        return this.addRange([[], []]);
    }
    /**
     * Adds a new URL button. Telegram clients will open the provided URL when
     * the button is pressed. Note that they will not notify your bot when that
     * happens, so you cannot react to this button.
     *
     * @param text The text to display
     * @param url HTTP or tg:// url to be opened when button is pressed. Links tg://user?id=<user_id> can be used to mention a user by their ID without using a username, if this is allowed by their privacy settings.
     */
    url(text: MaybeDynamicString<C>, url: MaybeDynamicString<C>) {
        return this.add({ text, url });
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
     * @param text The text to display, or a text with payload
     * @param middleware The listeners to call when the button is pressed
     */
    text(text: MaybeDynamicString<C>, ...middleware: MenuMiddleware<C>[]): this;
    text(
        text: TextAndPayload<C>,
        ...middleware: MenuMiddleware<C & { match: string }>[]
    ): this;
    text(text: MaybePayloadString<C>, ...middleware: MenuMiddleware<C>[]): this;
    text(text: MaybePayloadString<C>, ...middleware: MenuMiddleware<C>[]) {
        return this.add(
            typeof text === "object"
                ? { ...text, middleware }
                : { text, middleware },
        );
    }
    /**
     * Adds a new web app button, confer https://core.telegram.org/bots/webapps
     *
     * @param text The text to display
     * @param url An HTTPS URL of a Web App to be opened with additional data
     */
    webApp(text: MaybeDynamicString<C>, url: string) {
        return this.add({ text, web_app: { url } });
    }
    /**
     * Adds a new login button. This can be used as a replacement for the
     * Telegram Login Widget. You must specify an HTTPS URL used to
     * automatically authorize the user.
     *
     * @param text The text to display
     * @param loginUrl The login URL as string or `LoginUrl` object
     */
    login(text: MaybeDynamicString<C>, loginUrl: string | LoginUrl) {
        return this.add({
            text,
            login_url: typeof loginUrl === "string"
                ? { url: loginUrl }
                : loginUrl,
        });
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
    switchInline(text: MaybeDynamicString<C>, query = "") {
        return this.add({ text, switch_inline_query: query });
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
    switchInlineCurrent(text: MaybeDynamicString<C>, query = "") {
        return this.add({ text, switch_inline_query_current_chat: query });
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
     * @param query The query object describing which chats can be picked
     */
    switchInlineChosen(
        text: MaybeDynamicString<C>,
        query: SwitchInlineQueryChosenChat = {},
    ) {
        return this.add({ text, switch_inline_query_chosen_chat: query });
    }
    /**
     * Adds a new game query button, confer
     * https://core.telegram.org/bots/api#games
     *
     * This type of button must always be the first button in the first row.
     *
     * @param text The text to display
     */
    game(text: MaybeDynamicString<C>) {
        return this.add({ text, callback_game: {} });
    }
    /**
     * Adds a new payment button, confer
     * https://core.telegram.org/bots/api#payments
     *
     * This type of button must always be the first button in the first row and can only be used in invoice messages.
     *
     * @param text The text to display
     */
    pay(text: MaybeDynamicString<C>) {
        return this.add({ text, pay: true });
    }
    /**
     * Adds a button that navigates to a given submenu when pressed. You can
     * pass in the identifier of another menu instance. This way, you can
     * effectively create a network of menus with navigation between them.
     *
     * It is necessary that you register the targeted submenu by calling
     * `menu.register(submenu)`. Otherwise, no navigation can be performed. Note
     * that you then don't need to call `bot.use(submenu)` anymore, all
     * registered submenus will automatically become interactive, too.
     *
     * You can also navigate to this submenu manually by calling
     * `ctx.menu.nav('sub-id')`, where `'sub-id'` is the identifier of the
     * submenu.
     *
     * You can call `submenu.back()` to add a button that navigates back to the
     * parent menu, i.e. the menu at which you registered the submenu.
     *
     * You can get back the `submenu` instance by calling `parent.at('sub-id')`,
     * where `'sub-id'` is the identifier you passed to the submenu.
     *
     * @param text The text to display, or a text with payload
     * @param menu The identifier of the submenu to open
     * @param middleware The listeners to call when the button is pressed
     */
    submenu(
        text: MaybeDynamicString<C>,
        menu: string,
        ...middleware: MenuMiddleware<C>[]
    ): this;
    submenu(
        text: TextAndPayload<C>,
        menu: string,
        ...middleware: MenuMiddleware<C & { match: string }>[]
    ): this;
    submenu(
        text: MaybePayloadString<C>,
        menu: string,
        ...middleware: MenuMiddleware<C>[]
    ): this;
    submenu(
        text: MaybePayloadString<C>,
        menu: string,
        ...middleware: MenuMiddleware<C>[]
    ) {
        return this.text(
            text,
            middleware.length === 0
                ? (ctx) => ctx.menu.nav(menu)
                : (ctx, next) => (ctx.menu.nav(menu), next()),
            ...middleware,
        );
    }
    /**
     * Adds a text button that performs a navigation to the parent menu via
     * `ctx.menu.back()`.
     *
     * @param text The text to display, or a text with payload
     * @param middleware The listeners to call when the button is pressed
     */
    back(text: MaybeDynamicString<C>, ...middleware: MenuMiddleware<C>[]): this;
    back(
        text: TextAndPayload<C>,
        ...middleware: MenuMiddleware<C & { match: string }>[]
    ): this;
    back(text: MaybePayloadString<C>, ...middleware: MenuMiddleware<C>[]): this;
    back(text: MaybePayloadString<C>, ...middleware: MenuMiddleware<C>[]) {
        return this.text(
            text,
            middleware.length === 0
                ? (ctx) => ctx.menu.back()
                : (ctx, next) => (ctx.menu.back(), next()),
            ...middleware,
        );
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
     * @param menuFactory Async menu factory function
     */
    dynamic(
        rangeBuilder: (
            ctx: C,
            range: MenuRange<C>,
        ) => MaybePromise<MaybeRawRange<C> | void>,
    ) {
        return this.addRange(async (ctx: C) => {
            const range = new MenuRange<C>();
            const res = await rangeBuilder(ctx, range);
            if (res instanceof Menu) {
                throw new Error(
                    "Cannot use a `Menu` instance as a dynamic range, did you mean to return an instance of `MenuRange` instead?",
                );
            }
            return res instanceof MenuRange ? res : range;
        });
    }
    /**
     * Appends a given range to this range. This will effectively replay all
     * operations of the given range onto this range.
     *
     * @param range A potentially raw range
     */
    append(range: MaybeRawRange<C>) {
        if (range instanceof MenuRange) {
            this[ops].push(...range[ops]);
            return this;
        } else return this.addRange(range);
    }
}

/**
 * Configuration options for the menu.
 */
export interface MenuOptions<C extends Context> {
    /**
     * Menus will automatically call `ctx.answerCallbackQuery` with no
     * arguments. If you want to call the method yourself, for example because
     * you need to send custom messages, you can set `autoAnswer` to `false` to
     * disable this behavior.
     */
    autoAnswer?: boolean;
    /**
     * A menu is rendered once when it is sent, and once when a callback query
     * arrives. After all, we could not store all rendered menus in all chats
     * forever.
     *
     * If a user presses a button on an old menu instance far up the chat, the
     * buttons may have changed completely by now, and the menu would be
     * rendered differently today. Consequently, this menu plugin can detect if
     * the menu rendered based on the newly incoming callback query is the same
     * as the menu that was sent originally.
     *
     * If the menu is found to be outdated, no handlers are run. Instead, the
     * old message is updated and a fresh menu is put into place. A notification
     * is shown to the user that the menu was outdated. Long story short, you
     * can use this option to personalize what notification to display. You can
     * pass a string as the message to display to the user.
     *
     * Alternatively, you can specify custom middleware that will be invoked and
     * that can handle this case as you wish. You should update the menu
     * yourself, or send a new message with the updated menu.
     *
     * The default behavior is to display this message, and to update the menu:
     * “Menu was outdated, try again!”
     *
     * You can set `onMenuOutdated` to `false` to disable checks for outdated
     * menus altogether. In that case, the menu will behave as if the message
     * was no outdated, and run all handlers regardless.
     */
    onMenuOutdated?: string | boolean | MenuMiddleware<C>;
    /**
     * Fingerprint function that lets you generate a unique string every time a
     * menu is rendered. Used to determine if a menu is outdated. If specified,
     * replaces the built-in heuristic.
     *
     * The built-in heuristic that determines whether a menu is outdated takes
     * the following things into account:
     * - identifier of the menu
     * - shape of the menu
     * - position of the pressed button
     * - potential payload
     * - text of the pressed button
     *
     * If all of these things are identical but the menu is still outdated, you
     * can use this option to supply the neccessary data that lets the menu
     * plugin determine more accurately if the menu is outdated. Similarly, if
     * any of these things differ but you want to consider the menu to be up to
     * date, you can also use this option to signal that.
     *
     * In other words, specifying a fingerprint function will replace the above
     * heuristic entirely by your own implementation.
     */
    fingerprint?: DynamicString<C>;
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
 *   await ctx.reply('Check out this menu:', {
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
export class Menu<C extends Context = Context> extends MenuRange<C>
    implements MiddlewareObj<C>, InlineKeyboardMarkup {
    private parent: string | undefined = undefined;
    private index: Map<string, Menu<C>> = new Map();
    private readonly options: Required<
        MenuOptions<C> & { onMenuOutdated: string | false | MenuMiddleware<C> }
    >;

    /**
     * Creates a new menu with the given identifier.
     *
     * Check out the [official
     * documentation](https://grammy.dev/plugins/menu.html) to see how you can
     * create menus that span several pages, how to navigate between them, and
     * more.
     *
     * @param id Identifier of the menu
     * @param options Further configuration options
     */
    constructor(private readonly id: string, options: MenuOptions<C> = {}) {
        super();
        if (id.includes("/")) {
            throw new Error(
                `You cannot use '/' in a menu identifier ('${id}')`,
            );
        }
        this.index.set(id, this);
        const outdated = options.onMenuOutdated;
        this.options = {
            autoAnswer: options.autoAnswer ?? true,
            onMenuOutdated: outdated === undefined || outdated === true
                ? "Menu was outdated, try again!"
                : outdated,
            fingerprint: options.fingerprint ?? (() => ""),
        };
        if (
            options.onMenuOutdated === false &&
            options.fingerprint !== undefined
        ) {
            throw new Error(
                "Cannot use a fingerprint function when outdated detection is disabled!",
            );
        }
    }
    /**
     * Used internally by the menu, do not touch or you'll burn yourself.
     */
    public readonly inline_keyboard = new Proxy([], {
        get: () => {
            throw new Error(
                `Cannot send menu '${this.id}'! Did you forget to use bot.use() for it or try to send it through bot.api?`,
            );
        },
    });
    /**
     * Registers a submenu. This makes it accessible for navigation, and sets
     * its parent menu to `this` menu.
     *
     * Optionally, you can specify the identifier of a different parent menu as
     * a second argument. The parent menu is the menu that is targeted when
     * backwards navigation is performed.
     *
     * Note that once you registered a submenu, it is sufficient to call
     * `bot.use(menu)` for the parent menu only. You do not need to make all
     * submenus interactive by passing them to `bot.use`.
     *
     * @param menus The menu to register, or an array of them
     * @param parent An optional parent menu identifier
     */
    register(menus: Menu<C> | Menu<C>[], parent = this.id) {
        const arr = Array.isArray(menus) ? menus : [menus];
        const existing = arr.find((m) => this.index.has(m.id));
        if (existing !== undefined) {
            throw new Error(`Menu '${existing.id}' already registered!`);
        }
        this.freeze();
        for (const menu of arr) {
            menu.freeze();
            // `menu.index` includes `menu` itself
            menu.index.forEach((m, id) => {
                this.index.set(id, m);
                m.index = this.index;
            });
            menu.parent = parent;
        }
    }
    /**
     * Prevents this menu from being modified further in the future.
     */
    private freeze() {
        if (Object.isFrozen(this[ops])) return;
        this[ops].push = () => {
            throw new Error(
                "You cannot change a menu after your bot started! Did you mean to use a dynamic range instead?",
            );
        };
        Object.freeze(this[ops]);
    }
    /**
     * Returns the menu instance for the given identifier. If the identifier is
     * the same as this menu's identifier, `this` is returned.
     *
     * @param id Menu identifier
     * @returns The identified menu
     */
    at(id: string) {
        const menu = this.index.get(id);
        if (menu === undefined) {
            const validIds = Array.from(this.index.keys())
                .map((k) => `'${k}'`)
                .join(", ");
            throw new Error(
                `Menu '${id}' is not known to menu '${this.id}'! Known submenus are: ${validIds}`,
            );
        }
        return menu;
    }

    /**
     * Renders the menu to a static object of inline keyboard buttons by
     * concatenating all ranges, and applying the given context object to all
     * functions.
     *
     * @param ctx Context object to use
     */
    private async render(ctx: C) {
        // Create renderer
        const renderer = createRenderer(
            ctx,
            async (btn, i, j): Promise<InlineKeyboardButton> => {
                const text = await uniform(ctx, btn.text);

                if ("url" in btn) {
                    let { url, ...rest } = btn;
                    url = await uniform(ctx, btn.url);
                    return { ...rest, url, text };
                } else if ("middleware" in btn) {
                    const row = i.toString(16);
                    const col = j.toString(16);
                    const payload = await uniform(ctx, btn.payload, "");
                    if (payload.includes("/")) {
                        throw new Error(
                            `Could not render menu '${this.id}'! Payload must not contain a '/' character but was '${payload}'`,
                        );
                    }
                    return {
                        callback_data: `${this.id}/${row}/${col}/${payload}/`,
                        text,
                    };
                } else return { ...btn, text };
            },
        );
        // Render button array
        const rendered = await renderer(this[ops]);
        // Get shape of array
        const lengths = [rendered.length, ...rendered.map((row) => row.length)];
        // Generate fingerprint
        const fingerprint = await uniform(ctx, this.options.fingerprint);
        for (const row of rendered) {
            for (const btn of row) {
                if ("callback_data" in btn) {
                    // Inject hash values to detect keyboard changes
                    let type: "h" | "f";
                    let data: number[];
                    if (fingerprint) {
                        type = "f";
                        data = toNums(fingerprint);
                    } else {
                        type = "h";
                        data = [...lengths, ...toNums(btn.text)];
                    }
                    btn.callback_data += type + tinyHash(data);
                }
            }
        }
        return rendered;
    }

    /**
     * Replaces known menu instances in the payload by their rendered versions.
     * A menu is known if it is contained in this menu's index. Only the
     * `reply_markup` property of the given object is checked for containing a
     * menu.
     *
     * @param payload Payload of API call
     * @param ctx Context object
     */
    private async prepare(payload: Record<string, unknown>, ctx: C) {
        if (payload.reply_markup instanceof Menu) {
            const menu = this.index.get(payload.reply_markup.id);
            if (menu !== undefined) {
                const rendered = await menu.render(ctx);
                payload.reply_markup = { inline_keyboard: rendered };
            }
        }
    }
    middleware() {
        const composer = new Composer<C>((ctx, next) => {
            ctx.api.config.use(async (prev, method, payload, signal) => {
                const p: Record<string, unknown> = payload;
                if (Array.isArray(p.results)) {
                    await Promise.all(
                        p.results.map((r) => this.prepare(r, ctx)),
                    );
                } else await this.prepare(p, ctx);
                return await prev(method, payload, signal);
            });
            return next();
        });
        composer.on("callback_query:data").lazy(async (ctx) => {
            // Extract data from callback query data
            const [id, rowStr, colStr, payload, ...rest] = ctx
                .callbackQuery.data.split("/");
            const [type, ...h] = rest.join("/");
            const hash = h.join("");
            // Skip handling if this is not a known format
            if (!rowStr || !colStr) return [];
            if (type !== "h" && type !== "f") return [];
            // Get matched menu from index
            const menu = this.index.get(id);
            if (menu === undefined) return [];
            const row = parseInt(rowStr, 16);
            const col = parseInt(colStr, 16);
            if (row < 0 || col < 0) {
                const msg = `Invalid button position '${rowStr}/${colStr}'`;
                throw new Error(msg);
            }
            const outdated = menu.options.onMenuOutdated;
            // provide payload on `ctx.match` if it is not empty
            if (payload) ctx.match = payload;
            // Create middleware that installs `ctx.menu`
            const navInstaller = this.makeNavInstaller(menu);
            /** Defines what happens if the used menu is outdated */
            function menuIsOutdated() {
                if (outdated === false) throw new Error("cannot happen");
                return typeof outdated !== "string"
                    ? [navInstaller, outdated as Middleware<C>]
                    : (ctx: C) =>
                        Promise.all([
                            ctx.answerCallbackQuery({ text: outdated }),
                            ctx.editMessageReplyMarkup({ reply_markup: menu }),
                        ]);
            }
            // Check fingerprint if used
            const fingerprint = await uniform(ctx, menu.options.fingerprint);
            const useFp = fingerprint !== "";
            if (useFp !== (type === "f")) return menuIsOutdated();
            if (useFp && tinyHash(toNums(fingerprint)) !== hash) {
                return menuIsOutdated();
            }
            // Create renderer and perform rendering
            const renderer = createRenderer(ctx, (btn: MenuButton<C>) => btn);
            const range: RawRange<C> = await renderer(menu[ops]);
            // Check dimension
            const check = !useFp && outdated !== false;
            if (check && (row >= range.length || col >= range[row].length)) {
                return menuIsOutdated();
            }
            // Check correct button type
            const btn = range[row][col];
            if (!("middleware" in btn)) {
                if (check) return menuIsOutdated();
                throw new Error(
                    `Cannot invoke handlers because menu '${menu.id}' is outdated!`,
                );
            }
            // Check dimensions
            if (check) {
                const rowCount = range.length;
                const rowLengths = range.map((row) => row.length);
                const label = await uniform(ctx, btn.text);
                const data = [rowCount, ...rowLengths, ...toNums(label)];
                const expectedHash = tinyHash(data);
                if (hash !== expectedHash) return menuIsOutdated();
            }
            // Run handler
            const handler = btn.middleware as Middleware<C>[];
            const mw = [navInstaller, ...handler];
            if (!menu.options.autoAnswer) return mw;
            const c = new Composer<C>();
            c.fork((ctx) => ctx.answerCallbackQuery());
            c.use(...mw);
            return c;
        });
        return composer.middleware();
    }

    private makeNavInstaller<C extends Context>(menu: Menu<C>): Middleware<C> {
        return async (ctx, next) => {
            let injectMenu = false;
            let targetMenu: Menu<C> | undefined = menu;

            ctx.api.config.use((prev, method, payload, signal) => {
                if (
                    INJECT_METHODS.has(method) &&
                    !("reply_markup" in payload) &&
                    "chat_id" in payload &&
                    payload.chat_id !== undefined &&
                    payload.chat_id === ctx.chat?.id &&
                    "message_id" in payload &&
                    payload.message_id !== undefined &&
                    payload.message_id === ctx.msg?.message_id
                ) {
                    injectMenu = false;
                    Object.assign(payload, { reply_markup: targetMenu });
                }
                return prev(method, payload, signal);
            });

            async function nav({ immediate }: Immediate = {}, menu?: Menu<C>) {
                injectMenu = true;
                targetMenu = menu;
                if (immediate) await ctx.editMessageReplyMarkup();
            }
            const controlPanel: MenuControlPanel = {
                update: (config) => nav(config, menu),
                close: (config) => nav(config, undefined),
                nav: (to, config) => nav(config, menu.at(to)),
                back: (config) => {
                    const parent = menu.parent;
                    if (parent === undefined) {
                        throw new Error(
                            `Cannot navigate back from menu '${menu.id}', no known parent!`,
                        );
                    }
                    return nav(config, menu.at(parent));
                },
            };
            // register ctx.menu
            Object.assign(ctx, { menu: controlPanel });
            try {
                // call handlers
                await next();
                // update menu if it could not be injected
                if (injectMenu) await nav({ immediate: true }, targetMenu);
            } finally {
                // unregister ctx.menu
                Object.assign(ctx, { menu: undefined });
            }
        };
    }
}

/**
 * Creates an asynchronous rendering function for a given context object. A
 * rendering function takes a potentially dynamic menu range, and generates a
 * static two-dimensional array of button objects.
 *
 * Menu ranges store menu buttons. You need to pass a button transformer
 * function that turns a menu button into whatever button type you want to be
 * generated. For example, you may want to pass a function that generates inline
 * buttons. This function can be asynchronous.
 *
 * @param ctx Context object
 * @param buttonTransformer Button transformer
 * @returns Rendering function
 */
function createRenderer<C extends Context, B>(
    ctx: C,
    buttonTransformer: (
        btn: MenuButton<C>,
        row: number,
        col: number,
    ) => MaybePromise<B>,
): (ops: MaybeDynamicRange<C>[]) => Promise<B[][]> {
    async function layout(
        keyboard: Promise<B[][]>,
        range: MaybeDynamicRange<C>,
    ): Promise<B[][]> {
        const k = await keyboard;
        // Make static
        const btns = typeof range === "function" ? await range(ctx) : range;
        // Make raw
        if (btns instanceof MenuRange) {
            return btns[ops].reduce(layout, keyboard);
        }
        // Replay new buttons on top of partially constructed keyboard
        let first = true;
        for (const row of btns) {
            if (!first) k.push([]);
            const i = k.length - 1;
            for (const button of row) {
                const j = k[i].length;
                const btn = await buttonTransformer(button, i, j);
                k[i].push(btn);
            }
            first = false;
        }
        return k;
    }
    return (ops) => ops.reduce(layout, Promise.resolve([[]]));
}

/**
 * Turns an optional and potentially dynamic string into a regular string for a
 * given context object.
 *
 * @param ctx Context object
 * @param value Potentially dynamic string
 * @param fallback Fallback string value if value is undefined
 * @returns Plain old string
 */
function uniform<C extends Context>(
    ctx: C,
    value: MaybeDynamicString<C> | undefined,
    fallback = "",
): MaybePromise<string> {
    if (value === undefined) return fallback;
    else if (typeof value === "function") return value(ctx);
    else return value;
}
