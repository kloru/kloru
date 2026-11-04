// Bundles the page editor (BlockNote + React) into static/editor.js and static/editor.css.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
// pnpm keeps a package's peers out of its own folder, so BlockNote's CSS imports of its sibling
// packages are resolved from this package instead.
const siblings = {
  name: "blocknote-siblings",
  setup(b) {
    b.onResolve({ filter: /^@blocknote\/(core|react)\/style\.css$/ }, (args) => {
      // The package's own exports map: "./style.css" → dist/style.css (require.resolve skips CSS-only maps).
      const pkg = args.path.split("/style.css")[0];
      return { path: join(dirname(dirname(require.resolve(pkg))), "dist", "style.css") };
    });
  },
};

await build({
  entryPoints: ["editor/main.tsx"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  outfile: "static/editor.js",
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "dataurl" },
  assetNames: "editor-[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
  plugins: [siblings],
});
