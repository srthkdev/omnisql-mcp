import { copyFileSync } from 'node:fs';
copyFileSync(
  new URL('./install.sh', import.meta.url),
  new URL('../docs-site/static/install.sh', import.meta.url)
);
