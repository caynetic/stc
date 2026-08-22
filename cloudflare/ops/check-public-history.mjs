#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloudflareRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = process.env.PUBLIC_REPOSITORY_ROOT
  ? path.resolve(process.env.PUBLIC_REPOSITORY_ROOT)
  : path.resolve(cloudflareRoot, "..");
const failures = [];
const MAX_TEXT_BYTES = 2_000_000;

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function report(category, commit, file, line = "-") {
  failures.push({ category, commit, file, line });
}

function lineFor(source, index) {
  return source.slice(0, index).split("\n").length;
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let score = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    score -= probability * Math.log2(probability);
  }
  return score;
}

function isPlaceholder(value) {
  return /(?:replace|placeholder|example|dummy|changeme|test[-_ ]only|local[-_ ]only|fake|all[-_]?zero|00000000)/i.test(value);
}

function isInfrastructurePath(file) {
  return /(?:wrangler|\.dev\.vars|\.env|\.github\/workflows)/i.test(file);
}

function isFixturePath(file) {
  return /(?:^|\/)test\//.test(file) || /(?:^|\/)vitest\.config\.ts$/.test(file) || /(?:^|\/)src\/email-layout\.ts$/.test(file);
}

const credentialPatterns = [
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["GitHub token", /\b(?:gh[oprsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["Stripe secret", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["SendGrid key", /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ["JWT-like credential", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
];

const forbiddenPathPatterns = [
  /(?:^|\/)\.env(?:\..*)?$/,
  /(?:^|\/)\.dev\.vars$/,
  /(?:^|\/)wrangler\.(?:private|ci)\.jsonc$/,
  /(?:^|\/)ops\/private(?:\/|$)/,
  /(?:^|\/)(?:design-previews|private-archive)(?:\/|$)/,
  /\.(?:pem|p12|pfx|key|sqlite|sqlite3|db|log|zip)$/i,
];

const commits = git(["rev-list", "--all", "--full-history", "--reverse"])
  .trim()
  .split(/\s+/)
  .filter(Boolean);
if (!commits.length) {
  process.stderr.write("Public-history check failed: no reachable commits were found.\n");
  process.exit(1);
}

const blobs = new Map();

for (const commit of commits) {
  const tree = git(["ls-tree", "-r", "-z", "--full-tree", commit]);
  const records = tree.toString("utf8").split("\0").filter(Boolean);
  for (const record of records) {
    const match = record.match(/^\d+\s+(\w+)\s+([0-9a-f]{40})\t([\s\S]+)$/);
    if (!match) continue;
    const [, type, blobSha, file] = match;
    if (type !== "blob") continue;

    const exampleException = /(?:^|\/)\.dev\.vars\.example$/.test(file) || /(?:^|\/)\.env\.example$/.test(file);
    if (!exampleException && forbiddenPathPatterns.some((pattern) => pattern.test(file))) {
      report("forbidden path", commit, file);
    }

    let blob = blobs.get(blobSha);
    if (!blob) {
      const buffer = git(["cat-file", "blob", blobSha], "buffer");
      if (buffer.length > MAX_TEXT_BYTES || buffer.includes(0)) {
        blob = { text: null };
      } else {
        blob = { text: buffer.toString("utf8") };
      }
      blobs.set(blobSha, blob);
    }
    if (!blob.text) continue;

    const source = blob.text;
    for (const [category, pattern] of credentialPatterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        report(category, commit, file, lineFor(source, match.index));
      }
    }

    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|$)/.test(line) || /[A-Za-z]:\\Users\\[^\\\s]+\\/.test(line)) {
        report("absolute developer path", commit, file, index + 1);
      }

      if (!isFixturePath(file)) {
        const assignments = line.matchAll(/\b([A-Z][A-Z0-9_-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_-]*)\b\s*[:=]\s*(["'`])([^"'`\r\n]{12,})\2/g);
        for (const assignment of assignments) {
          const candidate = assignment[3];
          if (isPlaceholder(candidate)) continue;
          if (candidate.length >= 24 || entropy(candidate) >= 4.1) {
            report("suspicious secret assignment", commit, file, index + 1);
          }
        }
      }

      if (!isFixturePath(file) && !/\.(?:svg|css|woff2?|json|jsonc|webmanifest)$/i.test(file)) {
        for (const literal of line.matchAll(/(["'`])([A-Za-z0-9_+/=.-]{32,200})\1/g)) {
          const candidate = literal[2];
          if (isPlaceholder(candidate) || /servethecays|cloudflare/i.test(candidate)) continue;
          if (entropy(candidate) >= 4.3) report("high-entropy literal", commit, file, index + 1);
        }
      }

      if (isInfrastructurePath(file)) {
        const uuids = line.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [];
        for (const uuid of uuids) {
          if (!/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(uuid)) {
            report("non-placeholder infrastructure ID", commit, file, index + 1);
          }
        }
        const ids = line.matchAll(/\b(?:account|database|zone|namespace|queue|bucket)[_-]?(?:id|identifier)?\b\s*[:=]\s*["']([0-9a-f]{32})["']/gi);
        for (const id of ids) {
          if (!/^0+$/.test(id[1])) report("non-placeholder infrastructure ID", commit, file, index + 1);
        }
      }
    }
  }
}

const uniqueFailures = [...new Map(failures.map((failure) => [JSON.stringify(failure), failure])).values()];
if (uniqueFailures.length) {
  process.stderr.write("Public-history check failed:\n");
  for (const failure of uniqueFailures) {
    process.stderr.write(`- category=${failure.category} commit=${failure.commit} file=${failure.file} line=${failure.line}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Public-history check passed for ${commits.length} reachable commits and ${blobs.size} unique blobs.\n`);
}
