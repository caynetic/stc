import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cloudflareRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(cloudflareRoot, "ops", "check-public-history.mjs");

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=History Test", "-c", "user.email=history-test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("public history scanning catches credentials and forbidden files from older commits without redaction leaks", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "stc-public-history-"));
  try {
    runGit(fixture, ["init", "--initial-branch=main"]);
    const secret = ["AKIA", "1234567890ABCDEF"].join("");
    writeFileSync(path.join(fixture, ".env"), `AWS_ACCESS_KEY_ID=${secret}\n`);
    runGit(fixture, ["add", ".env"]);
    runGit(fixture, ["commit", "-m", "fixture secret"]);
    rmSync(path.join(fixture, ".env"));
    writeFileSync(path.join(fixture, "README.md"), "safe history\n");
    runGit(fixture, ["add", "-A"]);
    runGit(fixture, ["commit", "-m", "remove fixture secret"]);

    const result = spawnSync(process.execPath, [scanner], {
      cwd: fixture,
      env: { ...process.env, PUBLIC_REPOSITORY_ROOT: fixture },
      encoding: "utf8",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /category=forbidden path/);
    assert.match(output, /category=AWS access key/);
    assert.match(output, /file=\.env/);
    assert.equal(output.includes(secret), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
