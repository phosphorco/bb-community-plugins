/** Isolate the browser fixture bundler from test-realm module/runtime state. */
import { join } from "node:path";
const outdir = process.argv[2];
if (!outdir) throw new Error("Expected browser artifact directory");
const bundle = await Bun.build({
  entrypoints: [
    join(
      import.meta.dir,
      process.argv[3] === "product"
        ? "browser-app.tsx"
        : "browser-mobile-app.tsx",
    ),
  ],
  outdir,
  target: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
console.log(
  JSON.stringify({
    script: bundle.outputs.find((output) => output.kind === "entry-point")!
      .path,
    css:
      bundle.outputs.find((output) => output.path.endsWith(".css"))?.path ??
      null,
  }),
);
