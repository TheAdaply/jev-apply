// URL → FormPlan. Detects the ATS, fetches the public schema (no browser), and dispatches to the
// per-ATS normalizer. Also the offline path: `--schema <file>` plans from a recorded raw response.
// PLAN §2.2 steps 1–3.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchGreenhouse, normalizeGreenhouse } from "./greenhouse.mjs";
import { fetchAshby, normalizeAshby } from "./ashby.mjs";

// v1 supports the two hosted boards only. An embedded board (iframe#grnhse_iframe on a company
// site) or any other ATS returns null → apply.mjs emits blocked{reason:"unsupported_ats"}.
const GREENHOUSE_RE = /^https?:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i;
const ASHBY_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** detectAts(url) → {ats:"greenhouse",token,id} | {ats:"ashby",org,id} | null */
export function detectAts(url) {
  const href = String(url || "").trim();
  const gh = GREENHOUSE_RE.exec(href);
  if (gh) return { ats: "greenhouse", token: gh[1], id: gh[2] };
  const ashby = ASHBY_RE.exec(href);
  if (ashby) return { ats: "ashby", org: ashby[1], id: ashby[2].toLowerCase() };
  return null;
}

/** Which ATS a recorded raw response came from, by shape. */
export function sniffAts(raw) {
  if (raw?.data?.jobPosting || raw?.jobPosting || raw?.applicationForm) return "ashby";
  if (Array.isArray(raw?.questions) || typeof raw?.absolute_url === "string") return "greenhouse";
  return null;
}

// ─── where the job is (`job.country` / `job.remote`) ──────────────────────────────────────────
//
// Work authorization is two-valued *per country* (PLAN §2.4), so the country a posting is in
// decides which of the user's two answers is the right one. It is read here, at normalize time,
// because this is the last layer that still holds the raw payload, and the raw payload says more
// than the FormPlan's one-line `job.location` does: Cloudflare's `location.name` is the string
// "In-Office" and only `offices[]` names the United States, and Ashby states remoteness in
// `workplaceType`/`isRemote` rather than anywhere in the location text.
//
// Two rules, both from AGENTS.md ("no personal fact is guessed; unknown → ask"):
//   * Nothing recognised → `null`. A neighbouring country is never interpolated, and a region
//     ("EMEA", "APAC", "Americas") is not a country: it stays null and the row becomes an ask.
//   * A posting naming several countries answers for the one it names **first**, in the order the
//     posting itself writes them ("Remote (United States | Canada)" → US) — never in the order
//     this table happens to list them.

/**
 * Country code → the location phrasings that name it, as ATS location strings actually spell
 * them: the country's own names and codes, then the cities whose name alone identifies it.
 * Ambiguous city names are only listed qualified ("cambridge, ma" vs "cambridge, uk"), because a
 * bare "Cambridge" names no country and null is the honest answer.
 */
