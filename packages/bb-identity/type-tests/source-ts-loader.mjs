/** Node test-only resolver for source-only TypeScript modules that retain .js import specifiers. */
import { access } from 'node:fs/promises';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/packages/bb-identity/')) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    try {
      await access(candidate);
      return { url: candidate.href, shortCircuit: true };
    } catch { /* The imported JavaScript module is real; use Node's normal resolver. */ }
  }
  return nextResolve(specifier, context);
}
