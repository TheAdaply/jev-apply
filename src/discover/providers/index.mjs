// Provider registry: dynamically loads every provider module in this directory
// (greenhouse.mjs, ashby.mjs, lever.mjs, and any added later) so new providers
// register themselves without touching this file.

import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

let cache;

async function loadAll() {
  if (cache) return cache;
  const entries = await readdir(DIR);
  const files = entries.filter((f) => f.endsWith(".mjs") && f !== SELF);
  const mods = await Promise.all(
    files.map((f) => import(pathToFileURL(path.join(DIR, f)).href)),
  );
  cache = mods.filter(
    (m) => typeof m.id === "string" && typeof m.detect === "function" && typeof m.fetch === "function",
  );
  return cache;
}

// → Promise<Array<{ id, detect, fetch }>>
export async function providers() {
  return loadAll();
}

// entry: { provider } (by id) | url string | { url } — → matching provider module or null
export async function providerFor(entry) {
  const mods = await loadAll();
  if (typeof entry === "string") {
    return mods.find((m) => m.detect(entry)) ?? null;
  }
  if (entry && typeof entry === "object") {
    if (typeof entry.provider === "string") {
      return mods.find((m) => m.id === entry.provider) ?? null;
    }
    if (typeof entry.url === "string") {
      return mods.find((m) => m.detect(entry.url)) ?? null;
    }
  }
  return null;
}
