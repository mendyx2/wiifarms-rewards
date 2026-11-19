import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SRC_DIR, engineVersion, sourceDigest } from "../tools/digest.ts";
import { runStats } from "../tools/stats.ts";
import { VECTORS_FILE, buildVectors } from "../tools/vectors.ts";

test("the engine still produces exactly the published known-answer vectors", () => {
  // If this fails the engine's behaviour changed: regenerate with `pnpm --filter @wiifarm/game-core vectors`
  // only on purpose, and remember that a changed engine must be certified again.
  assert.deepEqual(buildVectors(), JSON.parse(readFileSync(VECTORS_FILE, "utf8")));
});

test("the engine fingerprint matches its plain-shell definition", () => {
  const shell = execFileSync("sh", ["-c", "for f in $(ls *.ts | LC_ALL=C sort); do printf '%s\\0' \"$f\"; cat \"$f\"; printf '\\0'; done | sha256sum"], { cwd: SRC_DIR }).toString().split(" ")[0];
  assert.equal(sourceDigest(), shell);
  assert.match(engineVersion(), /^game-core@0\.1\.0\+sha256:[0-9a-f]{64}$/);
});

test("statistical uniformity (reduced scale; full report: node tools/stats.ts)", () => {
  // Fixed seeds: the results are the same on every run, so this cannot fail at random.
  for (const r of runStats(0.05)) assert.ok(r.pValue > 0.001, `${r.name}: p = ${r.pValue}`);
});
