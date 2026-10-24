// Hark lane offline test loader: map a relative `./x.js` import to `./x.ts`
// when only the TypeScript source exists (repo uses NodeNext `.js` specifiers).
// Zero dependencies; used only by scripts/hark/test-hark-offline.mjs.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && context.parentURL) {
    const js = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(js))) {
      const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}
