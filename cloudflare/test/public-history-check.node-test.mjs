import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("public history scanning catches generic assignments in tests, JSON, YAML, and large text", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "stc-public-history-generic-"));
  try {
    runGit(fixture, ["init", "--initial-branch=main"]);
    const genericValue = ["Q7mV9", "pL2xR", "4tN8c", "K5wH3", "zB6fJ", "1sD0a", "Y9qW2", "nM7vP"].join("");
    const awsKey = ["AKIA", "1234", "5678", "90AB", "CDEF"].join("");
    mkdirSync(path.join(fixture, "test"));
    writeFileSync(path.join(fixture, "test", "fixture.ts"), `SERVICE_TOKEN="${genericValue}"\n`);
    writeFileSync(path.join(fixture, "config.json"), `{"api_key":"${genericValue}"}\n`);
    writeFileSync(path.join(fixture, "config.yml"), `CLOUDFLARE_API_TOKEN: ${genericValue}\n`);
    writeFileSync(path.join(fixture, "large.txt"), `${"x".repeat(2_000_001)}\nAWS_ACCESS_KEY_ID=${awsKey}\n`);
    runGit(fixture, ["add", "."]);
    runGit(fixture, ["commit", "-m", "generic history fixtures"]);

    const result = spawnSync(process.execPath, [scanner], {
      cwd: fixture,
      env: { ...process.env, PUBLIC_REPOSITORY_ROOT: fixture },
      encoding: "utf8",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /category=suspicious secret assignment/);
    assert.match(output, /file=test\/fixture\.ts/);
    assert.match(output, /file=config\.json/);
    assert.match(output, /file=config\.yml/);
    assert.match(output, /category=AWS access key/);
    assert.equal(output.includes(genericValue), false);
    assert.equal(output.includes(awsKey), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("public history scanning does not trust labels, extensions, or filename casing", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "stc-public-history-boundaries-"));
  try {
    runGit(fixture, ["init", "--initial-branch=main"]);
    const providerToken = [
      "provider-",
      "Q7mV9pL2xR4tN8c",
      "K5wH3zB6fJ1sD0a",
      "Y9qW2nM7vP",
    ].join("");
    const slashToken = ["Q7mV9pL2xR4tN8cK5wH3", "/", "zB6fJ1sD0aY9qW2nM7vP"].join("");
    const authToken = ["a8K2mP5vR9xT3wY7", "nQ4sD6fH1jL0zB8c", "V2gM7pN5"].join("");
    const shortPassword = ["Q7mV9pL2xR4tN8cK"].join("");
    const accountId = ["12345678", "90abcdef", "12345678", "90abcdef"].join("");
    const awsKey = ["AKIA", "1234567890ABCDEF"].join("");
    mkdirSync(path.join(fixture, "docs"));
    writeFileSync(path.join(fixture, "docs", "setup.md"), `account_id: "${accountId}"\n`);
    writeFileSync(path.join(fixture, "config.json"), `{"auth":"${authToken}"}\n`);
    writeFileSync(path.join(fixture, "config.yml"), `password: ${shortPassword}\n`);
    writeFileSync(path.join(fixture, "service.ts"), `SERVICE_TOKEN = "${providerToken}"\nSLASH_TOKEN = "${slashToken}"\n`);
    writeFileSync(path.join(fixture, ".ENV"), "safe history\n");
    writeFileSync(path.join(fixture, `${awsKey}.txt`), "safe filename\n");
    runGit(fixture, ["add", "."]);
    runGit(fixture, ["commit", "-m", "boundary fixtures"]);

    const result = spawnSync(process.execPath, [scanner], {
      cwd: fixture,
      env: { ...process.env, PUBLIC_REPOSITORY_ROOT: fixture },
      encoding: "utf8",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /category=forbidden path/);
    assert.match(output, /category=non-placeholder infrastructure ID/);
    assert.match(output, /category=suspicious secret assignment/);
    assert.match(output, /category=suspicious secret assignment commit=[0-9a-f]{40} file=service\.ts line=1/);
    assert.equal(output.includes(providerToken), false);
    assert.equal(output.includes(slashToken), false);
    assert.equal(output.includes(authToken), false);
    assert.equal(output.includes(shortPassword), false);
    assert.equal(output.includes(accountId), false);
    assert.equal(output.includes(awsKey), false);
    assert.match(output, /file=\[redacted\]\.txt/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("public history scanning does not classify explanatory password prose as a secret", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "stc-public-history-prose-"));
  try {
    runGit(fixture, ["init", "--initial-branch=main"]);
    writeFileSync(
      path.join(fixture, "messages.ts"),
      'const password = "Password must contain at least twelve characters.";\n',
    );
    runGit(fixture, ["add", "."]);
    runGit(fixture, ["commit", "-m", "explanatory prose"]);

    const result = spawnSync(process.execPath, [scanner], {
      cwd: fixture,
      env: { ...process.env, PUBLIC_REPOSITORY_ROOT: fixture },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
