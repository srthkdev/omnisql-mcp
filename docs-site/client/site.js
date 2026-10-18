const base = document.body.dataset.base;
const dialog = document.querySelector('.search-dialog');
const input = document.querySelector('#search-input');
const results = document.querySelector('#search-results');
let index;
async function openSearch() {
  dialog.showModal();
  input.focus();
  try {
    index ??= await (await fetch(base + 'search.json')).json();
    renderSearch();
  } catch {
    results.textContent = 'Search is unavailable. Use the documentation navigation.';
  }
}
function renderSearch() {
  const query = input.value.trim().toLowerCase();
  results.replaceChildren();
  const matches = index
    .filter((item) => !query || (item.title + ' ' + item.text).toLowerCase().includes(query))
    .slice(0, 10);
  if (!matches.length) {
    results.textContent = 'No results. Try “workspace”, “database”, or a tool name.';
    return;
  }
  for (const item of matches) {
    const a = document.createElement('a');
    a.href = item.url;
    const title = document.createElement('strong');
    title.textContent = item.title;
    const text = document.createElement('span');
    const position = query ? item.text.toLowerCase().indexOf(query) : 0;
    text.textContent = item.text
      .slice(Math.max(0, position - 40), Math.max(0, position - 40) + 140)
      .replace(/\s+/g, ' ');
    a.append(title, text);
    results.append(a);
  }
}
document
  .querySelectorAll('.search-trigger')
  .forEach((button) => button.addEventListener('click', openSearch));
dialog.querySelector('.search-close').addEventListener('click', () => dialog.close());
dialog.querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  results.querySelector('a')?.click();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    results.querySelector('a')?.focus();
  }
});
input.addEventListener('input', () => {
  if (index) renderSearch();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault();
    if (dialog.open) dialog.close();
    else openSearch();
  }
});
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'copied';
    setTimeout(() => {
      button.textContent = 'copy';
    }, 1800);
  } catch {
    button.textContent = 'select text';
  }
}
document
  .querySelectorAll('[data-copy]')
  .forEach((button) => button.addEventListener('click', () => copy(button.dataset.copy, button)));
document
  .querySelectorAll('.copy-code')
  .forEach((button) =>
    button.addEventListener('click', () =>
      copy(button.parentElement.querySelector('code').textContent, button)
    )
  );
const install = document.querySelector('#install-command');
if (install) {
  document.querySelectorAll('[data-client]').forEach((button) =>
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-client]').forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab === button));
        tab.tabIndex = tab === button ? 0 : -1;
      });
      document.querySelector('#setup-details').setAttribute('aria-labelledby', button.id);
      install.textContent =
        'npx -y omnisql-mcp@latest install' +
        (button.dataset.client === 'guided' ? '' : ' ' + button.dataset.client);
      document.querySelector('#install-caption').textContent =
        button.dataset.client === 'guided'
          ? 'Choose a client, a workspace, and the access you want to allow.'
          : 'Adds OmniSQL for your user account. Append --read-only to disable write tools.';
    })
  );
  document.querySelector('.client-tabs').addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('[data-client]')];
    const current = tabs.indexOf(document.activeElement);
    const position = {
      ArrowRight: (current + 1) % tabs.length,
      ArrowLeft: (current + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (position === undefined) return;
    event.preventDefault();
    tabs[position].focus();
    tabs[position].click();
  });
  document
    .querySelector('#copy-install')
    .addEventListener('click', (event) => copy(install.textContent, event.currentTarget));
}
const examples = {
  revenue: {
    label: 'sales / paid revenue',
    query:
      "SELECT c.name, SUM(o.total) AS revenue\nFROM customers c\nJOIN orders o ON c.id = o.customer_id\nWHERE o.status = 'paid'\nGROUP BY c.name\nORDER BY revenue DESC;",
    columns: [
      ['name', 'text'],
      ['revenue', 'numeric'],
    ],
    rows: [
      ['Asha Rao', '420.00'],
      ['Mira, Inc.', '320.00'],
    ],
  },
  events: {
    label: 'app_logs / event counts',
    query: 'SELECT level, count(*) AS count\nFROM events\nGROUP BY level\nORDER BY level;',
    columns: [
      ['level', 'text'],
      ['count', 'integer'],
    ],
    rows: [
      ['error', '1'],
      ['info', '2'],
      ['warn', '1'],
    ],
  },
};
document.querySelectorAll('[data-example]').forEach((button) =>
  button.addEventListener('click', () => {
    const example = examples[button.dataset.example];
    document.querySelectorAll('[data-example]').forEach((tab) => {
      tab.classList.toggle('active', tab === button);
      tab.setAttribute('aria-pressed', String(tab === button));
    });
    document.querySelector('#query-label').textContent = example.label;
    document.querySelector('#sample-query').textContent = example.query;
    const head = document.querySelector('#sample-head');
    head.replaceChildren();
    const tr = document.createElement('tr');
    for (const [name, type] of example.columns) {
      const th = document.createElement('th');
      th.textContent = name + ' ';
      const small = document.createElement('small');
      small.textContent = type;
      th.append(small);
      tr.append(th);
    }
    head.append(tr);
    const body = document.querySelector('#sample-body');
    body.replaceChildren();
    for (const row of example.rows) {
      const tr = document.createElement('tr');
      for (const value of row) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      body.append(tr);
    }
    document.querySelector('#result-count').textContent = example.rows.length + ' rows';
  })
);
const headings = document.querySelectorAll('.prose h2[id], .prose h3[id], .tool-entry[id]');
if (headings.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting)
          document
            .querySelectorAll('.toc a')
            .forEach((link) =>
              link.classList.toggle('active', link.hash === '#' + entry.target.id)
            );
    },
    { rootMargin: '-10% 0px -75% 0px' }
  );
  headings.forEach((heading) => observer.observe(heading));
}
