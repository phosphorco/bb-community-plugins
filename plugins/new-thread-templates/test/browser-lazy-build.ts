/** Public source/slot fixture with real browser imports; not the native compiler artifact. */
import { join, relative } from "node:path";
const outdir = process.argv[2];
if (!outdir) throw new Error("Expected owned output directory");
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "browser-mobile-app.tsx")],
  outdir,
  target: "browser",
  splitting: true,
  naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": '"development"' },
});
if (!built.success) throw new Error(built.logs.join("\n"));
const files = await Promise.all(
  built.outputs.map(async (file) => ({
    path: relative(outdir, file.path),
    kind: file.kind,
    run:
      file.path.endsWith(".js") &&
      (await file.text()).includes("function TemplateRun("),
    management:
      file.path.endsWith(".js") &&
      (await file.text()).includes("function Management("),
  })),
);
console.log(JSON.stringify({ files }));