const COUNTRY_PLACES = {
  US: "united states(?: of america)?|u\\.s\\.a\\.|u\\.s\\.|usa|us|san francisco|sf bay|bay area|silicon valley|palo alto|mountain view|menlo park|sunnyvale|santa clara|cupertino|san jose|san mateo|redwood city|oakland|berkeley|seattle|bellevue|redmond|kirkland|new york|nyc|manhattan|brooklyn|boston|somerville|cambridge, ma|austin|dallas|houston|san antonio|chicago|denver|boulder|los angeles|santa monica|san diego|atlanta|miami|orlando|portland|pittsburgh|philadelphia|phoenix|salt lake city|minneapolis|detroit|ann arbor|nashville|charlotte|raleigh|durham|arlington, va|mclean|reston|princeton|las vegas|honolulu|washington,? d\\.?c\\.?",
  CA: "canada|toronto|vancouver|montreal|montréal|ottawa|waterloo|kitchener|calgary|edmonton|winnipeg|halifax|mississauga|quebec city",
  GB: "united kingdom|u\\.k\\.|uk|gb|england|scotland|wales|northern ireland|london|cambridge, (?:uk|england|united kingdom)|oxford|manchester|edinburgh|glasgow|bristol|leeds|belfast",
  IE: "ireland|dublin|cork, ireland|galway",
  DE: "germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|düsseldorf|dusseldorf|karlsruhe|dresden|leipzig",
  FR: "france|paris|lyon|toulouse|grenoble|bordeaux|nantes|lille|marseille|sophia antipolis",
  NL: "netherlands|holland|amsterdam|utrecht|eindhoven|rotterdam|the hague|den haag|delft|groningen",
  CH: "switzerland|zurich|zürich|geneva|genève|lausanne|basel|bern|lugano",
  AT: "austria|vienna|wien|graz|linz",
  BE: "belgium|brussels|bruxelles|antwerp|ghent|leuven",
  ES: "spain|espa[ñn]a|madrid|barcelona|valencia|seville|malaga|málaga|bilbao",
  PT: "portugal|lisbon|lisboa|porto|braga|coimbra",
  IT: "italy|italia|milan|milano|rome|roma|turin|torino|bologna|florence|firenze|naples",
  SE: "sweden|stockholm|gothenburg|göteborg|malmö|malmo|lund|uppsala",
  NO: "norway|oslo|trondheim|bergen, norway",
  DK: "denmark|copenhagen|k[øo]benhavn|aarhus|odense",
  FI: "finland|helsinki|espoo|tampere|oulu",
  PL: "poland|polska|warsaw|warszawa|krakow|kraków|cracow|wroclaw|wrocław|gdansk|gdańsk|poznan|poznań",
  CZ: "czech(?:ia| republic)?|prague|praha|brno",
  RO: "romania|bucharest|cluj|cluj-napoca|timisoara|timișoara|iasi|iași",
  UA: "ukraine|kyiv|kiev|lviv|kharkiv",
  GR: "greece|athens, greece|thessaloniki",
  TR: "t[üu]rkiye|turkey|istanbul|ankara|izmir",
  IL: "israel|tel aviv|tel-aviv|haifa|jerusalem|herzliya|ramat gan",
  AE: "united arab emirates|uae|dubai|abu dhabi",
  IN: "india|bharat|bengaluru|bangalore|mumbai|bombay|new delhi|delhi|noida|gurgaon|gurugram|hyderabad|chennai|pune|kolkata|ahmedabad|jaipur|trivandrum|thiruvananthapuram",
  SG: "singapore",
  JP: "japan|tokyo|osaka|kyoto|yokohama|fukuoka|nagoya",
  KR: "south korea|korea, republic|seoul|pangyo",
  CN: "china|beijing|shanghai|shenzhen|hangzhou|guangzhou",
  HK: "hong kong",
  TW: "taiwan|taipei|hsinchu",
  AU: "australia|sydney|melbourne|brisbane|perth|canberra|adelaide",
  NZ: "new zealand|auckland|wellington, nz|christchurch",
  BR: "brazil|brasil|s[ãa]o paulo|rio de janeiro|belo horizonte|curitiba|porto alegre|florian[óo]polis|recife",
  MX: "mexico|m[ée]xico|mexico city|ciudad de m[ée]xico|guadalajara|monterrey",
  AR: "argentina|buenos aires|c[óo]rdoba, argentina|rosario",
  CL: "chile|santiago, chile",
  CO: "colombia|bogot[áa]|medell[íi]n",
  ZA: "south africa|johannesburg|cape town|pretoria|durban",
  NG: "nigeria|lagos|abuja",
  KE: "kenya|nairobi",
  EG: "egypt|cairo",
  PH: "philippines|manila|cebu|makati",
  VN: "vietnam|viet nam|hanoi|ho chi minh",
  TH: "thailand|bangkok",
  MY: "malaysia|kuala lumpur|penang",
  ID: "indonesia|jakarta",
};

/** US states by name. `georgia` is deliberately absent: it is also a country (GE). */
const US_STATE_NAMES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia";

// Two-letter state codes are only read where an ATS actually writes them — after a comma
// ("Bellevue, WA") or behind the country ("US-WA-Bellevue"). Bare, they are ordinary English
// words ("OR", "IN", "ME") and half of them collide with country codes ("DE", "IN", "CA").
const US_STATE_CODES =
  "al|ak|az|ar|ca|co|ct|dc|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy";

/** Compiled once: `[regex, country]`, longest-alternative-first inside each country. */
const PLACE_RULES = [
  ...Object.entries(COUNTRY_PLACES).map(([cc, alts]) => [new RegExp(`\\b(?:${alts})\\b`), cc]),
  [new RegExp(`\\b(?:${US_STATE_NAMES})\\b`), "US"],
  [new RegExp(`(?:,\\s*|\\bus[-\\s])(?:${US_STATE_CODES})\\b`), "US"],
  [new RegExp(`\\bca[-\\s](?:on|bc|qc|ab|mb|sk|ns|nb|nl|pe)\\b`), "CA"],
];

const REMOTE_RE = /\b(?:remote|remotely|work from home|wfh|distributed|anywhere|virtual)\b/;

/** Lowercase, dashes unified, NBSP collapsed — punctuation kept, because ", WA" is a state. */
const flatten = (text) =>
  String(text ?? "")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();

/**
 * The country named first in `text`, as an ISO-3166 alpha-2 code, or null when none is.
 * Exported because the work-authorization rules read the *question's* own wording the same way
 * ("are you authorized to work in the United States?" names its jurisdiction even when the
 * posting does not) — one table, one reading, for both (`src/plan/resolve.mjs`).
 */
