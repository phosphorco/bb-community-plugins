import type { NativeSourceConformanceCase } from './native-testing.js';
import type { NativeSourceAdapter } from './native.js';
/** Registers caller-owned independent semantic fixtures against the actual adoption path. */
export function defineNativeSourceConformance(options: {
  readonly test: (name: string, run: () => void | Promise<void>) => unknown;
  readonly resolve: NativeSourceAdapter['resolve'] | ((snapshot: Parameters<NativeSourceAdapter['resolve']>[0]) => Promise<ReturnType<NativeSourceAdapter['resolve']>>);
  readonly cases: readonly NativeSourceConformanceCase[];
}): void {
  if (options.cases.length === 0) throw new Error('Native source conformance requires explicit semantic cases.');
  for (const fixture of options.cases) options.test(`native source: ${fixture.name}`, async () => fixture.verify(await options.resolve(fixture.snapshot)));
}
