import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve workspace siblings from source so `pnpm --filter @kloru/cli test`
// always runs against the current code and needs no prior build.
const here = path.dirname(fileURLToPath(import.meta.url));
const alias: Record<string, string> = {};
for (const pkg of ["core", "inkbox", "server"]) {
  const dist = path.join(here, "..", pkg, "dist", "index.js");
  const src = path.join(here, "..", pkg, "src", "index.ts");
  if (existsSync(src)) alias[`@kloru/${pkg}`] = src;
  else if (!existsSync(dist)) throw new Error(`@kloru/${pkg} has neither src nor dist`);
}

export default defineConfig({
  resolve: { alias },
  test: { include: ["test/**/*.test.ts"] },
});
