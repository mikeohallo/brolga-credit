import { registerHooks, stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Execute the supplied .ts modules without Next, npm installs, source edits or a server.
export function installSourceLoader(sourceRoot) {
  const root = path.resolve(sourceRoot);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let base;
      if (specifier.startsWith('@/')) base = path.join(root, 'src', specifier.slice(2));
      else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        base = fileURLToPath(new URL(specifier, context.parentURL));
      }
      if (base && (base === root || base.startsWith(root + path.sep))) {
        for (const candidate of [base, base + '.ts', path.join(base, 'index.ts')]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && url.endsWith('.ts')) {
        const filename = fileURLToPath(url);
        if (filename.startsWith(root + path.sep)) {
          return { format: 'module', source: stripTypeScriptTypes(fs.readFileSync(filename, 'utf8'), { mode: 'strip', sourceUrl: url }), shortCircuit: true };
        }
      }
      return nextLoad(url, context);
    },
  });
}

export function prohibitNetwork() {
  let blockedCalls = 0;
  globalThis.fetch = async () => {
    blockedCalls += 1;
    throw new Error('REVIEW_NETWORK_DISABLED');
  };
  return () => blockedCalls;
}
