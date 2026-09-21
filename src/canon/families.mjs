// Job-family taxonomy for the canonical question bank (docs/PLAN.md §2.7).
//
// `classifyTitle(title)` is a deterministic, offline title classifier: no model call, no network,
// same answer every run. It exists so `scripts/canon-scan.mjs` can bucket real postings into the
// 20 families the question bank is layered by, and so `apply.mjs` can pick the family screening
// layer for a posting without asking Jev a question it cannot answer better than a keyword list.
//
// Matching rules (kept intentionally dumb and inspectable):
//   - the title is normalised to " token token " (lowercase, punctuation → space),
//   - a keyword matches when it occurs as a whole-token phrase,
//   - a family is disqualified when any of its `exclude` phrases matches,
//   - the winner is the family with the most specific match: more tokens first, then longer
//     string, then declaration order in FAMILIES (earlier = more specific family).
// No match → null. A null is not a failure: most non-engineering postings have no family.

/** @typedef {{title_keywords: string[], exclude: string[]}} FamilySpec */

/** @type {Record<string, FamilySpec>} */
export const FAMILIES = {
  // --- specific AI/research families first: their phrases beat generic engineering ones ---
  ai_product_fde: {
    title_keywords: [
      "forward deployed", "forward deployed engineer", "forward deployed software engineer",
      "fde", "applied ai", "ai applied", "applied ai engineer", "applied engineer",
      "ai product engineer", "product engineer ai", "ai solutions engineer",
      "deployment engineer", "deployment strategist", "ai engineer customer",
      "member of technical staff applied", "applied deployment",
    ],
    exclude: [
      "intern", "recruiter", "sales representative", "account executive",
      "program manager", "project manager",
    ],
  },
  research_engineer: {
    title_keywords: [
      "research engineer", "engineer research", "research engineering",
      "research infrastructure engineer", "research software engineer",
      "research scientist engineer", "ai research engineer", "ml research engineer",
      "machine learning research engineer", "research resident",
    ],
    exclude: [
      "research operations", "user research", "ux research", "market research",
      "program manager", "project manager", "recruiter",
    ],
  },
  applied_scientist: {
    title_keywords: [
      "applied scientist", "scientist applied", "applied research scientist",
      "applied science", "applied researcher", "applied ml scientist",
    ],
    exclude: ["program manager", "project manager", "recruiter"],
  },
  ml_scientist: {
    title_keywords: [
      "research scientist", "scientist research", "researcher",
      "machine learning scientist", "scientist machine learning", "ml scientist", "scientist ml",
      "ai scientist", "scientist ai", "deep learning scientist", "llm scientist",
      "nlp scientist", "scientist nlp", "computer vision scientist", "scientist computer vision",
      "speech scientist", "robotics scientist", "scientist robotics",
      "member of technical staff research", "research lead", "research manager",
      "post doc", "postdoctoral",
    ],
    exclude: [
      "user researcher", "user research", "ux researcher", "ux research", "market researcher",
      "research operations", "research program manager", "clinical research", "research engineer",
      "data scientist", "applied scientist", "research recruiter", "quantitative researcher",
      "program manager", "project manager", "research associate clinical",
    ],
  },
  ml_engineer: {
    title_keywords: [
      "machine learning engineer", "engineer machine learning", "ml engineer", "engineer ml",
      "mle", "ai engineer", "engineer ai", "deep learning engineer", "llm engineer",
      "engineer llm", "nlp engineer", "engineer nlp", "computer vision engineer",
      "engineer computer vision", "speech engineer", "engineer speech",
      "ml infrastructure", "machine learning infrastructure", "ml platform",
      "machine learning platform", "ml systems", "machine learning systems", "ml ops", "mlops",
      "inference", "inference engineer", "engineer inference", "inference infrastructure",
      "training infrastructure", "model serving", "model deployment", "foundation model",
      "recommendation", "recommender", "ranking", "search relevance", "relevance engineer",
      "perception engineer", "engineer perception", "autonomy engineer", "engineer autonomy",
      "robotics engineer", "engineer robotics", "robotics software engineer", "roboticist",
      "post training", "reinforcement learning engineer", "fine tuning engineer",
      "agents engineer", "engineer agents", "ai infrastructure", "voice model", "speech model",
    ],
    exclude: [
      "intern", "recruiter", "sales", "account executive", "marketing",
      "research scientist", "applied scientist", "data scientist", "product manager",
      "technical writer", "developer advocate", "solutions engineer", "solutions architect",
      "support engineer", "designer", "program manager", "project manager",
    ],
  },
  gpu_performance: {
    title_keywords: [
      "gpu", "cuda", "gpu kernel", "kernel engineer", "gpu performance", "performance engineer",
      "engineer performance", "performance optimization", "performance architect",
      "kernel development", "kernel optimization", "acceleration kernel", "accelerator kernel",
      "performance modeling", "performance modelling", "model performance",
      "performance software engineer", "software performance",
      "hpc", "high performance computing", "triton", "tensorrt", "rocm",
      "inference optimization", "model optimization", "quantization",
      "accelerator software", "ai accelerator", "parallel computing", "numerical computing",
    ],
    exclude: [
      "performance marketing", "marketing", "sales", "performance management",
      "people performance", "high performance culture", "recruiter", "hardware engineer",
      "program manager", "project manager", "technician", "manufacturing",
    ],
  },
  systems_embedded_compilers: {
    title_keywords: [
      "compiler", "compilers", "toolchain", "llvm", "mlir", "xla", "jit",
      "embedded", "firmware", "device driver", "driver engineer", "engineer driver",
      "linux kernel", "operating system", "systems software", "software systems engineer",
      "low level", "bare metal", "rtos", "c++ systems", "systems engineer",
      "runtime engineer", "engineer runtime", "virtualization", "hypervisor",
    ],
    exclude: [
      "systems engineer it", "business systems", "information systems", "recruiter",
      "sales", "ml systems", "machine learning systems", "distributed systems",
      "design verification", "physical design", "analog", "rtl", "asic",
      "program manager", "project manager", "technician", "systems analyst",
    ],
  },
  security: {
    title_keywords: [
      "security", "security engineer", "application security", "appsec", "infosec",
      "product security", "offensive security", "detection and response", "incident response",
      "threat", "vulnerability", "cryptography", "cryptographic", "privacy engineer",
      "identity and access", "iam", "compliance engineer", "grc",
      "penetration tester", "red team", "blue team", "security architect",
    ],
    exclude: [
      "security guard", "physical security officer", "security officer", "sales", "recruiter",
      "security sales", "account executive", "marketing", "safety driver",
      "program manager", "project manager", "technician", "security analyst i",
    ],
  },
  infra_sre: {
    title_keywords: [
      "infrastructure engineer", "engineer infrastructure", "infrastructure",
      "site reliability", "sre", "devops", "dev ops", "platform engineer",
      "engineer platform", "cloud engineer", "cloud infrastructure", "kubernetes",
      "observability", "production engineer", "reliability engineer", "network engineer",
      "networking engineer", "data center", "datacenter", "capacity engineer",
      "release engineer", "build engineer", "developer productivity", "developer infrastructure",
      "compute platform", "cluster engineer", "storage engineer", "systems administrator",
      "deployment infrastructure", "fleet engineer",
    ],
    exclude: [
      "ml infrastructure", "machine learning infrastructure", "ai infrastructure",
      "data infrastructure", "research infrastructure", "training infrastructure",
      "inference infrastructure", "security", "sales", "recruiter", "marketing",
      "data platform", "designer", "product manager", "technical writer",
      "program manager", "project manager", "facilities", "technician", "electrician",
      "construction", "logistics", "operations manager",
    ],
  },
  data_engineer: {
    title_keywords: [
      "data engineer", "engineer data", "data engineering", "data platform",
      "data infrastructure", "data pipeline", "etl", "big data", "streaming data",
      "data warehouse", "lakehouse", "spark engineer", "data ops", "dataops",
    ],
    exclude: [
      "data scientist", "data analyst", "analytics engineer", "data entry", "recruiter",
      "sales", "marketing", "data annotation", "data labeling", "data operations associate",
      "program manager", "project manager",
    ],
  },
  analytics_engineer: {
    title_keywords: [
      "analytics engineer", "analytics engineering", "business intelligence", "bi engineer",
      "bi analyst", "bi developer", "data analyst", "analyst data", "analytics",
      "insights analyst", "reporting analyst", "dashboard", "looker", "dbt",
      "product analyst", "business analyst",
    ],
    exclude: [
      "financial analyst", "finance analyst", "fp a", "compensation analyst", "payroll",
      "security analyst", "recruiter", "risk analyst", "credit analyst", "sales",
      "marketing analyst", "data scientist", "gtm analyst", "compliance analyst",
      "intelligence analyst", "threat intelligence", "marketing", "program manager",
      "project manager", "systems analyst", "operations analyst", "underwriting",
      "quality analyst", "support analyst",
    ],
  },
  data_scientist: {
    title_keywords: [
      "data scientist", "scientist data", "data science", "decision scientist",
      "product data scientist", "experimentation scientist", "quantitative scientist",
      "causal inference", "experimentation platform",
    ],
    exclude: [
      "data engineer", "applied scientist", "research scientist", "recruiter", "sales",
      "program manager", "project manager",
    ],
  },
  mobile: {
    title_keywords: [
      "mobile", "mobile engineer", "ios", "ios engineer", "android", "android engineer",
      "react native", "flutter", "swift", "kotlin", "mobile platform", "mobile app",
      "mobile software engineer",
    ],
    exclude: [
      "mobile marketing", "recruiter", "sales", "mobility operations",
      "program manager", "project manager", "mobile ordering",
    ],
  },
  fullstack: {
    title_keywords: [
      "full stack", "fullstack", "full stack engineer", "full stack software engineer",
      "product engineer", "engineer product", "generalist engineer", "software generalist",
    ],
    exclude: [
      "ai product engineer", "product engineering manager", "recruiter", "sales", "designer",
      "product manager", "product marketing", "program manager", "project manager",
    ],
  },
  frontend: {
    title_keywords: [
      "frontend", "front end", "frontend engineer", "front end engineer",
      "web engineer", "web developer", "ui engineer", "user interface engineer",
      "javascript engineer", "typescript engineer", "react engineer", "web platform",
      "web experience", "growth engineer",
    ],
    exclude: [
      "recruiter", "sales", "marketing web", "webmaster", "web designer",
      "program manager", "project manager", "hardware", "mechanical", "electrical",
    ],
  },
  backend: {
    title_keywords: [
      "backend", "back end", "backend engineer", "back end engineer",
      "server side", "api engineer", "engineer api", "distributed systems",
      "distributed systems engineer", "core engineer", "services engineer",
      "payments engineer", "backend software engineer", "software engineer backend",
      "golang engineer", "java engineer", "ruby engineer", "python engineer",
      "scala engineer", "elixir engineer",
    ],
    exclude: [
      "recruiter", "sales", "marketing", "designer", "product manager",
      "program manager", "project manager",
    ],
  },
  product_manager: {
    title_keywords: [
      "product manager", "manager product", "product management", "group product manager",
      "principal product manager", "director of product", "head of product",
      "vp of product", "product owner", "product lead", "technical product manager",
      "ai product manager", "platform product manager", "product operations",
    ],
    exclude: [
      "product marketing", "product designer", "product design", "product engineer",
      "product support", "product specialist", "recruiter", "product counsel",
      "product analyst", "program manager",
    ],
  },
  product_designer: {
    title_keywords: [
      "product designer", "designer product", "ux designer", "ui designer", "ux ui",
      "ui ux", "user experience designer", "experience designer", "interaction designer",
      "design manager", "head of design", "design lead", "director of design",
      "ux researcher", "user researcher", "design systems", "visual designer",
      "brand designer", "content designer", "ux writer", "product design",
    ],
    exclude: [
      "design verification", "recruiter", "sales", "design engineer", "design technologist",
      "program manager", "project manager", "hardware", "mechanical", "industrial designer",
    ],
  },
  solutions_engineer: {
    title_keywords: [
      "solutions engineer", "solution engineer", "solutions architect", "solution architect",
      "sales engineer", "customer engineer", "field engineer", "implementation engineer",
      "professional services", "technical account manager", "solutions consultant",
      "solutions specialist", "presales", "pre sales", "technical support engineer",
      "support engineer", "customer success engineer", "partner engineer",
      "integration engineer", "onboarding engineer", "deployment specialist",
    ],
    exclude: [
      "recruiter", "forward deployed", "software support intern", "sourcing", "procurement",
      "business systems analyst", "systems analyst", "help desk", "desktop support",
      "it support", "program manager", "project manager",
    ],
  },
  devrel_techwriter: {
    title_keywords: [
      "developer advocate", "developer relations", "devrel", "developer experience",
      "developer educator", "developer marketing", "community engineer", "community manager",
      "technical writer", "technical writing", "documentation engineer", "docs engineer",
      "content engineer", "technical content", "developer content", "curriculum engineer",
      "technical curriculum", "developer community", "technical evangelist", "evangelist",
    ],
    exclude: [
      "recruiter", "technical recruiter", "content moderator", "content operations",
      "product manager", "program manager", "project manager", "social media", "sourcer",
      "content marketing", "community operations",
    ],
  },
};