export function countryFromText(text) {
  const hay = flatten(text);
  if (!hay.trim()) return null;
  let best = null;
  for (const [re, cc] of PLACE_RULES) {
    const hit = re.exec(hay);
    if (hit && (best === null || hit.index < best.index)) best = { index: hit.index, cc };
  }
  return best?.cc ?? null;
}

/** Every location string the raw payload carries, most specific first. */
function placeStrings(raw, job, ats) {
  const posting = raw?.data?.jobPosting ?? raw?.jobPosting ?? raw ?? {};
  const secondary = (posting.secondaryLocations ?? []).map((l) => l?.locationName ?? l?.location?.locationName ?? l?.name ?? l);
  const offices = ats === "greenhouse" ? (raw?.offices ?? []).flatMap((o) => [o?.location, o?.name]) : [];
  return [job?.location, raw?.location?.name, posting.locationName, ...secondary, ...offices].filter(
    (s) => typeof s === "string" && s.trim(),
  );
}

/**
 * `{country, remote}` for one posting. `country` is null whenever the posting names no country —
 * a remote-anywhere listing, a region, an office string nobody has taught this table — and the
 * work-authorization rows then ask instead of answering for a jurisdiction nobody named.
 */
export function placeOf(raw, job = {}, ats) {
  const posting = raw?.data?.jobPosting ?? raw?.jobPosting ?? raw ?? {};
  const text = placeStrings(raw, job, ats).join(" ; ");
  const flagged = posting.isRemote === true || /remote/i.test(String(posting.workplaceType ?? ""));
  return { country: countryFromText(text), remote: flagged || REMOTE_RE.test(flatten(text)) };
}

/** normalize(raw, ats, url) → FormPlan. `ats` may be omitted; the shape is then sniffed. */
export function normalize(raw, ats, url) {
  const kind = ats || sniffAts(raw);
  const plan =
    kind === "greenhouse" ? normalizeGreenhouse(raw, url) : kind === "ashby" ? normalizeAshby(raw, url) : null;
  if (!plan) throw unsupported(`unrecognised schema shape${url ? ` for ${url}` : ""}`);
  plan.job = { ...plan.job, ...placeOf(raw, plan.job, kind) };
  return plan;
}

/** Fetch the raw public schema for an already-detected posting. */
export async function fetchSchema(target) {
  return target.ats === "greenhouse"
    ? fetchGreenhouse({ token: target.token, id: target.id })
    : fetchAshby({ org: target.org, id: target.id });
}

/** loadFormPlan(urlOrFile) → FormPlan. http(s) → fetch + normalize; anything else → recorded JSON. */
export async function loadFormPlan(urlOrFile) {
  const source = String(urlOrFile || "").trim();
  if (/^https?:\/\//i.test(source)) {
    const target = detectAts(source);
    if (!target) throw unsupported(`unsupported_ats: ${source}`);
    return normalize(await fetchSchema(target), target.ats, source);
  }
  const raw = JSON.parse(await readFile(source, "utf8"));
  const ats = sniffAts(raw);
  if (!ats) throw unsupported(`unrecognised schema file: ${source}`);
  return normalize(raw, ats, urlFromFile(raw, ats, source));
}

/**
 * recordSchema(url, dir) → saves the raw response as <ats>-<board>-<short id>.json and returns the
 * path. The board slug is part of the name because an Ashby response carries no organization
 * handle, and `_source_url` is written beside the response so a renamed or hand-written fixture
 * still plans against the posting it was recorded from instead of one rebuilt from its filename.
 */
export async function recordSchema(url, dir = "eval/fixtures") {
  const target = detectAts(url);
  if (!target) throw unsupported(`unsupported_ats: ${url}`);
  const raw = await fetchSchema(target);
  const board = target.ats === "greenhouse" ? target.token : target.org;
  const file = path.resolve(dir, `${target.ats}-${board}-${shortId(target.id)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ _source_url: url, ...raw }, null, 1)}\n`);
  return file;
}

/**
 * Rebuild the posting URL for a recorded file. `_source_url` is the recording's own answer and is
 * used whenever it parses as a supported posting; fixtures recorded before it was written fall back
 * to what the response carries (Greenhouse) or to the board slug in the filename (an Ashby response
 * names no organization, so a renamed file is the one case that can still go wrong).
 */
function urlFromFile(raw, ats, file) {
  const recorded = typeof raw?._source_url === "string" ? raw._source_url.trim() : "";
  if (recorded && detectAts(recorded)) return recorded;
  if (ats === "greenhouse") return raw.absolute_url || "";
  const posting = raw?.data?.jobPosting || raw?.jobPosting || raw;
  const parts = path.basename(file, ".json").split("-");
  const org = parts.slice(1, -1).join("-");
  return org && posting?.id ? `https://jobs.ashbyhq.com/${org}/${posting.id}/application` : "";
}

function shortId(id) {
  return String(id).split("-")[0];
}

function unsupported(message) {
  const err = new Error(message);
  err.reason = "unsupported_ats";
  return err;
}
