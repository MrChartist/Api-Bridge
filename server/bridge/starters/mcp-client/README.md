# MCP client starter for the Bridge

The Bridge is an MCP server, so an AI assistant, or a program you write, can use its tools: prices, history, option
chains, positions. This project shows both sides: a tiny client you can read in one sitting (`mcp.mjs`), and the
settings an assistant app needs (`host-config.example.json`). Node 22 or newer, no packages to install.

## Three steps

1. {{keyStep}}
2. List the tools this key may use:

   ```bash
   cd {{folder}}
   node mcp.mjs
   ```

3. Call one:

   ```bash
   node mcp.mjs get_ltp '{"symbols":["NSE:RELIANCE"]}'
   ```

## For an assistant app

Copy `host-config.example.json` into the app's MCP settings, fill in the two values and restart the app. A key made
with `--client mcp` cannot have the admin scope: an assistant must never confirm its own orders. With a `read` key it
sees only read tools.

## The key

{{keyNote}}

Results come wrapped in "untrusted data" markers because instrument names and broker messages are third-party text. A
program that passes results to a language model should keep those markers and treat the contents as data, never as
instructions.