export const FAMILY_IDS = Object.keys(FAMILIES);

const PRIORITY = new Map(FAMILY_IDS.map((id, i) => [id, i]));

/** lowercase, punctuation → space, collapse, pad: " staff ml engineer inference " */
export function normalizeTitle(title) {
  return ` ${String(title ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")} `;
}

const phraseCache = new Map();
function phrase(p) {
  let v = phraseCache.get(p);
  if (v === undefined) {
    v = normalizeTitle(p);
    phraseCache.set(p, v);
  }
  return v;
}

function matches(norm, p) {
  return norm.includes(phrase(p));
}

/**
 * @param {string} title
 * @returns {string|null} family id, or null when no family claims the title
 */
export function classifyTitle(title) {
  const norm = normalizeTitle(title);
  if (norm.trim() === "") return null;
  let best = null;
  for (const [id, spec] of Object.entries(FAMILIES)) {
    if (spec.exclude.some((p) => matches(norm, p))) continue;
    let hit = null;
    for (const kw of spec.title_keywords) {
      if (!matches(norm, kw)) continue;
      const tokens = phrase(kw).trim().split(" ").length;
      if (!hit || tokens > hit.tokens || (tokens === hit.tokens && kw.length > hit.len)) {
        hit = { tokens, len: kw.length, kw };
      }
    }
    if (!hit) continue;
    const cand = { id, ...hit, prio: PRIORITY.get(id) };
    if (
      !best ||
      cand.tokens > best.tokens ||
      (cand.tokens === best.tokens && cand.len > best.len) ||
      (cand.tokens === best.tokens && cand.len === best.len && cand.prio < best.prio)
    ) {
      best = cand;
    }
  }
  return best ? best.id : null;
}

/** Which keyword won — for debugging the taxonomy, not used at runtime. */
export function explainTitle(title) {
  const norm = normalizeTitle(title);
  const family = classifyTitle(title);
  if (!family) return { family: null, keyword: null, norm };
  const spec = FAMILIES[family];
  let hit = null;
  for (const kw of spec.title_keywords) {
    if (!matches(norm, kw)) continue;
    const tokens = phrase(kw).trim().split(" ").length;
    if (!hit || tokens > hit.tokens || (tokens === hit.tokens && kw.length > hit.len)) {
      hit = { tokens, len: kw.length, kw };
    }
  }
  return { family, keyword: hit?.kw ?? null, norm };
}
