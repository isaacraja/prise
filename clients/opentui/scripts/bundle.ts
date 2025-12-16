/**
 * Bundle the OpenTUI Solid client using the OpenTUI Bun plugin.
 *
 * We use Bun.build() directly because `bun build` does not apply preload-based
 * JSX transforms, and @opentui/solid relies on its plugin/preload.
 */

import solidTransformPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  outdir: "./dist",
  target: "bun",
  minify: true,
  packages: "bundle",
  plugins: [solidTransformPlugin],
});

if (!result.success) {
  console.error("OpenTUI client bundle failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("OpenTUI client bundle created successfully");
