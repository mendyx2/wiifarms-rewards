// The fingerprint of the certified code. A test lab certifies one exact
// fingerprint; any change to any file in src/ produces a different one, so a
// changed engine can never quietly keep an old certificate.
//
// Definition (so anyone can recompute it without this tool): for each .ts file
// directly in src/, in byte order of file name, take the file name, a zero
// byte, the file's exact bytes, and a zero byte; the fingerprint is the SHA-256
// of all of that. Equivalent shell command, run in src/:
//
//   for f in $(ls *.ts | LC_ALL=C sort); do printf '%s\0' "$f"; cat "$f"; printf '\0'; done | sha256sum
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ENGINE_NAME = "game-core";
export const ENGINE_RELEASE = "0.1.0";
export const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

export function sourceDigest(dir: string = SRC_DIR): string {
  const h = createHash("sha256");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1));
  for (const f of files) {
    h.update(f); h.update(Buffer.from([0]));
    h.update(readFileSync(path.join(dir, f))); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}

/** The version string recorded in every cycle's commitment and in every certification. */
export function engineVersion(dir?: string): string {
  return `${ENGINE_NAME}@${ENGINE_RELEASE}+sha256:${sourceDigest(dir)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) console.log(engineVersion());
