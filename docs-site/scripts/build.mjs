import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const output = join(root, 'build');
export const base = '/';
const repo = 'https://github.com/srthkdev/omnisql-mcp';
export const legacyRoutes = ['guides/databases', 'guides/access'];
const manifest = JSON.parse(readFileSync(join(root, '../package.json'), 'utf8'));
const tools = JSON.parse(readFileSync(join(root, 'data/tools.json'), 'utf8'));
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
export const pages = [
  {
    path: 'docs',
    file: 'index.md',
    title: 'Introduction',
    group: 'Start here',
    description: 'What OmniSQL connects, how it works, and what stays on your machine.',
  },
  {
    path: 'docs/getting-started/installation',
    file: 'getting-started/installation.md',
    title: 'Install & connect',
    group: 'Start here',
    description: 'Guided setup for Claude Code, Codex, OpenCode, and other MCP clients.',
  },
  {
    path: 'docs/getting-started/configuration',
    file: 'getting-started/configuration.md',
    title: 'Configuration',
    group: 'Start here',
    description: 'Workspace paths, environment variables, client configuration, and updates.',
  },
  {
    path: 'docs/guides/databases',
    file: 'guides/databases.md',
    title: 'Database support',
    group: 'Use OmniSQL',
    description: 'Drivers, SSH tunnels, TLS, IAM authentication, and database selection.',
  },
  {
    path: 'docs/guides/available-tools',
    file: 'guides/available-tools.md',
    title: 'Tool reference',
    group: 'Use OmniSQL',
    description: 'The complete tool list, with arguments exported from the server.',
  },
  {
    path: 'docs/guides/usage-examples',
    file: 'guides/usage-examples.md',
    title: 'Queries & workflows',
    group: 'Use OmniSQL',
    description: 'Inspect a schema, query another database, export a result, and compare schemas.',
  },
  {
    path: 'docs/guides/access',
    file: 'guides/access.md',
    title: 'Access & safety',
    group: 'Reference',
    description:
      'Read-only mode, connection allowlists, tool filtering, and permission boundaries.',
  },
  {
    path: 'docs/troubleshooting',
    file: 'troubleshooting.md',
    title: 'Troubleshooting',
    group: 'Reference',
    description: 'Resolve startup, workspace, authentication, and database errors.',
  },
];
const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language }).value;
    return escape(code);
  },
});
const slug = (value) =>
  value
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const defaultHeading = md.renderer.rules.heading_open;
md.renderer.rules.heading_open = (tokens, index, opts, env, self) => {
  const text = tokens[index + 1]?.content ?? '';
  tokens[index].attrSet('id', slug(text));
  if (['h2', 'h3'].includes(tokens[index].tag))
    env.headings?.push({ title: text.replace(/`/g, ''), id: slug(text), level: tokens[index].tag });
  return defaultHeading
    ? defaultHeading(tokens, index, opts, env, self)
    : self.renderToken(tokens, index, opts);
};
const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (...args) =>
  `<div class="code-block"><button class="copy-code" type="button" aria-label="Copy code">copy</button>${fence(...args)}</div>`;
const links = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, index, opts, env, self) => {
  const href = tokens[index].attrGet('href');
  if (href && !/^(?:[a-z]+:|\/)/i.test(href)) {
    const [path, fragment] = href.split('#');
    if (path.endsWith('.md')) {
      const file = posix.normalize(posix.join(posix.dirname(env.file), path));
      const target = pages.find((page) => page.file === file);
      if (!target) throw new Error(`Unknown documentation link in ${env.file}: ${href}`);
      tokens[index].attrSet('href', base + target.path + '/' + (fragment ? '#' + fragment : ''));
    }
  }
  return links ? links(tokens, index, opts, env, self) : self.renderToken(tokens, index, opts);
};
const mark =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M10 5H5v22h5M22 5h5v22h-5M12 12h8M12 20h8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14 16h4" stroke="var(--accent)" stroke-width="2"/></svg>';
function header(active = '') {
  return `<a class="skip-link" href="#main">Skip to content</a><header class="site-header"><a class="wordmark" href="${base}" aria-label="OmniSQL home">${mark}<span>omni<span class="wordmark-sql">sql</span><small>MCP</small></span></a><nav aria-label="Main navigation"><a ${active === 'docs' ? 'aria-current="page"' : ''} href="${base}docs/">Documentation</a><a href="${base}#session">In use</a><a href="${repo}/releases/tag/v${manifest.version}">v${manifest.version}</a></nav><div class="nav-end"><button class="search-trigger" type="button" aria-label="Search documentation">Search docs <kbd>⌘ K</kbd></button><a class="source-link" href="${repo}" aria-label="OmniSQL on GitHub">GitHub ↗</a></div></header>`;
}
const search = `<dialog class="search-dialog" aria-label="Search documentation"><form method="dialog"><label for="search-input">Find something in the docs</label><button class="search-close" type="button" aria-label="Close search">esc</button><input id="search-input" type="search" placeholder="Workspace, read-only, PostgreSQL…" autocomplete="off"></form><div id="search-results" aria-live="polite"></div></dialog>`;
function footer() {
  return `<footer class="site-footer"><a class="wordmark" href="${base}">${mark}<span>omnisql</span></a><p>A small bridge between your databases and your assistant.</p><div><a href="${repo}">Source ↗</a><a href="${repo}/issues">Issues ↗</a><a href="${repo}/blob/main/LICENSE">MIT license</a></div></footer>`;
}
function shell(title, description, body, active = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f3f1ec"><title>${escape(title)} — OmniSQL</title><meta name="description" content="${escape(description)}"><meta property="og:title" content="${escape(title)} — OmniSQL"><meta property="og:description" content="${escape(description)}"><meta property="og:image" content="https://omnisql.srthkdev.com/media/social-card.png"><link rel="icon" href="${base}media/logo.svg" type="image/svg+xml"><link rel="stylesheet" href="${base}site.css"><script type="module" src="${base}site.js"></script></head><body data-base="${base}">${header(active)}${body}${footer()}${search}</body></html>`;
}
function sidebar(current) {
  let group = '';
  return `<nav class="docs-nav" aria-label="Documentation">${pages
    .map((page) => {
      const heading = page.group !== group ? `<p class="nav-group">${escape(page.group)}</p>` : '';
      group = page.group;
      return `${heading}<a ${page.path === current ? 'aria-current="page"' : ''} href="${base}${page.path}/">${escape(page.title)}${page.path === current ? '<span>↳</span>' : ''}</a>`;
    })
    .join('')}<a class="nav-source" href="${repo}/releases">Changelog ↗</a></nav>`;
}
function toolReference() {
  return tools
    .map((tool) => {
      const required = tool.inputSchema.required ?? [];
      const args = Object.entries(tool.inputSchema.properties ?? {});
      return `<section class="tool-entry" id="${tool.name}"><h2><code>${tool.name}</code></h2><p>${escape(tool.description)}</p>${args.length ? `<div class="table-scroll"><table><thead><tr><th>Argument</th><th>Type</th><th>Description</th></tr></thead><tbody>${args.map(([name, prop]) => `<tr><td><code>${name}</code>${required.includes(name) ? '<small class="required">required</small>' : ''}</td><td><code>${escape(prop.type ?? 'string')}</code></td><td>${escape(prop.description ?? '')}${prop.default !== undefined ? ` Default: <code>${escape(JSON.stringify(prop.default))}</code>.` : ''}${prop.enum ? ` Options: ${prop.enum.map((value) => `<code>${escape(value)}</code>`).join(', ')}.` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No arguments.</p>'}</section>`;
    })
    .join('');
}
function home() {
  const video = existsSync(join(root, '../assets/codex-session.mp4'));
  return shell(
    'Your connections, already configured',
    'An MCP server that reuses your saved database connections. PostgreSQL, MySQL, SQLite, SQL Server, and Oracle.',
    `<main id="main">
  <section class="hero section-wrap"><div class="hero-copy"><p class="eyebrow"><span class="accent-square"></span> LOCAL CONNECTIONS / MCP SERVER</p><h1>Your databases.<br>Already <em>connected.</em></h1><p class="hero-description">The connections you saved in DBeaver, available in Claude Code, Codex, and OpenCode. Same credentials. Same tunnels. One small server.</p><div class="hero-actions"><a class="button primary" href="${base}docs/getting-started/installation/">Connect your assistant <span>↗</span></a><a class="text-link" href="#workspace">See how it works ↓</a></div><div class="install-line"><span aria-hidden="true">$</span><code>npx -y omnisql-mcp@latest install</code><button data-copy="npx -y omnisql-mcp@latest install" aria-label="Copy setup command">copy</button></div><p class="hero-note">Open source · runs on your machine · Bun or Node.js 22.15+</p></div>
  <div class="workspace-panel" id="workspace"><div class="panel-heading"><span>WORKSPACE / EXAMPLE</span><span class="small-status">read-only</span></div><div class="panel-layout"><div class="connection-list"><span class="micro-label">CONNECTIONS</span><button class="connection active" data-example="revenue" aria-pressed="true"><span class="connection-icon">S</span><span>sales<small>SQLite · local</small></span><span class="connection-count">02</span></button><button class="connection" data-example="events" aria-pressed="false"><span class="connection-icon">P</span><span>app_logs<small>PostgreSQL · local</small></span><span class="connection-count">01</span></button><div class="connection-note">Saved once.<br>Reused by your assistant.</div></div><div class="query-area"><div class="query-tab"><span id="query-label">sales / paid revenue</span><span>.sql</span></div><pre id="sample-query"><span class="sql-keyword">SELECT</span> c.name, <span class="sql-function">SUM</span>(o.total) <span class="sql-keyword">AS</span> revenue
<span class="sql-keyword">FROM</span> customers c
<span class="sql-keyword">JOIN</span> orders o <span class="sql-keyword">ON</span> c.id = o.customer_id
<span class="sql-keyword">WHERE</span> o.status = <span class="sql-string">'paid'</span>
<span class="sql-keyword">GROUP BY</span> c.name
<span class="sql-keyword">ORDER BY</span> revenue <span class="sql-keyword">DESC</span>;</pre><div class="result-heading"><span>RESULT</span><span id="result-count">2 rows</span></div><table class="sample-result"><thead id="sample-head"><tr><th>name <small>text</small></th><th>revenue <small>numeric</small></th></tr></thead><tbody id="sample-body"><tr><td>Asha Rao</td><td>420.00</td></tr><tr><td>Mira, Inc.</td><td>320.00</td></tr></tbody></table></div></div><div class="panel-caption"><span>01 — Sample data from the test workspace</span><span>${tools.length} tools / 5 native drivers</span></div></div></section>
  <div class="engine-strip section-wrap"><span class="micro-label">NATIVE DRIVERS</span><span>PostgreSQL</span><span>MySQL / MariaDB</span><span>SQLite</span><span>SQL Server</span><span>Oracle</span><a href="${base}docs/guides/databases/">Compatibility ↗</a></div>
  <section class="section-wrap explanation"><div><p class="eyebrow">01 / LESS SETUP</p><h2>You already did<br>the configuration.</h2><p>OmniSQL reads the connection settings in your local workspace. It opens a direct database connection using the saved host, credentials, and network settings.</p><p>There is no hosted proxy to set up. Your MCP client starts the server when it needs it.</p><a class="text-link" href="${base}docs/guides/databases/">Read the connection guide ↗</a></div><div class="connection-diagram"><div class="diagram-node"><span class="micro-label">SAVED WORKSPACE</span><strong>DBeaver</strong><small>hosts · credentials · TLS · SSH</small></div><div class="diagram-line"><span>read settings</span><i>↓</i></div><div class="diagram-node diagram-omni">${mark}<strong>omnisql</strong><small>native database drivers</small></div><div class="diagram-line"><span>MCP over stdio</span><i>↓</i></div><div class="diagram-clients"><span>Claude Code</span><span>Codex</span><span>OpenCode</span></div></div></section>
  <section class="section-wrap capabilities"><div class="section-heading"><div><p class="eyebrow">02 / THE WORK</p><h2>From “what’s in here?”<br>to a useful answer.</h2></div><a class="text-link" href="${base}docs/guides/available-tools/">All ${tools.length} tools ↗</a></div><div class="capability-rows"><a href="${base}docs/guides/usage-examples/#inspect-before-querying"><span class="row-number">01</span><div><h3>Find your way around</h3><p>List connections, browse tables, and inspect columns before writing a query.</p></div><code>list_tables</code><span>↗</span></a><a href="${base}docs/guides/usage-examples/#query-another-database"><span class="row-number">02</span><div><h3>One server. Another database.</h3><p>Discover accessible databases and choose a target without adding another saved connection.</p></div><code>list_databases</code><span>↗</span></a><a href="${base}docs/guides/usage-examples/#export-a-result"><span class="row-number">03</span><div><h3>Take the result with you</h3><p>Export CSV or JSON, inspect a query plan, or compare two schemas.</p></div><code>export_data</code><span>↗</span></a><a href="${base}docs/guides/access/"><span class="row-number">04</span><div><h3>Decide what is accessible</h3><p>Use read-only mode, allow specific connections, and turn off individual tools.</p></div><code>OMNISQL_READ_ONLY</code><span>↗</span></a></div></section>
  <section class="session-section section-wrap" id="session"><div class="section-heading"><div><p class="eyebrow">03 / IN USE</p><h2>The actual conversation.</h2></div><p>A real Codex CLI session, querying the isolated sample databases through OmniSQL. No simulated assistant responses.</p></div>${video ? `<video controls preload="none" poster="${base}media/mcp-instance-calls.webp" aria-label="Real Codex CLI session using OmniSQL MCP"><source src="${base}media/codex-session.mp4" type="video/mp4"><a href="${base}media/codex-session.mp4">Download the recording</a></video>` : '<p class="recording-pending">Session recording is being prepared.</p>'}<p class="figure-note">Synthetic customers and orders. Read-only access. <a href="${base}media/codex-session.gif" download>Download the GIF preview ↗</a></p></section>
  <section class="section-wrap start-section"><div><p class="eyebrow">GET CONNECTED</p><h2>Keep your workspace.<br>Add your assistant.</h2></div><div class="setup-box"><div class="client-tabs" role="tablist" aria-label="Setup client"><button role="tab" id="client-guided" aria-controls="setup-details" aria-selected="true" tabindex="0" data-client="guided">Guided</button><button role="tab" id="client-claude" aria-controls="setup-details" aria-selected="false" tabindex="-1" data-client="claude">Claude Code</button><button role="tab" id="client-codex" aria-controls="setup-details" aria-selected="false" tabindex="-1" data-client="codex">Codex</button><button role="tab" id="client-opencode" aria-controls="setup-details" aria-selected="false" tabindex="-1" data-client="opencode">OpenCode</button></div><div id="setup-details" role="tabpanel" aria-labelledby="client-guided"><div class="setup-command"><span>$</span><code id="install-command">npx -y omnisql-mcp@latest install</code><button id="copy-install" aria-label="Copy selected install command">copy</button></div><p id="install-caption">Choose a client, a workspace, and the access you want to allow.</p><a class="text-link" href="${base}docs/getting-started/installation/">Full setup instructions ↗</a></div></div></section></main>`
  );
}
function write(path, contents) {
  const target = join(output, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
export async function build() {
  const bundle = await Bun.build({ entrypoints: [join(root, 'styles/site.css'), join(root, 'client/site.js')], target: 'browser', minify: true, write: false });
  if (!bundle.success) throw new AggregateError(bundle.logs, 'Website asset build failed');
  const files = new Map(await Promise.all(bundle.outputs.map(async (file) => [file.path.split('/').at(-1), await file.text()])));

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  write('index.html', home());
  const searchIndex = [];
  for (const [index, page] of pages.entries()) {
    const source = readFileSync(join(root, 'docs', page.file), 'utf8').replace(
      /^---\n[\s\S]*?\n---\n/,
      ''
    );
    const env = { headings: [], file: page.file };
    let content = md.render(source, env);
    if (page.path.endsWith('available-tools')) content += toolReference();
    const previous = pages[index - 1],
      next = pages[index + 1];
    const toc = page.path.endsWith('available-tools')
      ? tools.map((tool) => ({ id: tool.name, title: tool.name, level: 'h2' }))
      : env.headings;
    const html = shell(
      page.title,
      page.description,
      `<main id="main" class="docs-layout"><aside class="sidebar">${sidebar(page.path)}</aside><div class="docs-center"><details class="mobile-docs"><summary>Documentation / ${escape(page.title)}</summary>${sidebar(page.path)}</details><article class="prose"><div class="article-meta"><span>${escape(page.group)}</span><a href="${repo}/blob/main/docs-site/docs/${page.file}">Edit this page ↗</a></div>${content}<nav class="page-pagination" aria-label="Documentation pages">${previous ? `<a href="${base}${previous.path}/"><small>PREVIOUS</small>${previous.title} ←</a>` : '<span></span>'}${next ? `<a href="${base}${next.path}/"><small>NEXT</small>${next.title} →</a>` : ''}</nav></article></div><aside class="toc"><p class="micro-label">ON THIS PAGE</p><nav aria-label="On this page">${toc.map((item) => `<a class="${item.level === 'h3' ? 'toc-child' : ''}" href="#${item.id}">${escape(item.title)}</a>`).join('')}</nav></aside></main>`,
      'docs'
    );
    write(`${page.path}/index.html`, html);
    searchIndex.push({
      title: page.title,
      url: base + page.path + '/',
      text: source.replace(/[#*`|\[\]]/g, ' ').slice(0, 24000),
    });
  }
  // Published README versions used these paths before documentation moved under /docs.
  for (const legacy of legacyRoutes) {
    const destination = base + 'docs/' + legacy + '/';
    write(
      `${legacy}/index.html`,
      shell('Documentation moved', 'Continue to the current documentation.',
        `<main id="main"><h1>Documentation moved</h1><a href="${destination}">Open documentation ↗</a></main>`
      ).replace('</head>', `<meta http-equiv="refresh" content="0; url=${destination}"></head>`)
    );
  }
  for (const tool of tools)
    searchIndex.push({
      title: tool.name,
      url: base + 'docs/guides/available-tools/#' + tool.name,
      text: tool.description + ' ' + Object.keys(tool.inputSchema.properties ?? {}).join(' '),
    });
  write('search.json', JSON.stringify(searchIndex));
  write('site.css', files.get('site.css'));
  write('site.js', files.get('site.js'));
  write('install.sh', readFileSync(join(root, '../scripts/install.sh')));
  for (const name of [
    'logo.svg',
    'wordmark.svg',
    'codex-session.mp4',
    'codex-session.gif',
    'mcp-instance-calls.webp',
    'mcp-multiple-instances.webp',
    'social-card.png',
  ]) {
    const asset = join(root, '../assets', name);
    if (existsSync(asset)) {
      mkdirSync(join(output, 'media'), { recursive: true });
      cpSync(asset, join(output, 'media', name));
    }
  }
  write('.nojekyll', '');
  write(
    '404.html',
    shell(
      'Page not found',
      'This page could not be found.',
      `<main id="main" class="not-found"><p class="eyebrow">404</p><h1>This page moved.</h1><p>Try the documentation or search for what you need.</p><a class="button primary" href="${base}docs/">Open documentation ↗</a></main>`
    )
  );
  write(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['', ...pages.map((page) => page.path + '/')].map((path) => `<url><loc>https://srthkdev.github.io${base}${path}</loc></url>`).join('')}</urlset>`
  );
  console.log(
    `Built custom OmniSQL site: ${pages.length + 1} pages, ${tools.length} tool references.`
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await build();
