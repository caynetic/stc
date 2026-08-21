#!/usr/bin/env node

const API_BASE = "https://api.cloudflare.com/client/v4";
const MODE = process.argv[2] ?? "--check";
const TARGETS = [
  { name: "servethecays.com", minimumTls: "1.2", enableDnssec: true },
  { name: "servethecays.org", minimumTls: "1.2", enableDnssec: false },
];
const TLS_ORDER = new Map([["1.0", 0], ["1.1", 1], ["1.2", 2], ["1.3", 3]]);

if (!new Set(["--check", "--apply"]).has(MODE)) {
  console.error("Usage: node ops/harden-cloudflare-zones.mjs [--check|--apply]");
  process.exit(2);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  console.error("Cloudflare credentials are not loaded.");
  process.exit(1);
}

async function api(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const messages = (payload.errors ?? []).map((error) => error.message).filter(Boolean);
    throw new Error(`Cloudflare request failed (${response.status}): ${messages.join("; ") || "unknown error"}`);
  }
  return payload.result;
}

async function exactZone(name) {
  const query = new URLSearchParams({ name, status: "active", "account.id": accountId, per_page: "50" });
  const zones = await api(`/zones?${query}`);
  const matches = zones.filter((zone) => zone.name === name && zone.status === "active" && !zone.paused);
  if (matches.length !== 1) throw new Error(`Expected one active, unpaused ${name} zone; found ${matches.length}.`);
  return matches[0];
}

async function readSetting(zoneId, setting) {
  return api(`/zones/${zoneId}/settings/${setting}`);
}

async function readDnssec(zoneId) {
  return api(`/zones/${zoneId}/dnssec`);
}

async function dnsInventory(zoneId) {
  const records = await api(`/zones/${zoneId}/dns_records?per_page=100`);
  return records
    .map((record) => ({ type: record.type, name: record.name, proxied: Boolean(record.proxied) }))
    .sort((left, right) => `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`));
}

async function snapshot(target) {
  const zone = await exactZone(target.name);
  const [tls, dnssec, dns] = await Promise.all([
    readSetting(zone.id, "min_tls_version"),
    readDnssec(zone.id),
    dnsInventory(zone.id),
  ]);
  if (!TLS_ORDER.has(tls.value)) throw new Error(`Unexpected minimum TLS value for ${target.name}.`);
  return { target, zone, tls: tls.value, dnssec: dnssec.status, dnssecDetails: dnssec, dns };
}

function publicSnapshot(state) {
  return {
    zone: state.target.name,
    minimum_tls: state.tls,
    dnssec: state.dnssec,
    ...(state.target.enableDnssec && state.dnssec !== "disabled" ? {
      dnssec_ds: {
        key_tag: state.dnssecDetails.key_tag,
        algorithm: state.dnssecDetails.algorithm,
        digest_type: state.dnssecDetails.digest_type,
        digest: state.dnssecDetails.digest,
      },
    } : {}),
    dns_records: state.dns,
  };
}

const before = await Promise.all(TARGETS.map(snapshot));
for (const state of before) console.log(JSON.stringify({ phase: "before", ...publicSnapshot(state) }));

if (MODE === "--apply") {
  for (const state of before) {
    const currentRank = TLS_ORDER.get(state.tls);
    const desiredRank = TLS_ORDER.get(state.target.minimumTls);
    if (currentRank < desiredRank) {
      await api(`/zones/${state.zone.id}/settings/min_tls_version`, {
        method: "PATCH",
        body: JSON.stringify({ value: state.target.minimumTls }),
      });
    }
    if (state.target.enableDnssec && state.dnssec === "disabled") {
      await api(`/zones/${state.zone.id}/dnssec`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      });
    }
  }
}

const after = await Promise.all(TARGETS.map(snapshot));
for (const state of after) console.log(JSON.stringify({ phase: "after", ...publicSnapshot(state) }));

for (let index = 0; index < before.length; index += 1) {
  const prior = before[index];
  const current = after[index];
  if (JSON.stringify(prior.dns) !== JSON.stringify(current.dns)) {
    throw new Error(`DNS records changed unexpectedly for ${current.target.name}.`);
  }
  if (MODE === "--apply" && TLS_ORDER.get(current.tls) < TLS_ORDER.get(current.target.minimumTls)) {
    throw new Error(`Minimum TLS was not raised for ${current.target.name}.`);
  }
}

const com = after.find((state) => state.target.name === "servethecays.com");
if (MODE === "--apply" && com?.dnssec !== "active") {
  console.error("servethecays.com DNSSEC is enabled at Cloudflare but is not active; its registrar DS must be completed.");
  process.exitCode = 3;
}
