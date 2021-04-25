# Interactive menus for grammY

Check out the [official documentation](https://grammy.dev/plugins/menu.html) for this plugin.

## Quickstart

A menu is a set of interactive buttons that is displayed beneath a message. It uses an [inline keyboard](https://grammy.dev/plugins/keyboard.html) for that, so in a sense, a menu is just an inline keyboard spiced up with interactivity (such as navigation between multiple pages).

```ts
// Creating a simple menu
const menu = new Menu('my-menu-identifier')
  .text('A', ctx => ctx.reply('You pressed A!')).row()
  .text('B', ctx => ctx.reply('You pressed B!'))

// Make it interactive
bot.use(menu)

bot.command('start', async ctx => {
  // Send the menu:
  await ctx.reply(12345, 'Check out this menu:', {
    reply_markup: menu
  })
})
```
