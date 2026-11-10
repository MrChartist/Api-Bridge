# Connect a tool

The dashboard's **Connect a tool** page (`#/connect`, in the sidebar under Bridge, on the Accounts page and in the
search palette) gives Excel, an AI assistant or a script its own key and the setup to paste, in three steps:

1. **Choose the tool:** Excel or Google Sheets, an AI assistant (Claude, ChatGPT), a Python script, a Node script, your
   own app, or AmiBroker.
2. **Check what it may do, then press Create key and show setup.** The key has only the access that tool needs.
3. **Copy the key and the setup, then press Test it.** The setup already has this Bridge's address and your new key in
   it. Test it asks the Bridge for a price with that key, the way your tool will, and says in plain words whether it
   worked.

The key is shown once. The Bridge keeps only a short code that recognises it, so copy it before you leave the page. If you
lose it, revoke it under **API > Keys** and make another. In the Simple view the API page is hidden: press Ctrl K and type
*Keys*, or switch to Advanced (see below).

## What each tool gets

| Tool | Key | May it place orders? |
|---|---|---|
| Excel or Google Sheets | Read only, may be sent in the address (`?key=`, the `--allow-query` flag), expires in 90 days | No. The key in an address suits Excel on this computer; Google Sheets cannot reach this computer without a tunnel and must use the Apps Script with the key in a script property, never an `IMPORTDATA` link ([excel-sheets.md](excel-sheets.md#google-sheets)) |
| AmiBroker | Read only, may be sent in the address, expires in 90 days | No |
| An AI assistant | Read only | Your choice: "Look and prepare orders for me to approve" adds the paper scope. That is not enough on its own: the order tools also need `"mcp": { "toolsets": ["market", "analytics", "account", "orders"], "orderAccounts": ["<your paper account id>"] }` in `bridge.config.json` and a restart (the page shows these lines; [mcp.md](mcp.md#letting-an-assistant-prepare-orders)). The assistant still cannot send an order: you approve each one under Orders. |
| A Python or Node script | Read only | Your choice: "Yes, practice orders" adds the paper scope |
| My own app | Read only | Your choice, as for a script |

The safe answer is always the first one, and no choice on this page makes a key that can place a real-money order. Live
keys are made in the terminal. The rules are the ones the Keys page uses (`flows.js` and `snippets.js` in the dashboard).

## Simple and Advanced view

A new browser starts in **Simple**: the menu lists Accounts, Connect a tool, Sources, Orders and Safety, and Sources opens
on the provider cards with one sentence about where your prices come from. **Advanced** adds the API page (Keys,
Integrations, Test console, Activity) and the Sources Overview and Quotas tabs.

Change it from the account menu (bottom of the sidebar, or More on a phone) or from the search palette (Ctrl K, then
type "advanced"). The choice stays in this browser. Nothing is removed in Simple: every page is still in the palette, and
a link to an advanced page opens it.

**Looking for the API page?** Other guides say "API > Integrations" or "API > Keys". In the Simple view there is no API entry
in the menu. Do one of these: press Ctrl K and type the page you want (*Keys*, *Integrations*, *Telegram*, *Webhooks*), or
switch to Advanced. The Connect a tool page also has a **More integrations** link at the bottom, and the pages open
directly at `#/api/keys` and `#/api/integrations` in the address bar.

## Something wrong?

The button in the toolbar of every page lists the usual problems and takes you to the page that explains each one: a tool
that is rate limited, a price that looks old, a key that does not work, a broker that needs a login. **Stop** beside it
stops every new order from every tool; it asks you to confirm first.

When a request in the dashboard fails, the message says the likely cause in plain words and offers one button: log in
again, open Keys, see why it is slow, or log in to your broker.

## Words you do not know

A small **?** after the first use of a technical word on a page (quota, burst, pooling, token and so on) opens a
one-sentence meaning. It is a button, so the keyboard and screen readers work too.
