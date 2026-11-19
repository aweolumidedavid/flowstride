import fs from 'node:fs';
import path from 'node:path';
import { makeProjectDirectory, practiceFolder, preparePracticeProject, writeIfMissing } from '../../practice/project';
import { installBrowsers } from '../utils/install_browsers';

const folders = ['flows', 'manual_flows', 'reports', 'plugins', 'fixtures', 'helpers'];
const ignored = ['.flowstride', 'flowstride-artifacts', 'reports/latest'];

function prepareIgnores(root: string) {
  const file = path.join(root, '.gitignore');
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.nlink !== 1)) throw new Error('Refusing to edit a linked or special .gitignore.');
  const existing = info ? fs.readFileSync(file, 'utf8') : '';
  const rules = existing.split(/\r?\n/).map(line => line.replace(/^\//, '').replace(/\/$/, ''));
  const missing = ignored.filter(rule => !rules.includes(rule));
  if (missing.length) fs.appendFileSync(file, (info ? '' : 'node_modules\n') +
    '\n# Flowstride execution data\n' + missing.join('\n') + '\n');
}

export async function initAction({ practice = false }: { practice?: boolean } = {}) {
  const root = process.cwd();
  prepareIgnores(root);
  const workspace = preparePracticeProject(root, practice);
  for (const folder of folders) makeProjectDirectory(root, folder);
  writeIfMissing(path.join(root, 'manual_flows', '.gitkeep'), '');
  writeIfMissing(path.join(root, 'fixtures', 'README.md'),
    '# Fixtures\n\nStore audio, image, and data files for your tests here.\n');
  if (workspace && workspace !== root) prepareIgnores(workspace);

  console.log('[Browsers] Checking matching Chromium binaries.');
  try {
    installBrowsers(['chromium']);
    console.log('[Browsers] Chromium is ready.');
  } catch {
    console.warn('[Browsers] Chromium installation did not finish. Retry with npx flowstride install chromium.');
  }

  console.log('[Flowstride] Workspace ready.');
  if (workspace === root) console.log('Run the local practice suite with npx flowstride run.');
  else if (workspace) console.log('Run the local practice suite with cd ' + practiceFolder + ' && npx flowstride run.');
  else console.log('Run your suite with npx flowstride run. Use npx flowstride init --practice to add the practice project.');
}
