#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloudflareRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = process.env.PUBLIC_REPOSITORY_ROOT
  ? path.resolve(process.env.PUBLIC_REPOSITORY_ROOT)
  : path.resolve(cloudflareRoot, "..");
const failures = [];
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const GIT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
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
  return /(?:replace|placeholder|example|dummy|changeme|fake|all[-_]?zero|00000000|account-wide|must-not-send|(?:^|[-_])(?:test|fixture|development|preview|local|newsletter|unsubscribe|customize|provider|boundary|member|private|forged|visitor)(?:[-_]|$))/i.test(value);
}

function isStaticPathLiteral(value) {
  return /^(?:\/?(?:static|assets)\/|(?:https?:)?\/\/)/i.test(value)
    || /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(value)
    || /\.(?:avif|gif|jpe?g|png|svg|webp|woff2?|ttf|eot)$/i.test(value);
}

const secretKeyPattern = /(?:^|[_-])(?:secret|token|password|passwd|access[_-]?key|api[_-]?key|private[_-]?key)(?:$|[_-])/i;

function isStructuredConfigPath(file) {
  return /(?:^|\/)\.env(?:\.[^/]*)?$/i.test(file)
    || /\.(?:ini|json|jsonc|properties|toml|ya?ml)$/i.test(file);
}

function isInfrastructurePath(file) {
  return /(?:wrangler|\.dev\.vars|\.env|\.github\/workflows)/i.test(file);
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

function addFinding(findings, category, line) {
  findings.push({ category, line });
}

function scanContent(source) {
  const findings = [];
  for (const [category, pattern] of credentialPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      addFinding(findings, category, lineFor(source, match.index));
    }
  }

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|$)/.test(line) || /[A-Za-z]:\\Users\\[^\\\s]+\\/.test(line)) {
      addFinding(findings, "absolute developer path", index + 1);
    }
  }
  return findings;
}

function scanAssignments(source, structuredConfig) {
  const findings = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const assignments = line.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*)\b\s*["']?\s*[:=]\s*(?:(['"`])([^'"`\r\n]{12,})\2|([^\s,#}\]]{12,}))/g);
    for (const assignment of assignments) {
      const key = assignment[1];
      const quoted = Boolean(assignment[2]);
      const keySignal = secretKeyPattern.test(key)
        || /(?:secret|token|password|passwd|accessKey|apiKey|privateKey)$/i.test(key);
      const configKey = /^[A-Z][A-Z0-9_-]*$/.test(key) && keySignal;
      const sourceKey = quoted && keySignal && (
        /[A-Z]/.test(key.slice(1))
        || /[_-]/.test(key)
        || /^(?:secret|token|password|passwd)$/i.test(key)
      );
      if (!configKey && !(structuredConfig && keySignal) && !sourceKey) continue;
      if (!quoted && !structuredConfig) continue;
      const candidate = assignment[3] ?? assignment[4] ?? "";
      if (isPlaceholder(candidate) || isStaticPathLiteral(candidate)) continue;
      if (candidate.length >= 24 || entropy(candidate) >= 4.1) {
        addFinding(findings, "suspicious secret assignment", index + 1);
      }
    }
  }
  return findings;
}

function scanHighEntropyLiterals(source) {
  const findings = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const literal of line.matchAll(/(["'`])([A-Za-z0-9_+/=.-]{32,200})\1/g)) {
      const candidate = literal[2];
      if (isPlaceholder(candidate) || isStaticPathLiteral(candidate) || /servethecays|cloudflare/i.test(candidate)) continue;
      if (entropy(candidate) >= 4.3) addFinding(findings, "high-entropy literal", index + 1);
    }
  }
  return findings;
}

function scanInfrastructure(source) {
  const findings = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const uuids = line.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [];
    for (const uuid of uuids) {
      if (!/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(uuid)) {
        addFinding(findings, "non-placeholder infrastructure ID", index + 1);
      }
    }
    const ids = line.matchAll(/\b(?:account|database|zone|namespace|queue|bucket)[_-]?(?:id|identifier)?\b\s*[:=]\s*["']([0-9a-f]{32})["']/gi);
    for (const id of ids) {
      if (!/^0+$/.test(id[1])) addFinding(findings, "non-placeholder infrastructure ID", index + 1);
    }
  }
  return findings;
}

const blobs = new Map();

function readBlob(blobSha) {
  if (blobs.has(blobSha)) return blobs.get(blobSha);
  const buffer = git(["cat-file", "blob", blobSha], "buffer");
  let blob;
  if (buffer.includes(0)) {
    blob = { text: null, binary: true, oversized: false, contentFindings: [], highEntropyFindings: [] };
  } else if (buffer.length > MAX_TEXT_BYTES) {
    blob = { text: null, binary: false, oversized: true, contentFindings: [], highEntropyFindings: [] };
  } else {
    const text = buffer.toString("utf8");
    blob = {
      text,
      binary: false,
      oversized: false,
      contentFindings: scanContent(text),
      assignmentFindings: {
        source: scanAssignments(text, false),
        config: scanAssignments(text, true),
      },
      highEntropyFindings: scanHighEntropyLiterals(text),
      infrastructureFindings: null,
    };
  }
  blobs.set(blobSha, blob);
  return blob;
}

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

    const blob = readBlob(blobSha);
    if (blob.binary) continue;
    if (blob.oversized) {
      report("oversized text blob", commit, file);
      continue;
    }

    for (const finding of blob.contentFindings) report(finding.category, commit, file, finding.line);
    const assignmentFindings = isStructuredConfigPath(file)
      ? blob.assignmentFindings.config
      : blob.assignmentFindings.source;
    for (const finding of assignmentFindings) report(finding.category, commit, file, finding.line);
    if (!/(?:svg|css|woff2?|json|jsonc|webmanifest)$/i.test(file)) {
      for (const finding of blob.highEntropyFindings) report(finding.category, commit, file, finding.line);
    }
    if (isInfrastructurePath(file)) {
      blob.infrastructureFindings ??= scanInfrastructure(blob.text);
      for (const finding of blob.infrastructureFindings) report(finding.category, commit, file, finding.line);
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
