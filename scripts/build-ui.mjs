#!/usr/bin/env node
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const htmlIn = join(root, "src", "ui", "index.html");
const htmlOut = join(root, "dist", "ui", "index.html");
const entry = join(root, "src", "ui", "main.ts");

const result = await esbuild.build({
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

const sizeKb = (Buffer.byteLength(bundle, "utf8") / 1024).toFixed(1);
console.log(`wrote ${htmlOut} (bundle ${sizeKb} KB)`);
