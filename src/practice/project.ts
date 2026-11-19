import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FlowstrideConfig } from '../types';
import { discoverFlows, projectPath } from '../utils/projectPaths';
import { ensurePrivateDirectory } from '../security/privateState';
import { loadNativeConfig } from '../ci/config';
import { resolveHelperPath } from '../utils/helperPath';

export const practiceBundle = path.resolve(__dirname, '../../examples/practice-app');
export const practiceFolder = '.flowstride/practice';
const examplesDir = path.join('flows', 'examples');
const starterDir = path.join(examplesDir, 'starter');
const advancedDir = path.join(examplesDir, 'advanced');
const configName = 'flowstride.config.json';
const starterFlows = ['browse-catalog.flow', 'login.flow'];
const handoffFlows = ['admin-creates-user.flow', 'new-user-signs-in.flow'];
const catalogFlow = 'check-catalog-prices.flow';
const legacyHandoffFlows = ['provision-user.flow', 'provision-user-and-login.flow'];

function contains(parent: string, file: string) {
  const relative = path.relative(parent, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function makeProjectDirectory(root: string, relative: string) {
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = projectPath(root, path.join(current, part));
    try { fs.mkdirSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(current).isDirectory()) throw new Error('Expected a regular project directory at ' + current);
  }
  return current;
}

export function writeIfMissing(file: string, value: Buffer | string) {
  try { fs.writeFileSync(file, value, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

function isPracticeWorkspace(root: string): boolean {
  const file = path.join(root, configName);
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) return false;
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.practiceApp === true; }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
}

function hasProject(root: string) {
  return [configName, 'flows'].some(item => !!fs.lstatSync(path.join(root, item), { throwIfNoEntry: false }));
}

export function preparePracticeProject(root: string, requested: boolean): string | undefined {
  let workspace = root;
  if (!isPracticeWorkspace(root) && hasProject(root)) {
    if (!requested) return;
    workspace = ensurePrivateDirectory(root, 'practice');
    if (!isPracticeWorkspace(workspace) && hasProject(workspace)) {
      throw new Error('The .flowstride/practice directory already contains another Flowstride project.');
    }
  }

  const config = { practiceApp: true, testDir: starterDir.split(path.sep).join('/'), recordVideo: true };
  writeIfMissing(path.join(workspace, configName), JSON.stringify(config, null, 2) + '\n');
  if (!isPracticeWorkspace(workspace)) throw new Error('Could not enable the practice app in this project.');
  const helpersDir = loadNativeConfig(workspace, {}).helpersDir ?? path.join(workspace, 'helpers');
  const practiceHelpers = path.join(path.relative(workspace, helpersDir), 'practice');
  for (const [source, destination, files] of [
    ['starter', starterDir, starterFlows],
    ['advanced', advancedDir, [catalogFlow]],
    ['api-and-ui', path.join(examplesDir, 'api-and-ui'), ['approve-user-and-sign-in.flow']],
    ['helpers', practiceHelpers, ['accounts.ts', 'catalog.ts', 'user-fixtures.ts']],
  ] as const) {
    const directory = makeProjectDirectory(workspace, destination);
    for (const name of files) {
      writeIfMissing(path.join(directory, name), fs.readFileSync(path.join(practiceBundle, source, name)));
    }
  }
  const advanced = projectPath(workspace, advancedDir);
  // A previous local scaffold may contain edits to the original examples.
  const handoffFiles = legacyHandoffFlows.some(name => fs.existsSync(path.join(advanced, name)))
    ? legacyHandoffFlows : handoffFlows;
  for (const [index, name] of handoffFiles.entries()) {
    writeIfMissing(path.join(advanced, name), fs.readFileSync(path.join(practiceBundle, 'advanced', handoffFlows[index]!)));
  }
  return workspace;
}

/** The demonstration gets a retry unless the project explicitly configures a retry count. */
export function practiceHandoffSelected(root: string, target: string | undefined): boolean {
  if (!target) return false;
  return [...handoffFlows, ...legacyHandoffFlows].some(name => {
    const file = path.join(root, advancedDir, name);
    return contains(path.resolve(root, target), file) && fs.existsSync(file);
  });
}

/** The practice URL applies only to a suite that selects this scaffold's examples. */
export function practiceTarget(root: string, targetPath: string | undefined, config: FlowstrideConfig) {
  if (!config.practiceApp) return;
  const examples = path.join(root, examplesDir);
  const target = projectPath(root, targetPath || config.testDir!);
  const inExamples = contains(examples, target);
  if (!inExamples && !contains(target, examples)) return;
  projectPath(root, examples);
  if (!fs.existsSync(examples) || !fs.existsSync(target)) return inExamples ? target : undefined;

  const realExamples = fs.realpathSync(examples);
  if (!contains(fs.realpathSync(root), realExamples) || fs.lstatSync(examples).isSymbolicLink()) {
    throw new Error('The practice examples must be in a regular flows/examples directory.');
  }
  const files = discoverFlows(target, root);
  const belongs = (file: string) => contains(examples, file) && contains(realExamples, fs.realpathSync(file));
  if (inExamples || files.some(file => contains(examples, file))) {
    if (files.some(file => !belongs(file))) {
      throw new Error('Run flows/examples separately from tests that use your application URL.');
    }
    return target;
  }
}

/** Only the installed demo and its unchanged helper qualify for masked, local dashboard frames. */
export function practiceHandoffFrames(config: FlowstrideConfig, file: string, source: string) {
  const origin = config.practiceDashboardOrigin;
  if (!origin || config.baseUrl !== origin || config.ci !== false) return;
  const root = config.projectRoot || process.cwd();
  const fileName = path.basename(file);
  if (path.resolve(file) !== path.join(root, advancedDir, fileName)) return;
  if (fileName !== catalogFlow && !handoffFlows.includes(fileName)) return;
  try {
    if (source !== fs.readFileSync(path.join(practiceBundle, 'advanced', fileName), 'utf8')) return;
    if (fileName === 'new-user-signs-in.flow') return { origin };
    const helperName = fileName === catalogFlow ? 'catalog.ts' : 'user-fixtures.ts';
    const specifier = 'practice/' + helperName;
    const helper = path.join(practiceBundle, 'helpers', helperName);
    const projectHelper = resolveHelperPath(root, file, specifier, config.helpersDir);
    if (fs.statSync(projectHelper).size !== fs.statSync(helper).size ||
        !fs.readFileSync(projectHelper).equals(fs.readFileSync(helper))) return;
    return { origin, specifier, helper };
  } catch {
    // Let normal execution diagnose unresolved helpers without enabling frames.
  }
}

export function isBundledPracticeHandoff(config: FlowstrideConfig, jobs: readonly { file: string; sha256: string }[]) {
  if (!config.practiceDashboardOrigin) return false;
  return jobs.every(job => {
    try {
      const source = fs.readFileSync(job.file, 'utf8');
      return createHash('sha256').update(source).digest('hex') === job.sha256 &&
        !!practiceHandoffFrames(config, job.file, source);
    } catch {
      return false;
    }
  });
}
