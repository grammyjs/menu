# Interactive menus for grammY

Check out the [official documentation](https://grammy.dev/plugins/menu.html) for this plugin.

A menu is a set of interactive buttons that is displayed beneath a message.
It uses an [inline keyboard](https://grammy.dev/plugins/keyboard.html) for that, so in a sense, a menu is just an inline keyboard spiced up with interactivity (such as navigation between multiple pages).

## Quickstart

Here is a small example.

```ts
// Creating a simple menu
const menu = new Menu("my-menu-identifier")
    .text("A", (ctx) => ctx.reply("You pressed A!")).row()
    .text("B", (ctx) => ctx.reply("You pressed B!"));

// Make it interactive
bot.use(menu);

bot.command("start", async (ctx) => {
    // Send the menu:
    await ctx.reply("Check out this menu:", { reply_markup: menu });
});
```

You can find more examples and documentation on [the plugin page on the website](https://grammy.dev/plugins/menu.html).

## Development

This is a Deno project.

To work on this project, first install npm dependencies as usual:

```bash
npm install
```

Then having Deno CLI installed, run:

```bash
deno cache src/deps.deno.ts
```

If you are using Visual Studio Code - install [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
and official [Deno extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno).

To automatically rebuild the project after changes, run:

```bash
npx nodemon
```

To use test package locally, first link it using npm:

```bash
npm link
```

Then, in your project use the linked package:

```bash
npm link @grammyjs/menu
```

After you finish development, simply reinstall the package:

```bash
npm install @grammyjs/menu
```
