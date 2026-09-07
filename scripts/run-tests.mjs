// Test entry point, because `node --test` only learned to expand glob
// patterns in Node 22. On Node 20 the quoted glob is taken literally and
// the run dies with "Could not find test/**/*.test.ts", and passing the
// bare directory is worse: Node 20's discovery patterns do not include
// .ts, so it finds nothing, reports zero tests and exits 0. A green run
// that tested nothing is the one outcome worth engineering against.
//
// So: walk for the files ourselves, refuse to run if there are none, and
// hand Node an explicit list, which every version understands.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = "test";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

let files = [];
try {
  files = walk(ROOT);
} catch (err) {
  console.error(`cannot read ${ROOT}/: ${err.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`no *.test.ts found under ${ROOT}/ — refusing to report success`);
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  ["--test", "--import", "tsx", ...files.sort()],
  { stdio: "inherit" },
);
process.exit(res.status ?? 1);
