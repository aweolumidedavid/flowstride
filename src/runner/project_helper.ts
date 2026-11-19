import fs from 'node:fs';
import path from 'node:path';
import { findSourceMap, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import type { Page } from 'playwright';
import type { FlowstrideConfig } from '../types';
import type { DeclarationNode, HelperCallPayload } from '../parser/parser';
import { resolveHelperPath } from '../utils/helperPath';

let typeScriptReady = false;

function enableTypeScript() {
  if (typeScriptReady) return;
  process.setSourceMapsEnabled(true);
  // Support the project's CommonJS modules as well as its native ES modules.
  const { register: registerTypeScript } = require('ts-node') as typeof import('ts-node');
  registerTypeScript({ transpileOnly: true, compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } });
  register('./project_helper_typescript.mjs', pathToFileURL(__filename));
  typeScriptReady = true;
}

function sourceLocation(error: Error, root: string): string | undefined {
  const stack = error.stack;
  const frames = typeof stack === 'string' ? stack.split('\n').slice(1, 25) : [];
  for (const frame of frames) {
    const match = /^\s+at (?:.+? \()?((?:file:\/\/\/|[A-Za-z]:[\\/]|\/).+):(\d+):(\d+)\)?$/.exec(frame);
    if (!match) continue;

    const [, source, row, column] = match;
    let filename: string;
    try {
      filename = source.startsWith('file:') ? fileURLToPath(source) : source;
    } catch {
      continue;
    }
    const relative = path.relative(root, filename);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
        relative.split(path.sep).includes('node_modules')) continue;

    // A CommonJS stack is already mapped by ts-node. ESM loader frames carry
    // file URLs and can still refer to emitted positions in a .ts file.
    let line = Number(row), col = Number(column);
    if (source.startsWith('file:') && filename.endsWith('.ts')) {
      const original = findSourceMap(source)?.findEntry(line - 1, col - 1);
      if (original && 'originalLine' in original) {
        line = original.originalLine + 1;
        col = original.originalColumn + 1;
      }
    }
    return `${relative.split(path.sep).join('/')}:${line}:${col}`;
  }
}

export function resolveProjectHelper(config: FlowstrideConfig, flowFile: string, binding: DeclarationNode) {
  const root = config.projectRoot || process.cwd();
  const specifier = binding.path;
  const file = resolveHelperPath(root, flowFile, specifier, config.helpersDir);
  return { root, file, specifier, name: binding.alias };
}

export async function invokeProjectHelper(
  helper: ReturnType<typeof resolveProjectHelper>,
  getArguments: () => unknown[],
): Promise<unknown> {
  const { root, file, specifier, name } = helper;
  try {
    if (file.endsWith('.ts')) enableTypeScript();
    const namespace = await import(pathToFileURL(file).href);
    // Node's synthetic named exports do not cover all CommonJS export patterns.
    const exports = require.cache[file]?.exports ?? namespace;
    const fn = exports && Object.hasOwn(exports, name) ? exports[name] : undefined;
    if (typeof fn !== 'function') {
      throw new Error(`Helper "${name}" is not a named function export of "${specifier}".`);
    }
    return await fn(...getArguments());
  } catch (error) {
    // Loaders and user functions can reject with values other than Error.
    const cause = error instanceof Error ? error : new Error(
      typeof error === 'string' ? error : inspect(error, { depth: 1, customInspect: false, maxStringLength: 512 }),
    );
    const location = sourceLocation(cause, fs.realpathSync(root)) || specifier;
    throw new Error(`Helper "${name}" failed at ${location}: ${cause.message}`, { cause });
  }
}

export async function callProjectHelper(
  config: FlowstrideConfig,
  flowFile: string,
  binding: DeclarationNode,
  call: HelperCallPayload,
  getPage: () => Page,
  resolved?: ReturnType<typeof resolveProjectHelper>,
): Promise<unknown> {
  const helper = resolved ?? resolveProjectHelper(config, flowFile, binding);
  return invokeProjectHelper(helper, () => call.usePage ? [getPage(), ...call.args] : call.args);
}
