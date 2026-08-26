#!/usr/bin/env node
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const htmlIn = join(root, "src", "ui", "index.html");
const htmlOut = join(root, "dist", "ui", "index.html");
const entry = join(root, "src", "ui", "main.ts");
// Deliberately NOT bundled with main.ts — a service worker must be
// servable at its own URL to register, so it's copied through as-is
// rather than inlined into index.html like the rest of the app.
const swIn = join(root, "src", "ui", "sw.js");
const swOut = join(root, "dist", "ui", "sw.js");

// Stamped into the bundle so a running client can report which build it
// is actually on. Without it there's no way to tell a stale cached PWA
// from a genuine bug — the same symptom either way, and mobile has no
// convenient inspector to check.
const buildId = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";

const result = await esbuild.build({
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  write: false,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

if (result.outputFiles.length !== 1) {
  throw new Error(`expected 1 esbuild output, got ${result.outputFiles.length}`);
}
const bundle = result.outputFiles[0].text;

const template = readFileSync(htmlIn, "utf8");
const placeholder = "/*BUNDLE*/";
if (!template.includes(placeholder)) {
  throw new Error(`HTML template at ${htmlIn} is missing the ${placeholder} placeholder`);
}
const html = template.replace(placeholder, () => bundle);

mkdirSync(dirname(htmlOut), { recursive: true });
writeFileSync(htmlOut, html, "utf8");
copyFileSync(swIn, swOut);

const sizeKb = (Buffer.byteLength(bundle, "utf8") / 1024).toFixed(1);
console.log(`wrote ${htmlOut} (bundle ${sizeKb} KB, build ${buildId})`);
console.log(`wrote ${swOut}`);
