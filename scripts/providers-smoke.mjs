#!/usr/bin/env node
// Smoke check for src/discover/providers/*.mjs and detect.mjs.
//   node scripts/providers-smoke.mjs --company togetherai --provider greenhouse
//   node scripts/providers-smoke.mjs --company baseten --provider ashby
//   node scripts/providers-smoke.mjs --company palantir --provider lever
//   node scripts/providers-smoke.mjs --resolve "Together AI"

import { providers } from "../src/discover/providers/index.mjs";
import { resolveCompany } from "../src/discover/detect.mjs";

const KEY_BY_PROVIDER = { greenhouse: "token", ashby: "org", lever: "site" };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function runResolve(name) {
  const result = await resolveCompany({ name });
  console.log(`resolve "${name}" -> ${JSON.stringify(result)}`);
}

async function runFetch(company, providerId) {
  const mods = await providers();
  const mod = mods.find((m) => m.id === providerId);
  if (!mod) {
    console.error(`unknown provider: ${providerId} (known: ${mods.map((m) => m.id).join(", ")})`);
    process.exitCode = 1;
    return;
  }
  const key = KEY_BY_PROVIDER[providerId];
  const entry = { [key]: company, name: company };
  const jobs = await mod.fetch(entry, {});
  console.log(`${providerId} ${company}: ${jobs.length} jobs`);
  for (const job of jobs.slice(0, 3)) {
    console.log(`  - ${job.title}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (typeof args.resolve === "string") {
    await runResolve(args.resolve);
    return;
  }

  if (typeof args.company === "string" && typeof args.provider === "string") {
    await runFetch(args.company, args.provider);
    return;
  }

  console.error(
    "usage: providers-smoke.mjs --company <slug> --provider <greenhouse|ashby|lever> | --resolve \"<name>\"",
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
});
