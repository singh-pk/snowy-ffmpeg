// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Applies .github/settings.yml (repository settings, security features, topics, labels) and
// .github/rulesets/*.json (in the format GitHub exports) to the GitHub repository of the
// current checkout. Creates and updates; never deletes a label or ruleset that the files
// don't mention.
// Needs the GitHub CLI signed in as a repository admin.
// Usage: bun scripts/settings.ts

import { $, Glob } from "bun";
import config from "../.github/settings.yml";

interface Settings {
  repository: Record<string, unknown>;
  security: Record<string, boolean>;
  topics: string[];
  labels: { name: string; color: string; description: string }[];
}

interface Ruleset {
  id: number;
  name: string;
}

const root = new URL("../", import.meta.url).pathname;
const settings: Settings = config;
const view = await $`gh repo view --json nameWithOwner -q .nameWithOwner`.text();
const repo = view.trim();
const failures: string[] = [];

// Sends `body` as JSON to a REST endpoint, recording a failure instead of stopping.
async function api(method: string, path: string, body: unknown) {
  const input = new Response(JSON.stringify(body));
  const res = await $`gh api -X ${method} ${path} --input - < ${input}`.nothrow().quiet();
  if (res.exitCode === 0) return;
  failures.push(`${method} ${path}: ${res.stderr.toString().trim()}`);
}

await api("PATCH", `repos/${repo}`, settings.repository);
await api("PUT", `repos/${repo}/topics`, { names: settings.topics });
console.log(`settings and ${settings.topics.length} topics`);

// Each feature is its own endpoint: PUT turns it on, DELETE turns it off.
for (const [feature, on] of Object.entries(settings.security)) {
  await api(on ? "PUT" : "DELETE", `repos/${repo}/${feature.replaceAll("_", "-")}`, {});
}

console.log(`${Object.keys(settings.security).length} security features`);

for (const { name, color, description } of settings.labels) {
  const res =
    await $`gh label create ${name} -R ${repo} --color ${color} --description ${description} --force`
      .nothrow()
      .quiet();
  if (res.exitCode !== 0) failures.push(`label ${name}: ${res.stderr.toString().trim()}`);
}

console.log(`${settings.labels.length} labels`);

const listing = await $`gh api repos/${repo}/rulesets`.nothrow().quiet();
const existing: Ruleset[] = listing.exitCode === 0 ? listing.json() : [];

for await (const file of new Glob(".github/rulesets/*.json").scan(root)) {
  const ruleset: Ruleset = await Bun.file(root + file).json();
  const match = existing.find((r) => r.name === ruleset.name);
  if (match) await api("PUT", `repos/${repo}/rulesets/${match.id}`, ruleset);
  else await api("POST", `repos/${repo}/rulesets`, ruleset);
  console.log(`ruleset ${ruleset.name}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
