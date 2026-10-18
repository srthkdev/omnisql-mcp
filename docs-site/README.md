# OmniSQL website

A custom static site: HTML, CSS, browser JavaScript, and Markdown documentation. The build renders Markdown and syntax highlighting at build time; the deployed site has no framework runtime.

```sh
npm ci
npm run dev
npm test
```

The local preview serves the same `/omnisql-mcp/` base path used by GitHub Pages. `npm run build` writes `build/`, including the standalone installer from `../scripts/install.sh`.

Documentation lives in `docs/`. Navigation and page templates live in `scripts/build.mjs`, styles in `styles/site.css`, and browser interactions in `client/site.js`. `data/tools.json` contains tool schemas exported from the MCP server. Media is copied from `../assets/`.

After changing server tool definitions, build the server in the repository root, then run `npm run tools:refresh --prefix docs-site` to refresh the reference schemas. The export uses an empty temporary workspace and does not query a database.
