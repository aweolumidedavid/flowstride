import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { create, createEsmHooks, TSError } from 'ts-node';
import ts from 'typescript';

// The verified practice helpers can live inside an installed npm package.
const bundledHelpers = new Set(['catalog.ts', 'user-fixtures.ts'].map(file =>
  new URL('../../examples/practice-app/helpers/' + file, import.meta.url).href,
));

const compiler = create({
  transpileOnly: true,
  compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
});

const hooks = createEsmHooks(compiler);
if (!('load' in hooks)) throw new Error('This Node.js version does not support the TypeScript helper loader.');
export const { resolve } = hooks;

export const load: typeof hooks.load = async (...args) => {
  const [url] = args;
  if (bundledHelpers.has(url)) {
    const fileName = fileURLToPath(url);
    const source = await readFile(fileName, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, inlineSourceMap: true },
    });
    return { format: 'module', shortCircuit: true, source: outputText };
  }
  try {
    return await hooks.load(...args);
  } catch (error) {
    // Pass the compiler diagnostic through the loader's worker boundary.
    if (error instanceof TSError) throw new Error(error.diagnosticText);
    throw error;
  }
};
