import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function installBrowsers(browsers: string[], withDeps = false): void {
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  execFileSync(process.execPath, [cli, 'install', ...(withDeps ? ['--with-deps'] : []), ...browsers], {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
  });
}
