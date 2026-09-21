// Scan filter chain (PLAN §2.5): "fixed filter order (blacklist → title keywords `word:`/`stem:` →
// seniority → location/remote → age → salary floor → content), … No model calls."
//
// rules shape (all keys optional):
// {
//   blacklist: string[],                              // company name substrings (case-insensitive) to reject
//   title_keywords: { include?: string[], exclude?: string[] },
//   seniority: { exclude?: string[] },
//   location: { any_country_except?: string[] },       // ISO-2 codes; job.remote always passes;
//                                                       // a located job is rejected only if its country
//                                                       // matches one NOT in the allowed set (i.e. is excluded)
//   age_days: number,                                  // reject postings older than this many days
//   salary_floor: number,                              // reject postings whose parsed salary tops out below this
//   content_keywords: { exclude?: string[] },
// }
//
// Keyword syntax for title_keywords/content_keywords/seniority entries: "word:x" = whole-word match,
// "stem:x" = substring match, no prefix defaults to substring. "+" inside one entry joins an AND-group
// ("word:ml+stem:engineer" needs both); multiple entries in an array are OR'd together.

const COUNTRY_NAMES = {
  IN: ["india"],
  US: ["united states", "usa", "u.s.a.", "u.s."],
  GB: ["united kingdom", "uk", "england", "scotland", "wales"],
  DE: ["germany"],
  FR: ["france"],
  ES: ["spain"],
  IT: ["italy"],
  NL: ["netherlands"],
  IE: ["ireland"],
  PT: ["portugal"],
  PL: ["poland"],
  RO: ["romania"],
  CZ: ["czechia", "czech republic"],
  SE: ["sweden"],
  CH: ["switzerland"],
  AT: ["austria"],
  BE: ["belgium"],
  DK: ["denmark"],
  FI: ["finland"],
  NO: ["norway"],
  CA: ["canada"],
  MX: ["mexico"],
  BR: ["brazil"],
  AU: ["australia"],
  SG: ["singapore"],
  JP: ["japan"],
  CN: ["china"],
  PH: ["philippines"],
  VN: ["vietnam"],
  UA: ["ukraine"],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTerm(text, term) {
  if (!text) return false;
  if (term.startsWith("word:")) {
    const w = term.slice(5);
    return new RegExp(`\\b${escapeRegex(w)}\\b`, "i").test(text);
  }
  if (term.startsWith("stem:")) {
    return text.toLowerCase().includes(term.slice(5).toLowerCase());
  }
  return text.toLowerCase().includes(term.toLowerCase());
}

function matchesGroup(text, group) {
  return group
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean)
    .every((term) => matchesTerm(text, term));
}

function matchesAny(text, groups) {
  return Array.isArray(groups) && groups.length > 0 && groups.some((g) => matchesGroup(text, g));
}

function detectCountry(job) {
  const haystack = `${job.location ?? ""} ${job.country ?? ""}`;
  if (!haystack.trim()) return undefined;
  for (const [code, names] of Object.entries(COUNTRY_NAMES)) {
    if (names.some((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, "i").test(haystack))) return code;
  }
  // bare ISO-2 code as its own comma/space-delimited token, e.g. "Cluj-Napoca, CJ, RO"
  const m = haystack.match(/\b([A-Z]{2})\b/);
  return m ? m[1] : undefined;
}

function parseSalaryCeiling(salary) {
  if (salary === undefined || salary === null) return undefined;
  const text = String(salary);
  const nums = [...text.matchAll(/(\d[\d,]*)(k)?/gi)].map(([, digits, k]) => {
    const n = Number(digits.replace(/,/g, ""));
    return k ? n * 1000 : n;
  });
  if (nums.length === 0) return undefined;
  return Math.max(...nums);
}

// Stage functions: (job, rules) → reason string | null (null = pass)

function stageBlacklist(job, rules) {
  const list = rules.blacklist;
  if (!Array.isArray(list) || list.length === 0) return null;
  const company = (job.company ?? "").toLowerCase();
  return list.some((entry) => company.includes(String(entry).toLowerCase())) ? "blacklist" : null;
}

function stageTitleKeywords(job, rules) {
  const cfg = rules.title_keywords;
  if (!cfg) return null;
  const title = job.title ?? "";
  if (matchesAny(title, cfg.exclude)) return "title_keywords";
  if (Array.isArray(cfg.include) && cfg.include.length > 0 && !matchesAny(title, cfg.include)) {
    return "title_keywords";
  }
  return null;
}

function stageSeniority(job, rules) {
  const cfg = rules.seniority;
  if (!cfg) return null;
  const title = job.title ?? "";
  return matchesAny(title, cfg.exclude) ? "seniority" : null;
}

function stageLocation(job, rules) {
  const cfg = rules.location;
  if (!cfg || !Array.isArray(cfg.any_country_except) || cfg.any_country_except.length === 0) return null;
  if (job.remote) return null;
  const excluded = new Set(cfg.any_country_except.map((c) => String(c).toUpperCase()));
  const country = detectCountry(job);
  if (country && excluded.has(country)) return "location";
  return null;
}

function stageAge(job, rules) {
  if (typeof rules.age_days !== "number") return null;
  if (!job.postedAt) return null;
  const posted = new Date(job.postedAt).getTime();
  if (Number.isNaN(posted)) return null;
  const ageDays = (Date.now() - posted) / 86_400_000;
  return ageDays > rules.age_days ? "age" : null;
}

function stageSalaryFloor(job, rules) {
  if (typeof rules.salary_floor !== "number") return null;
  const ceiling = parseSalaryCeiling(job.salary);
  if (ceiling === undefined) return null;
  return ceiling < rules.salary_floor ? "salary_floor" : null;
}

function stageContentKeywords(job, rules) {
  const cfg = rules.content_keywords;
  if (!cfg) return null;
  return matchesAny(job.description ?? "", cfg.exclude) ? "content_keywords" : null;
}

const STAGES = [
  stageBlacklist,
  stageTitleKeywords,
  stageSeniority,
  stageLocation,
  stageAge,
  stageSalaryFloor,
  stageContentKeywords,
];

// applyFilters(jobs, rules) → { kept: Job[], rejected: {[reason]: count} }
export function applyFilters(jobs, rules = {}) {
  const kept = [];
  const rejected = {};
  for (const job of jobs) {
    let reason = null;
    for (const stage of STAGES) {
      reason = stage(job, rules);
      if (reason) break;
    }
    if (reason) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
    } else {
      kept.push(job);
    }
  }
  return { kept, rejected };
}
