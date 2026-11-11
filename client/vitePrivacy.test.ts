// @vitest-environment node
import path from 'node:path';
import { isFileServingAllowed, resolveConfig } from 'vite';
import { expect, it } from 'vitest';

it('allows the synthetic review and denies private files requested directly from Vite', async () => {
  const root = import.meta.dirname;
  const config = await resolveConfig({ root }, 'serve');
  const canServe = (file: string) => isFileServingAllowed(config, '/@fs' + path.resolve(root, file));

  expect(canServe('src/dev/fixtures/reconciliation.synthetic.json')).toBe(true);
  expect(canServe('src/dev/fixtures/example.local.json')).toBe(false);
  expect(canServe('../backups/reconciliation-private/scenario.json')).toBe(false);
  expect(canServe('.env')).toBe(false);
});
