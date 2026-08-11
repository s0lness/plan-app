import { build } from "esbuild";

const racine = (import.meta as ImportMeta & { dirname: string }).dirname
  .replace(/[\\/]live-worker$/, "");
const options = {
  // Logical value requested: `live-worker/worker.ts`. The absolute path stops esbuild from
  // climbing above the working copy to look for a package of the same name on Windows.
  entryPoints: [racine + "\\live-worker\\worker.ts"],
  absWorkingDir: racine,
  bundle: true,
  format: "esm" as const,
  platform: "neutral" as const,
  target: "es2022",
  minify: false,
};

// The Workers API receives already-built JavaScript: we inspect the bundle BEFORE writing it,
// because losing either of these two exports would break either the Durable Object or the Worker.
const essai = await build({ ...options, write: false });
const texte = essai.outputFiles[0]?.text || "";
if (!/export\s*\{[^}]*PlanRoom/s.test(texte) || !/export\s*\{[^}]*worker_default\s+as\s+default/s.test(texte)) {
  throw new Error("bundle Worker incomplet : PlanRoom ou export default absent");
}

await build({ ...options, outfile: racine + "\\live-worker\\dist\\worker.mjs" });
console.log("Worker construit : live-worker/dist/worker.mjs");
