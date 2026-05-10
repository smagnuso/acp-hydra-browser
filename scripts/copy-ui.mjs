#!/usr/bin/env node
import { mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src", "ui");
const out = join(root, "dist", "ui");

function copyTree(srcDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name);
    const d = join(outDir, name);
    const st = statSync(s);
    if (st.isDirectory()) {
      copyTree(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

copyTree(src, out);
