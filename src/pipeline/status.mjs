// The pipeline's state machine (PLAN §2.5, CONTRACTS §pipeline). The only place a status string
// is defined and the only place a status change is judged legal — `store.setStatus` and
// `scripts/pipeline.mjs mark` both go through `assertTransition`, so a typo or an out-of-order
// move ("rejected" → "queued") fails loudly instead of quietly corrupting the record.

/** `status ∈ found|queued|ready|applied|interview|offer|rejected|withdrawn|expired` (CONTRACTS). */
export const STATUSES = [
  "found",
  "queued",
  "ready",
  "applied",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "expired",
];

/** Display/sort order: what the user acts on first comes first. */
const ORDER = new Map(
  ["ready", "queued", "interview", "offer", "applied", "found", "expired", "rejected", "withdrawn"].map(
    (s, i) => [s, i],
  ),
);

/**
 * Legal moves out of each status. An identity move (`found` → `found`) is always allowed and is a
 * no-op that only records a note, so re-queueing or logging a second interview round never throws.
 *
 * - `found` is where `scan.mjs` puts every new posting.
 * - `queued` is the user's shortlist; `apply.mjs --queue N` drains it.
 * - `ready` = the form is filled and waiting for the user's own Submit click (PLAN D8).
 * - `rejected`/`withdrawn` are terminal; `expired` can return to `found` when a board re-lists it.
 */
export const TRANSITIONS = {
  found: ["queued", "ready", "rejected", "withdrawn", "expired"],
  queued: ["found", "ready", "applied", "rejected", "withdrawn", "expired"],
  ready: ["queued", "applied", "rejected", "withdrawn", "expired"],
  applied: ["interview", "offer", "rejected", "withdrawn", "expired"],
  interview: ["offer", "applied", "rejected", "withdrawn", "expired"],
  offer: ["rejected", "withdrawn", "expired"],
  rejected: [],
  withdrawn: [],
  expired: ["found"],
};

/** Statuses that mean "this application is over"; `prune` is allowed to drop them. */
export const TERMINAL = new Set(["rejected", "withdrawn", "expired"]);

/** Statuses that still need something from the user or the runner. */
export const ACTIVE = new Set(["found", "queued", "ready", "applied", "interview", "offer"]);

export function isStatus(status) {
  return typeof status === "string" && STATUSES.includes(status);
}

/** Sort key for lists and the rendered view; unknown statuses sort last. */
export function statusRank(status) {
  return ORDER.get(status) ?? STATUSES.length;
}

/** @returns {boolean} whether `to` is reachable from `from` (identity always is). */
export function canTransition(from, to) {
  if (!isStatus(to)) return false;
  if (from === undefined || from === null) return to === "found";
  if (!isStatus(from)) return false;
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Throws a message naming every legal move, so the CLI can print it verbatim. */
export function assertTransition(from, to) {
  if (!isStatus(to)) {
    throw new Error(`unknown status "${to}" (known: ${STATUSES.join(", ")})`);
  }
  if (canTransition(from, to)) return to;
  const legal = TRANSITIONS[from] ?? [];
  throw new Error(
    legal.length > 0
      ? `illegal transition ${from} → ${to} (legal from ${from}: ${legal.join(", ")})`
      : `illegal transition ${from} → ${to} (${from} is terminal)`,
  );
}
