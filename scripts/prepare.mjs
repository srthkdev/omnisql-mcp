import { existsSync } from 'node:fs';
if (!process.env.CI && existsSync(new URL('../node_modules/husky', import.meta.url))) {
  const { default: husky } = await import('husky');
  husky();
}
