// Extracts every <script> block from each top-level PHC Tools .html file and
// checks it parses as valid JavaScript. This is CI-only tooling — it never
// touches the product itself, which stays plain static HTML with no build
// step, per phc-tools/CLAUDE.md's "single-file HTML, no framework" rule.
//
// Catches the class of bug this repo has hit by hand this session (found via
// an ad-hoc `osascript -l JavaScript` trick) automatically on every push.

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = globSync("*.html", { cwd: repoRoot }).sort();

if (files.length === 0) {
  console.error("No .html files found at repo root — check the glob/cwd.");
  process.exit(1);
}

let failures = 0;

for (const file of files) {
  const full = path.join(repoRoot, file);
  const html = readFileSync(full, "utf-8");
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((s) => s.trim().length > 0);

  if (blocks.length === 0) {
    console.log(`  (no inline <script> content) ${file}`);
    continue;
  }

  // Check the largest block — that's the real app logic. Small blocks (e.g.
  // the password-gate IIFE) are checked too, but the main block matters most.
  const sorted = [...blocks].sort((a, b) => b.length - a.length);

  let fileOk = true;
  for (let i = 0; i < sorted.length; i++) {
    // .cjs, not .mjs: these tools ship as plain non-module <script> tags,
    // which run in sloppy mode (duplicate top-level `function` declarations
    // are legal — last one wins, a real pattern PHC_Sales_Desk.html uses
    // deliberately to monkey-patch doSave()). .mjs forces strict-module
    // semantics that reject that legally, producing false positives.
    const tmp = path.join(repoRoot, `.__syntax_check_tmp_${process.pid}_${i}.cjs`);
    try {
      writeFileSync(tmp, sorted[i]);
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (err) {
      fileOk = false;
      failures++;
      console.error(`\n✗ ${file} — script block ${i + 1}/${sorted.length} failed to parse:`);
      console.error(err.stderr?.toString() || err.message);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  }
  if (fileOk) console.log(`  ok  ${file}  (${blocks.length} script block${blocks.length > 1 ? "s" : ""})`);
}

console.log(`\n${files.length} files checked, ${failures} syntax failure(s).`);
process.exit(failures > 0 ? 1 : 0);
