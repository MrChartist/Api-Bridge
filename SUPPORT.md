# Getting help

The Bridge is free, open source software that runs on your own computer. There is no hosted service and no paid support. Help comes from the docs and from other people using the project.

1. **Read the guides first.** The [quickstart](docs/guides/quickstart.md) lists the fixes for the usual first-run problems, and the [FAQ](docs/guides/faq.md) answers the common questions (is my broker supported, why a price is delayed, where the data lives, how to reset). Installing: [install.md](docs/guides/install.md). An error with a `code`: [error codes](docs/api/errors.md).
2. **Run the checker.** `mc-bridge doctor` (from a checkout: `npm run doctor`) prints what is wrong with your setup in plain words.
3. **Ask a question** in the repository's Discussions, if they are switched on, or open an issue.
4. **Report a bug** with the [bug report form](https://github.com/MrChartist/api-bridge-v2/issues/new/choose). Include the Bridge version, your operating system and Node.js version, the `code` of the error and what you did. Remove keys, tokens, account IDs and other personal data first.
5. **Security problems** are never reported in a public issue: see [SECURITY.md](SECURITY.md).

Not in scope: investment advice, trading tips, help with a broker's own app or account, and tools that analyse or trade for you. The Bridge is a connection layer; see [what it does not do](README.md#what-it-does-not-do).
