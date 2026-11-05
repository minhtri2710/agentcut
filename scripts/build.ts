// Build: (1) dist/*.js bundles for Node >= 20 (npm / npx), (2) optional single-file binary for this platform.
import { $ } from "bun";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const res = await Bun.build({
  entrypoints: ["src/cli.ts", "src/mcp.ts", "src/segment-worker.ts"],
  outdir: "dist", target: "node", format: "esm", splitting: true, minify: true, sourcemap: "linked",
  external: ["@napi-rs/canvas", "@modelcontextprotocol/sdk", "zod"],
});
if (!res.success) { console.error(res.logs); process.exit(1); }
for (const f of ["dist/cli.js", "dist/mcp.js"]) {
  const s = readFileSync(f, "utf8").replace(/^#!.*\n/, "");
  writeFileSync(f, "#!/usr/bin/env node\n" + s);
  chmodSync(f, 0o755);
}
console.log("dist:", res.outputs.map((o) => o.path.split("/").pop()).join(", "));
if (process.argv.includes("--compile")) {
  await $`bun build src/cli.ts --compile --minify --outfile bin/agentcut`;
  console.log("binary: bin/agentcut (MCP: `bin/agentcut mcp`)");
}
