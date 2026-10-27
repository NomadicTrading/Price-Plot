import "dotenv/config";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";

const { EBAY_CLIENT_ID: ID, EBAY_CLIENT_SECRET: SECRET, PORT = 3000, ENABLE_SOLD } = process.env;
// Keys are only needed to fetch listings; the app still starts without them so the
// eBay account-deletion endpoint can answer. Names only are logged, never values.
console.log("Settings found:", ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_VERIFICATION_TOKEN", "EBAY_ENDPOINT_URL"].filter((k) => process.env[k]).join(", ") || "none");
if (!ID || !SECRET) console.warn("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set: listings will not load until they are added.");

const API = "https://api.ebay.com";
const MARKET = "EBAY_US";
const CATEGORY = process.env.CATEGORY || ""; // optional eBay category ID; blank searches everything, like eBay's search box
const MAX_RESULTS = Number(process.env.MAX_RESULTS) || 400; // cap on active listings per search; each 200 uses one of eBay's 5,000 daily calls
const LISTINGS_CACHE_MIN = Number(process.env.LISTINGS_CACHE_MINUTES) || 30; // how long a search's results are shared before asking eBay again
const catParam = CATEGORY ? { category_ids: CATEGORY } : {};
const SCOPE_BROWSE = "https://api.ebay.com/oauth/api_scope";
const SCOPE_INSIGHTS = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

const tokens = {};
async function token(scope) {
  if (!ID || !SECRET) throw new Error("eBay keys are not set yet");
  const t = tokens[scope];
  if (t && t.exp > Date.now() + 60000) return t.value;
  const r = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  if (!r.ok) throw new Error(`eBay auth failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  tokens[scope] = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function ebay(path, params, scope) {
  const r = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${await token(scope)}`, "X-EBAY-C-MARKETPLACE-ID": MARKET },
  });
  if (!r.ok) throw new Error(`eBay ${r.status}: ${await r.text()}`);
  return r.json();
}

// Active listings: Browse API, 200 per page, up to MAX_RESULTS
async function active(q) {
  const out = [];
  for (let offset = 0; offset < MAX_RESULTS; offset += 200) {
    const j = await ebay(
      "/buy/browse/v1/item_summary/search",
      { q, ...catParam, limit: 200, offset },
      SCOPE_BROWSE
    );
    for (const i of j.itemSummaries || []) {
      if (i.price?.currency !== "USD") continue;
      out.push({
        type: "For sale",
        price: Number(i.price.value),
        date: new Date().toISOString(),
        title: i.title,
        url: i.itemWebUrl,
        bc: i.condition || "",
        fmt: (i.buyingOptions || []).includes("AUCTION") ? "auction" : "bin",
        offer: (i.buyingOptions || []).includes("BEST_OFFER"),
        ship: i.shippingOptions?.[0]?.shippingCost?.value != null ? Number(i.shippingOptions[0].shippingCost.value) : null,
        seller: i.seller?.username || "",
      });
    }
    if (!j.next) break;
  }
  return out;
}

// Grade detection from the listing title: PSA, BGS (Beckett), CGC, TAG
const GR = { PSA: "PSA", BGS: "(?:BGS|BECKETT)", CGC: "CGC", TAG: "TAG" };
function parseGrade(t) {
  for (const [g, p] of Object.entries(GR)) {
    const m = new RegExp(`\\b${p}\\s*#?\\s*(?:GEM\\s*MINT\\s*|MINT\\s*|NM-?MT\\s*|PRISTINE\\s*)?(\\d{1,2}(?:\\.\\d)?)\\b`, "i").exec(t);
    if (m) {
      const grade = Number(m[1]);
      // which kind of 10: BGS Black Label, or a Pristine 10 (CGC, TAG, BGS); null otherwise
      const sub = grade === 10 ? (/\bblack\s*label\b/i.test(t) ? "black" : /\bpristine\b/i.test(t) ? "pristine" : null) : null;
      return { grader: g, grade, sub };
    }
    // TAG needs a number, since "TAG TEAM" is a PokÃ©mon card type
    if (g !== "TAG" && new RegExp(`\\b${p}\\b`, "i").test(t)) return { grader: g, grade: null };
  }
  return { grader: null, grade: null };
}

// Sold listings: Marketplace Insights API (restricted; needs eBay approval).
// It only reaches back 90 days, so every sale seen is saved to data/sold.json
// and kept for 1000 days. History past 90 days builds up as the app keeps running.
// Field names follow eBay's docs; untested until you have access.
const DB = "data/sold.json";
const YEAR = 1000 * 864e5; // how long saved sales are kept
// Saved data (sold history, the monthly request counter, recent lookups) lives in an Upstash Redis
// database when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, so it survives restarts and
// redeploys. Without them it falls back to files in data/, which free Render wipes on every restart.
// Temporary entries are given an expiry, so the database never needs eviction.
const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const kv = {
  on: !!(KV_URL && KV_TOKEN),
  async cmd(args) {
    const r = await fetch(KV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `database returned ${r.status}`);
    return j.result;
  },
  async get(k) {
    if (!this.on) return null;
    try { const v = await this.cmd(["GET", "pp:" + k]); return v == null ? null : JSON.parse(v); }
    catch (e) { console.error("saved data read failed:", e.message); return null; }
  },
  async set(k, v, ttlSec) {
    if (!this.on) return;
    try { await this.cmd(["SET", "pp:" + k, JSON.stringify(v), ...(ttlSec ? ["EX", String(Math.max(1, Math.round(ttlSec)))] : [])]); }
    catch (e) { console.error("saved data write failed:", e.message); }
  },
};
console.log("Saved data:", kv.on ? "Upstash database" : "local files (lost on restart)");

let store = {};
try { store = JSON.parse(fs.readFileSync(DB, "utf8")); } catch {}
function save() {
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(store));
}
// one search's saved sales, loaded from the database the first time it's needed
async function bucketFor(q) {
  if (!store[q]) store[q] = (await kv.get("sold:" + q)) || {};
  return store[q];
}
async function saveBucket(q) {
  if (kv.on) await kv.set("sold:" + q, store[q]);
  else save();
}

async function collectSold(q) {
  const bucket = await bucketFor(q);
  for (let offset = 0; offset < 200; offset += 50) {
    const j = await ebay(
      "/buy/marketplace_insights/v1_beta/item_sales/search",
      { q, ...catParam, limit: 50, offset },
      SCOPE_INSIGHTS
    );
    for (const i of j.itemSales || []) {
      if (i.lastSoldPrice?.currency !== "USD") continue;
      bucket[i.itemWebUrl] = {
        type: "Sold",
        price: Number(i.lastSoldPrice.value),
        date: i.lastSoldDate,
        title: i.title,
        url: i.itemWebUrl,
      };
    }
    if (!j.next) break;
  }
  for (const [u, x] of Object.entries(bucket)) if (Date.now() - new Date(x.date) > YEAR) delete bucket[u];
  await saveBucket(q);
  return Object.values(bucket);
}

// Sold listings from CompsAPI, an independent service (not run by eBay). Set COMPS_API_KEY to use it;
// it reaches back up to 3 years and includes each sale's link. Each page of up to 240 sales counts as
// one request against your plan. To stay inside the free 100 requests a month: a search is fetched at most
// once a day, only its first visit pulls several pages, later visits pull just the newest page and add it to
// the saved history, and a monthly counter stops requests before the plan runs out.
// Field names follow CompsAPI's docs; untested until you add a key.
const COMPS_KEY = process.env.COMPS_API_KEY;
const COMPS_MAX_PAGES = Math.max(1, Number(process.env.COMPS_MAX_PAGES) || 2);
const COMPS_LIMIT = Number(process.env.COMPS_MONTHLY_LIMIT) || 90;
const COMPS_REFRESH_MS = (Number(process.env.COMPS_REFRESH_HOURS) || 24) * 3600e3;
const USAGE = "data/usage.json";
let usage = {}, usageLoaded = false;
try { usage = JSON.parse(fs.readFileSync(USAGE, "utf8")); } catch {}
// CompsAPI's own count of this month's requests: asking doesn't use one. Remembered for 5 minutes.
let quota = null;
async function compsQuota(fresh) {
  if (!COMPS_KEY) return null;
  if (!fresh && quota && Date.now() - quota.at < 5 * 60e3) return quota;
  try {
    const r = await fetch("https://api.compsapi.com/v1/usage", { headers: { "X-API-Key": COMPS_KEY }, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (r.ok && j && j.monthly_quota != null) quota = { at: Date.now(), used: +j.monthly_used || 0, limit: +j.monthly_quota, plan: j.plan || "", raw: j };
  } catch {}
  return quota;
}
const resetDay = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const QUOTA_MSG = () => `this month's sold lookups are used up (resets ${resetDay()}), showing saved sales`;
async function useRequest() {
  const qt = await compsQuota();
  if (qt && qt.used >= qt.limit) return false;
  if (qt) qt.used++; // counted here too, so a burst of searches doesn't run past the limit between checks
  if (kv.on && !usageLoaded) { usage = (await kv.get("usage")) || usage; usageLoaded = true; }
  const month = new Date().toISOString().slice(0, 7);
  if (usage.month !== month) usage = { month, n: 0 };
  if (usage.n >= COMPS_LIMIT) return false;
  usage.n++;
  if (kv.on) await kv.set("usage", usage, 62 * 864e2);
  else { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(USAGE, JSON.stringify(usage)); }
  return true;
}
const COMPS_DAYS = Math.min(1000, Number(process.env.COMPS_DAYS) || 1000);
const compsLog = []; // the last 25 sold lookups: what was asked and what came back, shown on /api/usage
function logComps(x) { compsLog.unshift({ at: new Date().toISOString(), ...x }); compsLog.length = Math.min(compsLog.length, 25); kv.set("compslog", compsLog, 14 * 864e2); }
async function compsGet(params) {
  const url = "https://api.compsapi.com/v1/sold?" + new URLSearchParams({ ...params, ...(CATEGORY ? { category: CATEGORY } : {}) });
  const go = () => fetch(url, { headers: { "X-API-Key": COMPS_KEY, "User-Agent": "price-plot/0.1" }, signal: AbortSignal.timeout(30000) });
  const once = async () => { const r = await go(), text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { r, j, text }; };
  let out = await once();
  const used = (o) => o.r.status === 429 && /quota/i.test(o.text);
  // the free plan allows about 10 requests a minute: when it says to wait, wait (up to 20 seconds) and ask once more
  if (out.r.status === 429 && !used(out)) {
    const wait = Math.min(20, Math.max(1, Number(out.r.headers.get("retry-after")) || 7));
    await new Promise((ok) => setTimeout(ok, wait * 1000));
    out = await once();
  }
  if (used(out) && quota) quota.used = Math.max(quota.used, quota.limit); // remember it, so no more lookups are tried this month
  out.quotaUsedUp = used(out);
  return out;
}
let compsNote = "";
const pulled = {};
async function collectComps(q) {
  const bucket = await bucketFor(q);
  if (pulled[q] == null) pulled[q] = (await kv.get("pulled:" + q)) || 0;
  if (pulled[q] && Date.now() - pulled[q] < COMPS_REFRESH_MS) return Object.values(bucket);
  const pages = Object.keys(bucket).length ? 1 : COMPS_MAX_PAGES;
  let days = COMPS_DAYS;
  let got = 0;
  for (let page = 1; page <= pages; page++) {
    if (!(await useRequest())) {
      if (page === 1) throw new Error(QUOTA_MSG());
      break;
    }
    let { r, j, text, quotaUsedUp } = await compsGet({ q, days, size: 240, page });
    // the free plan is documented as 1 year of history; if it refuses a longer window, retry with 365 days
    if (!r.ok && days > 365 && [400, 402, 403, 422].includes(r.status)) {
      days = 365;
      compsNote = "Your sold-data plan seems to allow only 1 year of history, so sold sales are limited to that.";
      ({ r, j, text, quotaUsedUp } = await compsGet({ q, days, size: 240, page }));
    }
    if (!r.ok || !j) {
      logComps({ q, page, days, status: r.status, error: (j && (j.error || j.message || j.detail)) || text.slice(0, 200) });
      throw new Error(quotaUsedUp || r.status === 402 ? QUOTA_MSG() : r.status === 429 ? "sold-data service is busy, try again in a minute" : `sold-data service returned ${r.status}`);
    }
    const items = j.items || [];
    for (const i of items) {
      const price = Number(i.price), date = new Date(String(i.last_sold || "").replace(" ", "T") + (/Z|[+-]\d\d:?\d\d$/.test(i.last_sold || "") ? "" : "Z"));
      if (!(price > 0) || isNaN(date) || !i.url) continue;
      bucket[i.item_id || i.url] = { type: "Sold", price, date: date.toISOString(), title: i.title || "", url: i.url };
      got++;
    }
    logComps({ q, page, days, status: r.status, count: j.count ?? items.length, kept: got });
    if (!j.next_page) break;
  }
  pulled[q] = Date.now();
  await kv.set("pulled:" + q, pulled[q], COMPS_REFRESH_MS / 1000);
  for (const [u, x] of Object.entries(bucket)) if (Date.now() - new Date(x.date) > YEAR) delete bucket[u];
  await saveBucket(q);
  return Object.values(bucket);
}

const SOLD_ON = !!COMPS_KEY || ENABLE_SOLD === "true";
const collectSoldAny = (q) => (COMPS_KEY ? collectComps(q) : collectSold(q));

// Optional: re-collect sold sales for these searches every 6 hours, so the
// year of history keeps growing even when nobody is searching. Use the exact
// search text, including grader terms (see .env.example).
const WATCH = (process.env.WATCH || "").split("|").map((x) => x.trim()).filter(Boolean);
if (SOLD_ON && WATCH.length) {
  const run = () => WATCH.forEach((q) => collectSoldAny(q).catch((e) => console.error("watch:", q, e.message)));
  run();
  setInterval(run, 6 * 3600e3);
}

// ---- Search refinement: condition detection and "does this listing match the search?" ----
const norm = (t) => String(t).normalize("NFD").replace(/[Ì-Í¯]/g, "").toLowerCase().replace(/['â.\-]/g, "");
const STOP = new Set(["the", "a", "an", "of", "and", "card", "cards", "pokemon", "tcg", "holo", "holographic", "rare", "set", "ccg"]);
const JUNK = /\b(lots?|bundle|proxy|proxies|custom|replica|reprint|fake|digital|code card|sealed|booster|bulk|binder|playmat|sleeves?|you pick|pick your|choose your|complete set|master set|empty box)\b/;

// "charizard 4/102 -jumbo" -> words to send to eBay, the card number, and words to exclude
function parseQuery(raw) {
  const parts = String(raw).trim().split(/\s+/).filter(Boolean);
  const ex = parts.filter((w) => w.length > 1 && w[0] === "-").map((w) => norm(w.slice(1)));
  // Collectr-style names carry notes like "(Secret)" or "(Full Art)" that eBay titles rarely repeat, and gallery
  // numbers like "GG70/GG70" or "TG05/TG30" are written on eBay as just "GG70": search by the card's own code
  const search = parts.filter((w) => !(w.length > 1 && w[0] === "-")).join(" ")
    .replace(/\((?:secret|full art|alt(?:ernate)? art|special illustration|illustration rare|hyper rare|gold|rainbow|shiny|promo|holo|reverse holo|[^)]*rare[^)]*)\)/gi, " ")
    .replace(/\b([a-z]{1,4}\d{1,3}[a-z]?)\s*\/\s*[a-z]{1,4}\d{1,3}\b/gi, "$1")
    .replace(/\s+/g, " ").trim();
  let num = null;
  const rest = search.replace(/(\d{1,3})\s*\/\s*(\d{1,3})/, (_, n, d) => ((num = { n: String(+n), d: String(+d) }), " "));
  const words = norm(rest).split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w && !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
  return { search, ex, num, words };
}

// true when the listing looks like the card being searched for
function relevant(title, pq, rawQuery) {
  const t = norm(String(title).replace(/(\p{L})-(\p{L})/gu, "$1 $2"));
  if (pq.ex.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[^a-z0-9]/g, "")}($|[^a-z0-9])`).test(t))) return false;
  if (!JUNK.test(norm(rawQuery)) && JUNK.test(t)) return false;
  for (const w of pq.words) if (!new RegExp(`(^|[^a-z0-9])${w}(s|es)?($|[^a-z0-9])`).test(t)) return false;
  if (pq.num) {
    const found = [...t.matchAll(/(\d{1,3})\s*\/\s*(\d{1,3})/g)];
    // a different card number in the title means a different card; no number at all can't be checked
    if (found.length && !found.some((m) => String(+m[1]) === pq.num.n && String(+m[2]) === pq.num.d)) return false;
  }
  return true;
}

// Raw-card condition from the title, falling back to eBay's own condition field.
const CONDS = [
  ["DMG", /\b(damaged|dmg)\b/],
  ["HP", /(?<!\d\s?)\b(heavily ?played|heavy ?play|hp)\b(?!\s?\d)/],
  ["MP", /\b(moderately ?played|moderate ?play|mp)\b/],
  ["LP", /\b(lightly ?played|light ?play|slightly ?played|lp)\b/],
  ["NM", /\b(near ?mint|nm|nmmt|mint)\b/],
];
const BCOND = [[/near mint/i, "NM"], [/lightly played/i, "LP"], [/moderately played/i, "MP"], [/heavily played/i, "HP"], [/damaged/i, "DMG"]];
function parseCond(title, browseCond) {
  const t = norm(title);
  for (const [c, re] of CONDS) if (re.test(t)) return c;
  for (const [re, c] of BCOND) if (re.test(browseCond || "")) return c;
  return null;
}

// Holo / reverse holo / non-holo from the title (null when the title does not say)
function parseFinish(title) {
  const t = norm(title);
  if (/\bnon ?holo(foil)?\b|\bno holo\b/.test(t)) return "nonholo";
  if (/\breverse\b|\brev ?holo\b/.test(t)) return "reverse";
  if (/\b(holo|holofoil|holographic)\b/.test(t)) return "holo";
  return null;
}

// Language, edition and shadowless, read from the title
function parseLang(title) {
  const t = norm(title);
  if (/\b(japanese|japan|jpn|jp)\b/.test(t)) return "jp";
  if (/\b(korean|korea|kor)\b/.test(t)) return "kr";
  if (/\b(chinese|china|chn|simplified|traditional chinese)\b/.test(t)) return "cn";
  if (/\b(german|french|spanish|italian|portuguese|dutch|thai|indonesian)\b/.test(t)) return "other";
  return null; // not stated, usually English
}
function parseEdition(title) {
  const t = norm(title);
  if (/\b(1st|first) ?(ed|edition)\b|\b1st\b/.test(t)) return "1st";
  if (/\bshadowless\b/.test(t) && !/\bnon ?shadowless\b/.test(t)) return "shadowless";
  if (/\bunlimited\b/.test(t)) return "unlimited";
  return null;
}

const GRADERS = { PSA: "PSA", BGS: "(BGS,Beckett)", CGC: "CGC", TAG: "TAG" };
const cache = new Map(); // results shared for LISTINGS_CACHE_MIN minutes, to stay well inside eBay's daily limit
const app = express();
// Express 4 doesn't catch errors thrown in async handlers, and an uncaught one stops the whole server.
// Wrap every handler so a bug answers that one request with an error instead.
for (const m of ["get", "post", "put", "delete"]) {
  const orig = app[m].bind(app);
  app[m] = (path, ...hs) => (m === "get" && hs.length === 0) ? orig(path) : orig(path, ...hs.map((h) => typeof h !== "function" || h.length > 3 ? h : (req, res, next) => {
    try { const p = h(req, res, next); if (p && typeof p.catch === "function") p.catch((e) => { console.error(req.path, e); if (!res.headersSent) res.status(500).json({ error: "Price Plot hit a bug: " + e.message }); }); }
    catch (e) { console.error(req.path, e); if (!res.headersSent) res.status(500).json({ error: "Price Plot hit a bug: " + e.message }); }
  }));
}
process.on("unhandledRejection", (e) => console.error("unhandled:", e));
app.use(express.static("public"));

app.get("/api/listings", async (req, res) => {
  const base = String(req.query.q || "").trim().slice(0, 100);
  if (!base) return res.status(400).json({ error: "Missing q" });
  const g = GRADERS[req.query.grader]; // PSA, BGS, CGC or TAG; anything else adds no grader term
  const pq = parseQuery(base);
  if (!pq.search) return res.status(400).json({ error: "Add at least one search word" });
  const q = g ? `${pq.search} ${g}` : pq.search; // what eBay is asked for ("-word" exclusions are applied here instead)
  const key = `${base}|${g || ""}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return res.json(hit.data);
  try {
    const warnings = [];
    const [a, s] = await Promise.all([
      active(q),
      SOLD_ON
        ? collectSoldAny(q).catch((e) => (warnings.push("Sold data unavailable: " + e.message), Object.values(store[q] || {})))
        : [],
    ]);
    if (COMPS_KEY && compsNote) warnings.push(compsNote);
    const listings = [...s, ...a].map(({ bc, ...x }) => {
      const gi = parseGrade(x.title);
      return { ...x, ...gi, cond: gi.grader ? null : parseCond(x.title, bc), fin: parseFinish(x.title), lang: parseLang(x.title), ed: parseEdition(x.title), rel: relevant(x.title, pq, base) };
    });
    const data = { listings, soldEnabled: SOLD_ON, warnings };
    if (!warnings.some((w) => w.startsWith("Sold data unavailable"))) cache.set(key, { exp: Date.now() + LISTINGS_CACHE_MIN * 60000, data });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

// TCGplayer prices per printing (low / mid / high / market) and the TCGplayer product link,
// via pokemontcg.io. TCGplayer does not offer condition-level prices or sold sales through a free feed.
const PTCG_KEY = process.env.POKEMONTCG_API_KEY;
const NAME_SKIP = new Set(["psa", "bgs", "beckett", "cgc", "tag", "nm", "lp", "mp", "hp", "dmg", "near", "mint", "lightly", "moderately", "heavily", "played", "gem", "1st", "edition", "shadowless", "unlimited", "reverse", "foil", "graded", "raw", "base", "set"]);
const tcgCache = new Map();
app.get("/api/tcg", async (req, res) => {
  const base = String(req.query.q || "").trim().slice(0, 100);
  if (!base) return res.status(400).json({ error: "Missing q" });
  const pq = parseQuery(base);
  // the link searches for the card itself, without grade or condition words
  const DROP = new Set(["psa", "bgs", "beckett", "cgc", "tag", "nm", "lp", "mp", "hp", "dmg", "near", "mint", "lightly", "moderately", "heavily", "played", "gem", "graded", "raw", "ungraded"]);
  let afterGrader = false;
  const linkWords = pq.search.split(/\s+/).filter((w) => {
    const n = norm(w).replace(/[^a-z0-9.]/g, "");
    if (DROP.has(n)) return (afterGrader = ["psa", "bgs", "beckett", "cgc", "tag"].includes(n)), false;
    if (afterGrader && /^\d+(\.\d)?$/.test(n)) return (afterGrader = false), false;
    afterGrader = false;
    return true;
  });
  const searchUrl = "https://www.tcgplayer.com/search/pokemon/product?" + new URLSearchParams({ productLineName: "pokemon", view: "grid", q: linkWords.join(" ") });
  const hit = tcgCache.get(base);
  if (hit && hit.exp > Date.now()) return res.json(hit.data);
  const tokens = norm(pq.search.replace(/\d{1,3}\s*\/\s*\d{1,3}/, " ")).split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w && !STOP.has(w) && !NAME_SKIP.has(w) && !/^\d+$/.test(w));
  let ptcgErr = null;
  try {
    let cards = [];
    // try the whole name first, then drop words from the end until something matches
    try {
    for (let k = Math.min(tokens.length, 4); k >= 1 && !cards.length; k--) {
      const use = tokens.slice(0, k);
      const q = [`name:"${use.join(" ")}"`, ...(pq.num ? [`number:${pq.num.n}`] : [])].join(" ");
      // pokemontcg.io often answers 502/503/504 when it's busy, so try up to 3 times, asking for fewer cards each time
      let r;
      for (let tries = 0; tries < 3; tries++) {
        const size = String(Math.round((pq.num ? 80 : 250) / (tries + 1)));
        r = await fetch("https://api.pokemontcg.io/v2/cards?" + new URLSearchParams({ q, pageSize: size, orderBy: "set.releaseDate", select: "id,name,number,set,images,tcgplayer" }), {
          headers: PTCG_KEY ? { "X-Api-Key": PTCG_KEY } : {},
          signal: AbortSignal.timeout(20000),
        }).catch(() => null);
        if (r && (r.ok || r.status < 500)) break;
        await new Promise((ok) => setTimeout(ok, 800 * (tries + 1)));
      }
      if (!r) throw new Error("the card price service didn't answer, try again in a minute");
      if (!r.ok) throw new Error(r.status >= 500 ? `the card price service is having trouble (${r.status}), try again in a minute` : `price service returned ${r.status}`);
      const got = (await r.json()).data || [];
      // keep cards whose name contains every searched word (the service also returns partial matches)
      cards = got.filter((c) => {
        const w = norm(c.name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
        return use.every((t) => w.includes(t));
      });
    }
    } catch (e) { ptcgErr = e; cards = []; console.error("tcg search (pokemontcg.io):", e.message); }
    // pokemontcg.io is often slow or down, and it misses some cards: then use TCGplayer's own search instead
    if (!cards.length) {
      const tq = linkWords.join(" ").trim() || pq.search;
      let tc = [];
      try { tc = await tcgScan(pq.num ? `${tq.replace(/\d{1,3}\s*\/\s*\d{1,3}/, " ").trim()} ${pq.num.n}${pq.num.d ? "/" + pq.num.d : ""}` : tq); } catch (e) { console.error("tcg search (TCGplayer):", e.message); }
      if (!tc.length && pq.num) try { tc = await tcgScan(tq.replace(/\d{1,3}\s*\/\s*\d{1,3}/, " ").trim()); } catch {}
      if (!tc.length && ptcgErr) throw ptcgErr;
      const data = {
        searchUrl, source: "tcgplayer",
        cards: tc.slice(0, 12).map((c) => ({
          id: c.id, name: c.name, number: c.number, set: c.set, printedTotal: c.printedTotal, year: 0,
          exact: !!(pq.num && String(+c.number) === pq.num.n && (!pq.num.d || String(c.printedTotal) === pq.num.d)),
          finishes: [], image: c.image, tcgUrl: `https://www.tcgplayer.com/product/${c.tcgId}`, tcgId: c.tcgId, updated: null, prices: {},
        })).sort((x, y) => Number(y.exact) - Number(x.exact)),
      };
      if (data.cards.length) tcgCache.set(base, { exp: Date.now() + 3600e3, data });
      return res.json(data);
    }
    const finishesOf = (p) => [...new Set(Object.keys(p || {}).map((k) => (/reverse/i.test(k) ? "reverse" : /normal/i.test(k) ? "nonholo" : "holo")))];
    const list = cards
      .map((c) => ({
        id: c.id, name: c.name, number: c.number, set: c.set?.name, setId: c.set?.id, printedTotal: c.set?.printedTotal,
        released: c.set?.releaseDate, year: Number(String(c.set?.releaseDate || "").slice(0, 4)) || 0,
        exact: !!(pq.num && String(c.set?.printedTotal) === pq.num.d && String(+c.number) === pq.num.n),
        finishes: finishesOf(c.tcgplayer?.prices),
        image: c.images?.small, tcgUrl: c.tcgplayer?.url, updated: c.tcgplayer?.updatedAt, prices: c.tcgplayer?.prices || {},
      }))
      .sort((x, y) => Number(y.exact) - Number(x.exact) || x.year - y.year);
    // full price details only for the first few cards, to keep the response small
    const data = { searchUrl, cards: list.map((c, i) => (i < 8 ? c : { ...c, image: undefined, tcgUrl: undefined, updated: undefined, prices: {} })) };
    tcgCache.set(base, { exp: Date.now() + 3600e3, data });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message, searchUrl });
  }
});

// Card scanner: the phone reads the card's name and number from a photo; this finds the matching cards on
// pokemontcg.io. The number with its set size (e.g. 199/165) usually pins the card down by itself.
const scanCache = new Map();
async function ptcg(q, size) {
  for (let tries = 0; tries < 2; tries++) {
    const r = await fetch("https://api.pokemontcg.io/v2/cards?" + new URLSearchParams({ q, pageSize: String(size), orderBy: "-set.releaseDate", select: "id,name,number,set,images,tcgplayer,rarity" }), {
      headers: PTCG_KEY ? { "X-Api-Key": PTCG_KEY } : {}, signal: AbortSignal.timeout(12000) }).catch(() => null);
    if (r && r.ok) return (await r.json()).data || [];
    if (r && r.status < 500) throw new Error("card lookup returned " + r.status);
    await new Promise((ok) => setTimeout(ok, 700 * (tries + 1)));
  }
  throw new Error("the card lookup service didn't answer, try again in a minute");
}
// Second source for the scanner: TCGplayer's own search, which finds "49/82"-style numbers directly and covers more
// cards (Japanese included). Matches carry their TCGplayer product id, so prices are exact.
async function tcgScan(q) {
  const j = await tpPost("https://mp-search-api.tcgplayer.com/v1/search/request?" + new URLSearchParams({ q: q.slice(0, 120), isList: "false" }), {
    algorithm: "sales_synonym_v2", from: 0, size: 24,
    filters: { term: { productLineName: ["pokemon", "pokemon-japan"] }, range: {}, match: {} },
    listingSearch: { context: { cart: {} }, filters: { term: { sellerStatus: "Live", channelId: 0 }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } } },
    context: { cart: {}, shippingCountry: "US", userProfile: {} }, settings: { useFuzzySearch: true, didYouMean: {} }, sort: {},
  });
  return (((j.results || [])[0] || {}).results || []).filter((r) => r.productId && !/\b(code card|booster|box|bundle|tin|deck|pack|blister)\b/i.test(r.productName || "")).map((r) => {
    const id = String(Math.round(Number(r.productId))), raw = String(r.customAttributes?.number || (/\s-\s([\w/]+)$/.exec(r.productName || "") || [])[1] || "");
    const [num, tot] = raw.split("/");
    return { raw, market: Number(r.marketPrice) > 0 ? Number(r.marketPrice) : null, jp: /japan/i.test(r.productLineName || ""), id: "tcg-" + id, tcgId: id, name: String(r.productName || "").replace(/\s-\s[\w/]+$/, "").trim(), number: num || "", set: r.setName || "", printedTotal: tot ? +tot || tot : null, year: null,
      image: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_200w.jpg`, big: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_400w.jpg`, rarity: r.rarity || r.customAttributes?.rarityDbName || "",
      prints: ["Normal", "Holofoil", "Reverse Holofoil", "1st Edition", "1st Edition Holofoil", "Unlimited", "Unlimited Holofoil"] };
  });
}
// Finds candidate cards for a name and number: pokemontcg.io first, TCGplayer's search as a second source.
async function matchCards(name, n, d, opts = {}) {
  const nn = /^\d+$/.test(n) ? String(+n) : n, words = norm(name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const errors = [];
  // pokemontcg.io and TCGplayer are asked at the same time: pokemontcg.io is often slow or down, and waiting
  // for it to fail first left only TCGplayer's fuzzy "did you mean" results (Houndour for Houndoom)
  const ptcgJob = opts.tcgOnly ? Promise.resolve([]) : (async () => {
    let cards = [];
    if (nn && d) cards = await ptcg(`number:${nn} set.printedTotal:${d}`, 30);
    if (!cards.length && nn && words.length) cards = await ptcg(`number:${nn} name:"${words[0]}*"`, 30);
    if (!cards.length && !(nn && d) && words.length) cards = await ptcg(`name:"${words.slice(0, 3).join(" ")}*"`, 40);
    if (!cards.length && nn && /[a-z]/i.test(nn)) cards = await ptcg(`number:${nn}`, 30);
    return cards;
  })().catch((e) => { errors.push("pokemontcg.io: " + e.message); return []; });
  const nm = words.slice(0, 3).join(" ");
  // three searches: name with number, name with set, and the name alone (TCGplayer's search sometimes drops the right card when the number is included)
  const tq = [...new Map([opts.tcgQuery || (nn && d ? `${nm} ${nn}/${d}` : nn ? `${nm} ${nn}` : ""), nm && opts.setName ? `${nm} ${opts.setName}` : nm && nn ? `${nm} ${nn}` : "", nm]
    .map((q) => String(q || "").trim()).filter(Boolean).map((q) => [q.toLowerCase(), q])).values()];
  const tcgJob = Promise.all(tq.map((q) => tcgScan(q).catch((e) => { errors.push("TCGplayer: " + e.message); return []; })));
  const cards = await ptcgJob;
  let list = cards.map((c) => ({
    id: c.id, name: c.name, number: c.number, set: c.set?.name, printedTotal: c.set?.printedTotal, year: Number(String(c.set?.releaseDate || "").slice(0, 4)) || null,
    image: c.images?.small, big: c.images?.large, rarity: c.rarity || "", tcgId: null,
    prints: Object.keys(c.tcgplayer?.prices || {}).map((k) => ({ normal: "Normal", holofoil: "Holofoil", reverseHolofoil: "Reverse Holofoil", "1stEditionHolofoil": "1st Edition Holofoil", "1stEditionNormal": "1st Edition", unlimitedHolofoil: "Unlimited Holofoil" }[k] || k)),
  }));
  // TCGplayer's results are used when pokemontcg.io found nothing, or when the printing matters (1st Edition,
  // Shadowless, Japanese, stamps): TCGplayer lists those as separate products
  const tcg = (await tcgJob).flat();
  const fullName = (c) => { const cw = norm(c.name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/); return words.length && words.every((w) => cw.includes(w)); };
  if (!list.length || opts.alsoTcg || !list.some(fullName)) {
    const seen = new Set(list.map((c) => (c.name + "|" + c.set + "|" + c.number).toLowerCase()));
    for (const c of tcg) { const k = (c.name + "|" + c.set + "|" + c.number).toLowerCase(); if (!seen.has(k)) { seen.add(k); list.push(c); } }
  }
  if (list.length) errors.length = 0;
  return { list, errors, nn, words };
}
const scoreCard = (c, nn, d, words, extra) => {
  const cw = norm(c.name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/), hit = words.filter((w) => cw.includes(w)).length;
  // the name matters most: a card with the right number but another name (Houndour 133 for Houndoom 133) ranks low
  let sc = hit * 2 + (words.length && hit === words.length ? 6 : 0) - (words.length && !hit ? 8 : 0);
  const cn = String(c.number || "").toLowerCase().replace(/^0+(?=\d)/, ""); if (nn && cn === nn.toLowerCase()) sc += 5; if (d && String(c.printedTotal) === d) sc += 5;
  return sc + (extra ? extra(c) : 0);
};
// Search bar suggestions: TCGplayer's matches for what's typed, one row per printing with its Near Mint market price.
// Printing prices come from each card's price history (remembered 24 hours), looked up for the top few cards only.
const sugCache = new Map();
app.get("/api/suggest", async (req, res) => {
  const q = String(req.query.q || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (q.length < 3) return res.json({ items: [] });
  const key = q.toLowerCase(), hit = sugCache.get(key);
  if (hit && hit.exp > Date.now()) return res.json(hit.data);
  let prods;
  try { prods = (await tcgScan(q)).slice(0, 8); } catch (e) { return res.status(502).json({ error: e.message }); }
  const ORDER = ["normal", "holofoil", "reverse holofoil", "1st edition", "1st edition holofoil", "unlimited", "unlimited holofoil"];
  const rank = (p) => { const i = ORDER.indexOf(p.toLowerCase()); return i < 0 ? 99 : i; };
  // price histories for the first 6 cards, together, giving up after 6 seconds (the card's overall price is used instead)
  const hist = await Promise.all(prods.map((c, i) => i < 6 ? Promise.race([tpLatest(c.tcgId).catch(() => null), new Promise((ok) => setTimeout(() => ok(null), 6000))]) : null));
  const items = [];
  prods.forEach((c, i) => {
    const base = { tcgId: c.tcgId, name: c.name, numberText: c.raw || "", number: c.number, printedTotal: c.printedTotal, set: c.set, image: c.image, rarity: c.rarity, jp: c.jp };
    const rows = (hist[i] || []).filter((r) => r.cond === "Near Mint" && (!r.lang || (c.jp ? /japan/i.test(r.lang) : /english/i.test(r.lang))));
    const byPrint = new Map(); for (const r of rows) if (!byPrint.has(r.print) || r.t > byPrint.get(r.print).t) byPrint.set(r.print, r);
    const prints = [...byPrint.values()].sort((a, b) => rank(a.print) - rank(b.print));
    if (prints.length) for (const r of prints) items.push({ ...base, print: r.print, nm: r.m });
    else items.push({ ...base, print: "", nm: c.market, overall: true });
  });
  const data = { items: items.slice(0, 14) };
  if (items.length) { sugCache.set(key, { exp: Date.now() + 6 * 3600e3, data }); if (sugCache.size > 3000) sugCache.delete(sugCache.keys().next().value); }
  res.json(data);
});

// The Shadowless (or regular Base Set) version of a Base Set card: TCGplayer lists them as separate products.
const editionCache = new Map();
app.get("/api/scan-edition", async (req, res) => {
  const name = String(req.query.name || "").replace(/\s+-\s+[\w/]+$/, "").replace(/["\\*:()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const n = String(+String(req.query.n || "").replace(/\D/g, "") || ""), d = String(req.query.d || "").replace(/\D/g, "").slice(0, 4) || "102";
  const want = req.query.want === "unlimited" ? "unlimited" : "shadowless";
  if (!name || !n) return res.status(400).json({ error: "Missing card name or number" });
  const key = [name.toLowerCase(), n, d, want].join("|"), hit = editionCache.get(key);
  if (hit && hit.exp > Date.now()) return res.json(hit.data);
  const words = norm(name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const fits = (c) => {
    const set = String(c.set || ""), cw = norm(c.name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
    const setOk = want === "shadowless" ? /shadowless/i.test(set) : /^base set$/i.test(set.trim());
    return setOk && String(+c.number) === n && words.every((w) => cw.includes(w));
  };
  let found = null;
  try {
    for (const q of want === "shadowless" ? [`${name} Shadowless ${n}/${d}`, `${name} Base Set Shadowless`] : [`${name} Base Set ${n}/${d}`, `${name} Base Set`]) {
      found = (await tcgScan(q)).find(fits); if (found) break;
    }
  } catch (e) { return res.status(502).json({ error: "TCGplayer didn't answer: " + e.message }); }
  if (!found) return res.status(404).json({ error: want === "shadowless" ? "No Shadowless version of this card on TCGplayer" : "No regular Base Set version of this card on TCGplayer" });
  // the printings TCGplayer sells this product in (Holofoil or Normal; 1st Edition is its own choice)
  found.prints = ["Holofoil", "Normal", "1st Edition Holofoil", "1st Edition"];
  const data = { card: found };
  editionCache.set(key, { exp: Date.now() + 7 * 864e5, data });
  res.json(data);
});

app.get("/api/scan-match", async (req, res) => {
  const name = String(req.query.name || "").replace(/["\\*:()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const n = String(req.query.n || "").replace(/[^a-z0-9]/gi, "").slice(0, 8), d = String(req.query.d || "").replace(/\D/g, "").slice(0, 4);
  if (!name && !n) return res.status(400).json({ error: "Nothing to look up" });
  const key = [name.toLowerCase(), n, d].join("|"), hit = scanCache.get(key);
  if (hit && hit.exp > Date.now()) return res.json(hit.data);
  const { list: all, errors, nn, words } = await matchCards(name, n, d);
  const list = all.map((c) => ({ c, s: scoreCard(c, nn, d, words) })).sort((a, b) => b.s - a.s).slice(0, 8).map(({ c }) => c);
  if (!list.length && errors.length) return res.status(502).json({ error: "The card lookup didn't answer. Try again in a moment.", detail: errors });
  const data = { cards: list };
  if (list.length) { scanCache.set(key, { exp: Date.now() + 864e5, data }); if (scanCache.size > 2000) scanCache.delete(scanCache.keys().next().value); }
  res.json(data);
});

// AI card recognition: a vision model reads the whole photo (name, number, set, edition stamp, Shadowless, holo or
// reverse holo, language, promo stamps, graded slab) and Price Plot matches that to the exact product and printing.
// Needs ANTHROPIC_API_KEY in Render. Costs a fraction of a cent per scan, so it is rate-limited.
// Either service works: Claude (ANTHROPIC_API_KEY, paid per scan) or Google Gemini (GEMINI_API_KEY, which has a free
// tier). Claude is used when both are set. SCAN_MODEL picks the model for whichever is used.
const AI_KEY = process.env.ANTHROPIC_API_KEY, GEM_KEY = process.env.GEMINI_API_KEY;
// Gemini: Flash-Lite first (about a second per scan); 3.8 Flash as the backup (it is often overloaded on the free tier)
const GEM_LITE = process.env.GEMINI_SCAN_MODEL || "gemini-3.5-flash-lite", GEM_BIG = process.env.GEMINI_BACKUP_MODEL || "gemini-3.8-flash";
const AI_MODEL = AI_KEY ? process.env.SCAN_MODEL || "claude-haiku-5-5" : GEM_LITE, GEM_FALLBACK = GEM_BIG;
// The scan tries each service that has a key, in this order, moving on if one is busy, slow or failing:
// Claude (paid, if set) → Groq (free, fast) → Gemini Flash-Lite → OpenRouter (free) → Gemini 3.8 Flash.
const GROQ_KEY = process.env.GROQ_API_KEY, GROQ_MODEL = process.env.GROQ_SCAN_MODEL || "qwen/qwen3.8-27b";
const OR_KEY = process.env.OPENROUTER_API_KEY, OR_MODEL = process.env.OPENROUTER_SCAN_MODEL || "google/gemma-4-31b-it:free";
async function openaiStyle(url, key, model, img, prompt, ms, extraHeaders, extra) {
  const t0 = Date.now();
  const go = (more) => fetch(url, { method: "POST", signal: AbortSignal.timeout(ms), headers: { Authorization: "Bearer " + key, "content-type": "application/json", ...(extraHeaders || {}) },
    body: JSON.stringify({ model, max_tokens: 1500, temperature: 0, ...more, messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + img } }, { type: "text", text: prompt }] }] }) });
  let r = await go(extra || {}), j = await r.json().catch(() => ({}));
  // some models don't accept the "no thinking" setting; ask again without it
  if (!r.ok && r.status === 400 && extra?.reasoning_effort && /reasoning/i.test(JSON.stringify(j))) { const { reasoning_effort, ...rest } = extra; r = await go(rest); j = await r.json().catch(() => ({})); }
  if (!r.ok) throw new Error(j.error?.message || (typeof j.error === "string" ? j.error : "") || model + " returned " + r.status);
  const c = j.choices?.[0]?.message?.content; return { text: (Array.isArray(c) ? c.map((p) => p.text || "").join("") : String(c || "")).replace(/<think>[\s\S]*?<\/think>/g, ""), secs: (Date.now() - t0) / 1000 };
}
function aiChain() {
  const steps = [];
  if (AI_KEY) steps.push({ name: "Claude " + (process.env.SCAN_MODEL || "claude-haiku-5-5"), run: async (img, mime) => {
    const t0 = Date.now(), r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.SCAN_MODEL || "claude-haiku-5-5", max_tokens: 1500, messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: img } }, { type: "text", text: AI_PROMPT }] }] }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || "Claude returned " + r.status);
    return { text: (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""), secs: (Date.now() - t0) / 1000 }; } });
  // Gemini Flash-Lite reads small print (set totals, set symbols) more reliably; Groq is the fast backup when Gemini is busy
  if (GEM_KEY) steps.push({ name: "Gemini " + GEM_LITE, run: (img, mime) => gemini(GEM_LITE, [{ inline_data: { mime_type: mime, data: img } }, { text: AI_PROMPT }], true, 12000) });
  if (GROQ_KEY) steps.push({ name: "Groq " + GROQ_MODEL, run: (img) => openaiStyle("https://api.groq.com/openai/v1/chat/completions", GROQ_KEY, GROQ_MODEL, img, AI_PROMPT, 20000, null, { max_tokens: 450, reasoning_effort: "none" }) });
  if (OR_KEY) steps.push({ name: "OpenRouter " + OR_MODEL, run: (img) => openaiStyle("https://openrouter.ai/api/v1/chat/completions", OR_KEY, OR_MODEL, img, AI_PROMPT, 25000, { "HTTP-Referer": "https://price-plot.onrender.com", "X-Title": "Price Plot" }) });
  if (GEM_KEY && GEM_BIG !== GEM_LITE) steps.push({ name: "Gemini " + GEM_BIG, run: (img, mime) => gemini(GEM_BIG, [{ inline_data: { mime_type: mime, data: img } }, { text: AI_PROMPT }], true, 20000) });
  return steps;
}
async function aiRead(img, mime) {
  const errs = [];
  for (const st of aiChain()) {
    try { const out = await st.run(img, mime); const m = /\{[\s\S]*\}/.exec(out.text); if (!m) throw new Error("answer couldn't be read");
      return { read: JSON.parse(m[0]), by: st.name, secs: out.secs, skipped: errs }; }
    catch (e) { errs.push(st.name + ": " + e.message); }
  }
  throw new Error(errs.join("; ") || "no AI service is set up");
}
// One Gemini request: thinking turned down to "low" for speed (retried without it if the model refuses that setting)
async function gemini(model, parts, json, ms) {
  const go = async (cfg) => {
    const t0 = Date.now();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: AbortSignal.timeout(ms), headers: { "x-goog-api-key": GEM_KEY, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: cfg }) });
    const j = await r.json().catch(() => ({}));
    return { r, j, secs: (Date.now() - t0) / 1000 };
  };
  const base = json ? { responseMimeType: "application/json" } : {};
  let out = await go({ ...base, thinkingConfig: { thinkingLevel: "low" } });
  if (!out.r.ok && out.r.status === 400 && /think/i.test(JSON.stringify(out.j))) out = await go(base);
  if (!out.r.ok) throw Object.assign(new Error(out.j.error?.message || "Gemini returned " + out.r.status), { status: out.r.status });
  return { text: ((out.j.candidates || [])[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join(""), secs: out.secs };
}
const AI_DAILY = Number(process.env.SCAN_DAILY_LIMIT) || 500, AI_PER_IP_HOUR = Number(process.env.SCAN_PER_IP_HOUR) || 200;
const aiUse = { day: "", n: 0, ip: new Map() };
const AI_PROMPT = `You identify collectible trading cards from a phone photo. Look closely at the card, including small print.
Reply with ONLY a JSON object, no other text:
{"found":true|false,"game":"Pokemon"|"Magic"|"Yu-Gi-Oh"|"One Piece"|"other","language":"English"|"Japanese"|"other",
"name":"card name exactly as printed","name_english":"English name of the card (translate if not English)",
"number":"collector number before the slash, e.g. 49 or 199 or SWSH050 or TG05","set_total":"number after the slash, or null",
"set_code":"set code printed on the card if any (e.g. SV2a, PAL, SWSH), or null","set_name":"your best guess of the set name, e.g. Team Rocket, Base Set, Scarlet & Violet 151",
"year":"copyright year on the card or null",
"edition":"1st Edition" ONLY if you can clearly see the small black circular "Edition 1" stamp (on vintage cards it sits just below the bottom-left corner of the artwork); "Shadowless" ONLY for a 1999 Base Set card where you can clearly see there is no drop shadow along the right edge of the art box; "Unlimited" if it is a vintage card and you can see that spot has no stamp; null if you cannot tell. Do not guess the edition from the set or the card's age,
"finish":"holo" (the artwork itself is foil) | "reverse holo" (the card body is foil but the artwork is not) | "non-holo" | "unknown",
"stamp":"any promo, prerelease, staff, set-logo or event stamp text, or null","graded":{"company":"PSA|BGS|CGC|TAG|SGC","grade":"10"} or null if not in a grading slab,
"confidence":0.0 to 1.0,"notes":"note on anything uncertain, 15 words at most"}
Be literal: report only what is visible in the photo. If something is too small, blurry or covered by glare to read, use null rather than guessing.`;
// Open /api/scan-ai/check once to see which AI service is set up and whether a tiny test request works.
// Open /api/scan-ai/check to see which AI services are set up; add ?image=1 to run a real card photo through them
// (?only=Groq or ?only=Gemini etc. to test one).
app.get("/api/scan-ai/check", async (req, res) => {
  const steps = aiChain(), only = String(req.query.only || "").toLowerCase();
  const out = { order: steps.map((s) => s.name), keys: { claude: !!AI_KEY, groq: !!GROQ_KEY, gemini: !!GEM_KEY, openrouter: !!OR_KEY }, scansToday: aiUse.n, dailyLimit: AI_DAILY };
  if (!steps.length) return res.json({ ...out, ok: false, error: "No key found. Add GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY in Render's Environment." });
  let photo = null;
  if (req.query.image) try { const ir = await fetch("https://images.pokemontcg.io/base5/49.png", { signal: AbortSignal.timeout(15000) }); photo = Buffer.from(await ir.arrayBuffer()).toString("base64"); } catch (e) { return res.json({ ...out, error: "couldn't load the sample card: " + e.message }); }
  const tests = {};
  for (const st of steps.filter((s) => !only || s.name.toLowerCase().includes(only))) {
    if (!photo) { tests[st.name] = "set up (add ?image=1 to test it with a card photo)"; continue; }
    try { const o = await st.run(photo, "image/png"); tests[st.name] = { ok: true, seconds: o.secs, read: o.text.slice(0, 500) }; }
    catch (e) { tests[st.name] = { ok: false, error: e.message }; }
    if (!only && Object.keys(tests).length >= 2) { tests.note = "stopped after two to keep this page quick; use ?only= to test the others"; break; }
  }
  res.json({ ...out, tests });
});

app.post("/api/scan-ai", express.json({ limit: "4mb" }), async (req, res) => {
  if (!aiChain().length) return res.status(503).json({ error: "AI scanning isn't set up (add GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY)", off: true });
  const img = String(req.body?.image || "").replace(/^data:image\/\w+;base64,/, "");
  if (!img || img.length > 5.5e6) return res.status(400).json({ error: "Missing or too large photo" });
  const today = new Date().toISOString().slice(0, 10), ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim(), hour = Math.floor(Date.now() / 3600e3);
  if (aiUse.day !== today) { aiUse.day = today; aiUse.n = 0; aiUse.ip.clear(); }
  const per = aiUse.ip.get(ip); const cnt = per && per.h === hour ? per.n : 0;
  if (aiUse.n >= AI_DAILY) return res.status(429).json({ error: "Today's AI scan limit was reached; scanning falls back to reading text until tomorrow", off: true });
  if (cnt >= AI_PER_IP_HOUR) return res.status(429).json({ error: "Too many scans this hour; try again a little later", off: true });
  aiUse.n++; aiUse.ip.set(ip, { h: hour, n: cnt + 1 });
  let read;
  try {
    const out = await aiRead(img, "image/jpeg"); read = out.read; read._by = out.by; read._secs = out.secs;
    if (out.skipped.length) console.log("scan-ai used", out.by, "after:", out.skipped.join(" | "));
  } catch (e) {
    console.error("scan-ai:", e.message);
    return res.status(502).json({ error: "AI scan failed: " + e.message, off: true });
  }
  if (!read || read.found === false) return res.json({ read: read || {}, cards: [] });
  const name = String(read.name_english || read.name || "").slice(0, 60), n = String(read.number || "").replace(/[^a-z0-9]/gi, "").slice(0, 8);
  const d = String(read.set_total || "").replace(/\D/g, "").slice(0, 4), jp = /japan/i.test(read.language || ""), ed = String(read.edition || ""), stamp = String(read.stamp || "");
  const special = jp || /1st|shadowless/i.test(ed) || !!stamp;
  const num = /^\d+$/.test(n) ? String(+n) : n;
  const { list: all, errors, nn, words } = await matchCards(name, n, d, { alsoTcg: special, setName: String(read.set_name || "").replace(/["\\*:()]/g, " ").slice(0, 40),
    tcgQuery: [name, /shadowless/i.test(ed) ? "Shadowless" : "", /1st/i.test(ed) ? "1st Edition" : "", num && d ? `${num}/${d}` : num].filter(Boolean).join(" ") });
  const setGuess = String(read.set_name || "");
  const extra = (c) => {
    let x = setGuess ? sameWords(setGuess, c.set || "") * 4 : 0; const cs = String(c.set || "");
    if (/shadowless/i.test(ed)) x += /shadowless/i.test(cs) ? 4 : -2; else if (/shadowless/i.test(cs)) x -= 3;
    if (/1st/i.test(ed) && /1st edition/i.test(cs + " " + c.name)) x += 3;
    if (jp) x += /japan/i.test(cs) ? 4 : -4; else if (/japan/i.test(cs)) x -= 4;
    if (stamp && /promo|prerelease|staff|stamp/i.test(c.name + " " + cs + " " + (c.rarity || ""))) x += 2;
    return x;
  };
  const list = all.map((c) => ({ c, s: scoreCard(c, nn, d, words, extra) })).sort((a, b) => b.s - a.s).slice(0, 8).map(({ c }) => c);
  // the printing to preselect, from what the photo shows
  const fin = String(read.finish || ""), want = /1st/i.test(ed) ? (/^holo$/i.test(fin) ? "1st Edition Holofoil" : "1st Edition") : /reverse/i.test(fin) ? "Reverse Holofoil" : /^holo$/i.test(fin) ? (/unlimited/i.test(ed) ? "Unlimited Holofoil" : "Holofoil") : /non/i.test(fin) ? "Normal" : "";
  const g = read.graded && read.graded.company ? `${String(read.graded.company).toUpperCase()} ${read.graded.grade || ""}`.trim() : "";
  if (!list.length && errors.length) return res.status(502).json({ error: "The card lookup didn't answer. Try again in a moment.", read });
  res.json({ read, cards: list, print: want, grade: g });
});

// TCGplayer market prices by condition and printing, with up to 1 year of daily history, via JustTCG
// (an independent service). Set JUSTTCG_API_KEY to use it. The free plan allows about 100 requests a day,
// so each search is cached for 24 hours (prices only update about daily) and uses 1 to 3 requests.
const JT_KEY = process.env.JUSTTCG_API_KEY;
const jtCache = new Map();
let jtLeft = null; // requests left today, as last reported by JustTCG
async function jtCards(params) {
  const r = await fetch("https://api.justtcg.com/v1/cards?" + new URLSearchParams(params), {
    headers: { "x-api-key": JT_KEY },
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 429 ? "the daily TCGplayer price limit was reached, try again tomorrow" : r.status === 401 || r.status === 403 ? "the TCGplayer price key was refused, check JUSTTCG_API_KEY in Render" : j.error || `price service returned ${r.status}`);
  const u = j._metadata || j.usage || {};
  if (u.apiDailyRequestsRemaining != null) jtLeft = u.apiDailyRequestsRemaining;
  return j;
}
// "004/102", "4/102" or "4" -> { n: "4", d: "102" }
const splitNum = (x) => {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(String(x || ""));
  if (m) return { n: String(+m[1]), d: String(+m[2]) };
  const k = /(\d+)/.exec(String(x || ""));
  return k ? { n: String(+k[1]), d: null } : null;
};
app.get("/api/tcgmarket", async (req, res) => {
  if (!JT_KEY) return res.status(503).json({ error: "TCGplayer condition prices need JUSTTCG_API_KEY set in Render" });
  const base = String(req.query.q || "").trim().slice(0, 100);
  if (!base) return res.status(400).json({ error: "Missing q" });
  const pq = parseQuery(base);
  // the page may pass the exact card it already identified (name, set, number) so the search is precise
  const hintName = String(req.query.name || "").slice(0, 60).trim();
  const hintSet = norm(String(req.query.set || "").slice(0, 80));
  const num = req.query.n ? { n: String(+req.query.n), d: req.query.d ? String(+req.query.d) : null } : pq.num;
  const tid = String(req.query.tid || "").replace(/\D/g, "").slice(0, 12);
  const key = [base, hintName, hintSet, num?.n, num?.d, tid].join("|").toLowerCase();
  const hit = jtCache.get(key);
  if (hit && hit.exp > Date.now()) return res.json({ ...hit.data, left: jtLeft });
  const saved = await kv.get("jt:" + key);
  if (saved && saved.exp > Date.now()) { jtCache.set(key, saved); return res.json({ ...saved.data, left: jtLeft }); }
  const tokens = norm(pq.search.replace(/\d{1,3}\s*\/\s*\d{1,3}/, " ")).split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w && !STOP.has(w) && !NAME_SKIP.has(w) && !/^\d+$/.test(w));
  const attempts = [...new Set([hintName, tokens.join(" "), tokens[0]].map((x) => (x || "").trim()).filter(Boolean))].slice(0, 2);
  const numOk = (c) => {
    if (!num) return false;
    const c2 = splitNum(c.number);
    return !!c2 && c2.n === num.n && (!num.d || !c2.d || c2.d === num.d);
  };
  try {
    let found = [], exactId = null;
    // the exact TCGplayer product when the page knows it (a portfolio card, a scanned card, a picked suggestion):
    // the Shadowless, 1st Edition or regular printing of a card share a name and number, so a search can pick the wrong one
    if (tid) {
      try { const j = await jtCards({ tcgplayerId: tid, include_price_history: "true", priceHistoryDuration: "1y" }); found = (j.data || []).filter((c) => c && String(c.tcgplayerId || "").replace(/\D/g, "") === tid); } catch (e) { console.error("tcgmarket by id:", e.message); }
      if (found.length) exactId = tid;
    }
    if (!exactId) for (const q of attempts) {
      found = [];
      for (let offset = 0; offset < (num ? 60 : 20); offset += 20) {
        const j = await jtCards({ q, game: "pokemon", include_price_history: "true", priceHistoryDuration: "1y", limit: "20", offset: String(offset) });
        found.push(...(j.data || []));
        if (!num || found.some(numOk) || !(j.meta || j.pagination || {}).hasMore) break;
      }
      if (found.length && (!num || found.some(numOk))) break;
    }
    const words = new Set([...tokens, ...hintSet.split(/[^a-z0-9]+/)].filter(Boolean)); // "Base Set (Shadowless)" -> base, set, shadowless
    const setScore = (c) => norm(c.set_name || c.set || "").split(/[^a-z0-9]+/).filter((w) => words.has(w)).length;
    const seen = new Set();
    const cards = found
      .filter((c) => c && c.id && !seen.has(c.id) && seen.add(c.id))
      .map((c, i) => ({ c, i, exact: numOk(c) || (!!tid && String(c.tcgplayerId || "").replace(/\D/g, "") === tid), same: !!tid && String(c.tcgplayerId || "").replace(/\D/g, "") === tid, s: setScore(c) }))
      .sort((a, b) => Number(b.same) - Number(a.same) || Number(b.exact) - Number(a.exact) || b.s - a.s || a.i - b.i)
      .slice(0, 12)
      .map(({ c, exact }, k) => ({
        id: c.id,
        name: c.name,
        set: c.set_name || c.set,
        number: c.number,
        rarity: c.rarity,
        exact,
        tcgId: c.tcgplayerId ? String(c.tcgplayerId).replace(/\D/g, "") : null,
        tcgUrl: c.tcgplayerId ? `https://www.tcgplayer.com/product/${encodeURIComponent(c.tcgplayerId)}` : null,
        variants: (c.variants || []).filter((v) => v.price != null || (v.priceHistory || []).length).map((v) => ({
          cond: v.condition,
          print: v.printing || "Normal",
          lang: v.language || "English",
          price: v.price,
          ch7: v.priceChange7d ?? null,
          ch30: v.priceChange30d ?? null,
          updated: v.lastUpdated || null,
          // full history only for the first few cards, to keep the response small
          hist: k < 4 ? (v.priceHistory || []).filter((h) => h && h.p != null).map((h) => [h.t, h.p]) : [],
        })),
      }));
    const data = { cards };
    const entry = { exp: Date.now() + 24 * 3600e3, data };
    jtCache.set(key, entry);
    await kv.set("jt:" + key, entry, 24 * 3600);
    res.json({ ...data, left: jtLeft });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

// TCGplayer individual sold sales and live listings for one product, by condition and printing.
// These come from the same endpoints TCGplayer's own product page uses. They are not an official,
// documented API, so they can change or start refusing requests without notice; the page then says so.
// Every sale seen is saved (like eBay sold sales) so history builds past what TCGplayer shows at once.
const TP_HEAD = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  Origin: "https://www.tcgplayer.com",
  Referer: "https://www.tcgplayer.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
};
const TP_SALES_PAGES = Math.max(1, Number(process.env.TCG_SALES_PAGES) || 8); // 25 sales per page
const TP_LIST_PAGES = Math.max(1, Number(process.env.TCG_LISTING_PAGES) || 4); // 50 listings per page
// Optional: the sign-in cookie of a TCGplayer account made just for this app, so the sales feed returns more
// than the few sales it gives to visitors who aren't signed in. Paste either the whole Cookie header or just the
// value of TCGAuthTicket_Production into TCGPLAYER_COOKIE in Render. It is only sent to TCGplayer, never logged.
const TP_COOKIE_RAW = (process.env.TCGPLAYER_COOKIE || "").trim();
const TP_COOKIE = TP_COOKIE_RAW && !TP_COOKIE_RAW.includes("=") ? `TCGAuthTicket_Production=${TP_COOKIE_RAW}` : TP_COOKIE_RAW;
if (TP_COOKIE) console.log("TCGplayer sign-in cookie: set");
async function tpPost(url, body, signedIn) {
  const r = await fetch(url, { method: "POST", headers: signedIn && TP_COOKIE ? { ...TP_HEAD, Cookie: TP_COOKIE } : TP_HEAD, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(r.status === 403 || r.status === 429 ? "TCGplayer is refusing requests from the server right now" : `TCGplayer returned ${r.status}`);
  return j;
}
async function tpSales(id) {
  const out = [];
  for (let p = 0; p < TP_SALES_PAGES; p++) {
    const j = await tpPost(`https://mpapi.tcgplayer.com/v2/product/${id}/latestsales`, { conditions: [], languages: [], variants: [], listingType: "All", offset: p * 25, limit: 25 }, true);
    const d = j.data || [];
    for (const s of d) {
      const price = Number(s.purchasePrice), date = new Date(s.orderDate);
      if (!(price > 0) || isNaN(date)) continue;
      out.push({
        price, ship: s.shippingPrice != null ? Number(s.shippingPrice) : null, date: date.toISOString(),
        cond: s.condition || "", print: s.variant || "", lang: s.language || "", qty: Number(s.quantity) || 1,
        title: s.title || "", lt: s.listingType || "",
      });
    }
    if (d.length < 25 || j.nextPage === "" || j.nextPage === false) break;
  }
  return out;
}
async function tpListings(id) {
  const out = [];
  for (let p = 0; p < TP_LIST_PAGES; p++) {
    const j = await tpPost(`https://mp-search-api.tcgplayer.com/v1/product/${id}/listings`, {
      filters: { term: { sellerStatus: "Live", channelId: 0 }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } },
      from: p * 50, size: 50, sort: { field: "price+shipping", order: "asc" }, context: { shippingCountry: "US", cart: {} }, aggregations: ["listingType"],
    });
    const blk = (j.results || [])[0] || {}, rs = blk.results || [];
    for (const l of rs) {
      const price = Number(l.price);
      if (!(price > 0)) continue;
      out.push({
        price, ship: l.shippingPrice != null ? Number(l.shippingPrice) : null,
        cond: l.condition || "", print: l.printing || "", lang: l.language || "", qty: Number(l.quantity) || 1,
        seller: l.sellerName || "", direct: !!l.directProduct, title: l.customData?.title || "", lt: l.listingType || "",
      });
    }
    if (rs.length < 50 || (blk.totalResults != null && (p + 1) * 50 >= blk.totalResults)) break;
  }
  return out;
}
// Sales grouped by week (lowest and highest sale, number sold) for about a year, per condition and printing:
// the feed behind the price-history chart on TCGplayer's product page, which works without signing in.
async function tpHistory(id) {
  const r = await fetch(`https://infinite-api.tcgplayer.com/price/history/${id}/detailed?range=annual`, { headers: TP_HEAD, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(r.status === 403 || r.status === 429 ? "TCGplayer is refusing requests from the server right now" : `TCGplayer returned ${r.status}`);
  const rows = Array.isArray(j) ? j : j.result || j.results || j.data || [];
  const num = (v) => (v == null || v === "" ? null : Number(v));
  return rows.map((s) => {
    const all = (s.buckets || []).map((k) => {
      const t = Date.parse(k.bucketStartDate);
      return [t, num(k.lowSalePrice), num(k.highSalePrice), num(k.quantitySold) || 0, num(k.transactionCount) || 0, num(k.marketPrice), num(k.lowSalePriceWithShipping), num(k.highSalePriceWithShipping)];
    }).filter((k) => !isNaN(k[0]));
    // TCGplayer lists a market price for each condition and printing every week, whether or not it sold:
    // mk/mt is the latest one. b keeps only the weeks with sales (for the sales chart).
    const lm = all.filter((k) => k[5] > 0).sort((x, y) => x[0] - y[0]).pop();
    return { cond: s.condition || "", print: s.variant || s.printing || "", lang: s.language || "", mk: lm ? lm[5] : null, mt: lm ? lm[0] : null,
      b: all.filter((k) => k[4] > 0 && k[1] > 0) };
  }).filter((s) => s.b.length || s.mk > 0);
}
// One card's TCGplayer market price for a given condition and printing (the latest week's market price from
// TCGplayer's price history), for the Portfolio list. Each product's history is remembered for 24 hours.
const tphCache = new Map();
const tpCond = (c) => { c = String(c || "").toLowerCase(); return c.startsWith("near mint") ? "Near Mint" : c.startsWith("lightly") ? "Lightly Played" : c.startsWith("moderately") ? "Moderately Played" : c.startsWith("heavily") ? "Heavily Played" : c.startsWith("damaged") ? "Damaged" : ""; };
const COND_STEP = { "Near Mint": 1, "Lightly Played": 0.85, "Moderately Played": 0.7, "Heavily Played": 0.55, "Damaged": 0.4 };
async function tpLatest(id) {
  let rows = tphCache.get(id);
  if (!rows || rows.exp < Date.now()) {
    const saved = await kv.get("tph2:" + id);
    if (saved) rows = { exp: Date.now() + 864e5, list: saved };
    else {
      const hist = await tpHistory(id);
      // the latest listed market price for each condition and printing
      const list = hist.map((s) => s.mk > 0 ? { cond: tpCond(s.cond), print: String(s.print || ""), lang: String(s.lang || ""), m: s.mk, t: s.mt } : null).filter(Boolean);
      rows = { exp: Date.now() + 864e5, list }; await kv.set("tph2:" + id, list, 864e2);
    }
    tphCache.set(id, rows); if (tphCache.size > 5000) tphCache.delete(tphCache.keys().next().value);
  }
  return rows.list;
}
// The printings TCGplayer lists for a product (Holofoil, Reverse Holofoil, 1st Edition Holofoil...), for the portfolio's
// Edit form. Read from the product's price history, remembered for 24 hours.
app.get("/api/tcgprints", async (req, res) => {
  const id = String(req.query.id || "").replace(/\D/g, "").slice(0, 12);
  if (!id) return res.status(400).json({ error: "Missing TCGplayer product id" });
  try {
    const ORDER = ["normal", "holofoil", "reverse holofoil", "1st edition", "1st edition holofoil", "unlimited", "unlimited holofoil"];
    const rank = (p) => { const i = ORDER.indexOf(p.toLowerCase()); return i < 0 ? 99 : i; };
    const prints = [...new Set((await tpLatest(id)).map((r) => r.print).filter(Boolean))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    res.json({ prints });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/tcgprice", async (req, res) => {
  const id = String(req.query.id || "").replace(/\D/g, "").slice(0, 12);
  if (!id) return res.status(400).json({ error: "Missing TCGplayer product id" });
  const cond = tpCond(req.query.cond) || "Near Mint", print = String(req.query.print || "").toLowerCase().trim(), jp = req.query.jp === "1";
  try {
    const rows = { list: await tpLatest(id) };
    const langOk = (r) => !r.lang || (jp ? /japan/i.test(r.lang) : /english/i.test(r.lang));
    let pool = rows.list.filter(langOk); if (!pool.length) pool = rows.list;
    const prints = [...new Set(pool.map((r) => r.print.toLowerCase()))];
    // the card's printing when TCGplayer has it; otherwise the printing with a Near Mint price (or any)
    let use = print && prints.includes(print) ? print : null;
    if (!use) use = (pool.find((r) => r.cond === "Near Mint") || pool[0] || {}).print?.toLowerCase() ?? null;
    const same = pool.filter((r) => r.print.toLowerCase() === use);
    const exact = same.find((r) => r.cond === cond);
    if (exact) return res.json({ market: exact.m, cond, print: exact.print, est: false });
    // no sales in this condition: estimate from Near Mint with the usual condition discount
    const nm = same.find((r) => r.cond === "Near Mint");
    if (nm) return res.json({ market: +(nm.m * COND_STEP[cond]).toFixed(2), cond, print: nm.print, est: true });
    // sealed products are listed as "Unopened" rather than a card condition
    const sealed = same.find((r) => !r.cond) || pool.find((r) => !r.cond);
    if (sealed) return res.json({ market: sealed.m, cond: "Unopened", print: sealed.print, est: false });
    // no Near Mint sales either: estimate from the nearest condition that sold, in the same printing
    const near = same.filter((r) => COND_STEP[r.cond]).sort((a, b) => Math.abs(COND_STEP[a.cond] - COND_STEP[cond]) - Math.abs(COND_STEP[b.cond] - COND_STEP[cond]))[0];
    if (near) return res.json({ market: +(near.m * COND_STEP[cond] / COND_STEP[near.cond]).toFixed(2), cond, print: near.print, est: true, from: near.cond });
    res.json({ market: null, cond, print: null, est: false, why: pool.length ? "no TCGplayer sales for this printing" : "no TCGplayer sales in the past year" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
const tpCache = new Map();
app.get("/api/tcgplayer", async (req, res) => {
  const id = String(req.query.id || "").replace(/\D/g, "").slice(0, 12);
  if (!id) return res.status(400).json({ error: "Missing TCGplayer product id" });
  const hit = tpCache.get(id);
  if (hit && hit.exp > Date.now()) return res.json(hit.data);
  const warnings = [];
  const [s, l, hi] = await Promise.all([
    tpSales(id).catch((e) => (console.error("tcg sales:", e.message), warnings.push("Sold sales unavailable: " + e.message), null)),
    tpListings(id).catch((e) => (console.error("tcg listings:", e.message), warnings.push("Live listings unavailable: " + e.message), null)),
    tpHistory(id).catch((e) => (console.error("tcg history:", e.message), warnings.push("Weekly sales history unavailable: " + e.message), null)),
  ]);
  const key = "tcgsold:" + id;
  const bucket = await bucketFor(key);
  for (const x of s || []) bucket[[x.date, x.price, x.cond, x.print, x.lang, x.qty].join("|")] = x;
  for (const [k, x] of Object.entries(bucket)) if (Date.now() - new Date(x.date) > YEAR) delete bucket[k];
  if (s && s.length) await saveBucket(key);
  if (TP_COOKIE && s && s.length > 0 && s.length <= 5) warnings.push("Only a few recent sales came back even with the TCGplayer sign-in cookie, so it may have expired; copy a fresh one into TCGPLAYER_COOKIE in Render.");
  const sold = Object.values(bucket);
  if (!sold.length && !l && !hi) return res.status(502).json({ error: warnings.join(" ") });
  const data = { sold, listings: l || [], hist: hi || [], recent: s ? s.length : 0, warnings, url: `https://www.tcgplayer.com/product/${id}` };
  // a failed lookup is retried after 5 minutes instead of the usual cache time
  tpCache.set(id, { exp: Date.now() + (s && l ? LISTINGS_CACHE_MIN : 5) * 60000, data });
  res.json(data);
});

// Card pictures for the Portfolio tab. Collectr's catalog comes from TCGplayer, so each card is looked up in
// TCGplayer's own search (covers raw, Japanese, sealed, Yu-Gi-Oh!, One Piece, Magic), and its product image is used.
// Pokémon cards fall back to pokemontcg.io if TCGplayer doesn't answer. Found pictures are remembered for 30 days
// (in the Upstash database when set), and misses for 1 day, so each card is only looked up once.
const imgCache = new Map();
const imgWords = (t) => norm(t).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !["the", "of", "and", "pokemon", "tcg"].includes(w));
const sameWords = (a, b) => { const A = imgWords(a), B = new Set(imgWords(b)); if (!A.length || !B.size) return 0; return A.filter((w) => B.has(w)).length / Math.max(A.length, B.size); };
const cardNo = (n) => { const m = /^\s*([a-z]*)0*(\d+)([a-z]*)/i.exec(String(n || "").split("/")[0]); return m ? (m[1] + m[2] + m[3]).toLowerCase() : String(n || "").toLowerCase().trim(); };
const TP_LINES = { pokemon: null, yugioh: "yugioh", "one piece": "one-piece-card-game", "magic: the gathering": "magic" };
async function imgFromTcgplayer(name, set, num, cat) {
  const line = TP_LINES[String(cat || "").toLowerCase()];
  const j = await tpPost("https://mp-search-api.tcgplayer.com/v1/search/request?" + new URLSearchParams({ q: `${name} ${set}`.slice(0, 120), isList: "false" }), {
    algorithm: "sales_synonym_v2", from: 0, size: 24,
    filters: { term: line ? { productLineName: [line] } : {}, range: {}, match: {} },
    listingSearch: { context: { cart: {} }, filters: { term: { sellerStatus: "Live", channelId: 0 }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } } },
    context: { cart: {}, shippingCountry: "US", userProfile: {} }, settings: { useFuzzySearch: true, didYouMean: {} }, sort: {},
  });
  const rs = ((j.results || [])[0] || {}).results || [];
  let best = null, bs = 0;
  for (const r of rs) {
    const id = String(Math.round(Number(r.productId) || 0)); if (id === "0") continue;
    const rn = r.customAttributes?.number || (/\s-\s([\w/]+)$/.exec(r.productName || "") || [])[1] || "";
    let sc = sameWords(set, r.setName || "") * 4 + sameWords(name, String(r.productName || "").replace(/\s-\s[\w/]+$/, "")) * 3;
    if (num && rn) sc += cardNo(rn) === cardNo(num) ? 4 : -2;
    if (!line && !/pokemon/i.test(r.productLineName || "pokemon")) sc -= 3;
    if (sc > bs) { bs = sc; best = { id, set: r.setName, market: Number(r.marketPrice) > 0 ? Number(r.marketPrice) : null }; }
  }
  return best && bs >= 3 ? { img: `https://tcgplayer-cdn.tcgplayer.com/product/${best.id}_200w.jpg`, big: `https://tcgplayer-cdn.tcgplayer.com/product/${best.id}_400w.jpg`, tcgId: best.id, market: best.market } : null;
}
async function imgFromPokemonTcg(name, set, num) {
  const clean = name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/["\\]/g, "").trim(); if (!clean) return null;
  const n = cardNo(num);
  const q = [`name:"${clean}"`, ...(n ? [`number:${n}`] : [])].join(" ");
  const r = await fetch("https://api.pokemontcg.io/v2/cards?" + new URLSearchParams({ q, pageSize: "40", select: "id,name,number,set,images,tcgplayer" }), { headers: PTCG_KEY ? { "X-Api-Key": PTCG_KEY } : {}, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("pokemontcg.io returned " + r.status);
  const cards = (await r.json()).data || [];
  let best = null, bs = -1;
  for (const c of cards) { const sc = sameWords(set, c.set?.name || "") + (cardNo(c.number) === n ? 1 : 0); if (sc > bs) { bs = sc; best = c; } }
  const mk = best && Object.values(best.tcgplayer?.prices || {}).map((p) => p.market).find((v) => v > 0);
  return best && (bs > 0.3 || cards.length === 1) ? { img: best.images?.small, big: best.images?.large, tcgId: null, market: mk || null } : null;
}
app.get("/api/cardimg", async (req, res) => {
  const name = String(req.query.name || "").trim().slice(0, 100), set = String(req.query.set || "").trim().slice(0, 100);
  const num = String(req.query.num || "").trim().slice(0, 20), cat = String(req.query.cat || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "Missing name" });
  const key = "img:" + [cat, set, name, num].map((x) => norm(x)).join("|");
  const hit = imgCache.get(key) || (await kv.get(key));
  if (hit) return imgCache.set(key, hit), res.json(hit);
  let found = null;
  try { found = await imgFromTcgplayer(name, set, num, cat); } catch (e) { console.error("card picture (TCGplayer):", e.message); }
  if (!found && /pokemon/i.test(cat || "pokemon")) { try { found = await imgFromPokemonTcg(name, set, num); } catch (e) { console.error("card picture (pokemontcg):", e.message); } }
  const out = found || { img: null };
  imgCache.set(key, out); if (imgCache.size > 5000) imgCache.delete(imgCache.keys().next().value);
  await kv.set(key, out, found ? 30 * 864e2 : 864e2);
  res.json(out);
});

// Hand-off codes: a Collectr import read in Safari can be picked up in the home-screen app (which keeps its own,
// separate storage). The cards wait here for 30 minutes under a short code and are deleted once picked up.
const handoffs = new Map();
app.post("/api/handoff", express.json({ limit: "8mb" }), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20000) : null;
  if (!items || !items.length) return res.status(400).json({ error: "No cards to hand off" });
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let code = "";
  for (let i = 0; i < 6; i++) code += abc[crypto.randomInt(abc.length)];
  const data = { items, made: Date.now() };
  handoffs.set(code, data); setTimeout(() => handoffs.delete(code), 30 * 60e3).unref?.();
  await kv.set("handoff:" + code, data, 30 * 60);
  res.json({ code });
});
// The Collectr bookmark sends the cards here with an ordinary form submit (from the showcase tab itself), and the
// browser is sent straight on to Price Plot with a code that picks them up.
// Hidden: sold-lookup usage this month (CompsAPI), not linked anywhere in the app. Open /api/usage to see it.
app.get("/api/usage", async (req, res) => {
  if (kv.on && !usageLoaded) { usage = (await kv.get("usage")) || usage; usageLoaded = true; }
  if (!compsLog.length) { const saved = await kv.get("compslog"); if (Array.isArray(saved)) compsLog.push(...saved); }
  // CompsAPI's own count of this month's requests (doesn't use a request)
  const qt0 = await compsQuota(true), service = qt0 ? qt0.raw : COMPS_KEY ? { error: "CompsAPI didn't answer" } : null;
  // ?test=card search: one live lookup (uses 1 sold lookup), showing exactly what came back and what Price Plot keeps
  let test;
  const tq = String(req.query.test || "").trim().slice(0, 100);
  if (tq && COMPS_KEY) {
    if (!(await useRequest())) test = { error: "monthly limit reached" };
    else try {
      const pq = parseQuery(tq), { r, j, text } = await compsGet({ q: pq.search, days: COMPS_DAYS, size: 240, page: 1 });
      const items = (j && j.items) || [];
      test = { q: pq.search, status: r.status, count: j ? j.count ?? items.length : null, returned: items.length, matchCard: items.filter((i) => relevant(i.title || "", pq, tq)).length,
        nextPage: j ? j.next_page ?? null : null, error: r.ok ? undefined : text.slice(0, 300),
        first: items.slice(0, 8).map((i) => ({ title: i.title, price: i.price, sold: i.last_sold, kept: relevant(i.title || "", pq, tq) })) };
      logComps({ q: pq.search, page: 1, days: COMPS_DAYS, status: r.status, count: test.count, test: true });
    } catch (e) { test = { error: e.message }; }
  }
  const month = new Date().toISOString().slice(0, 7), own = usage.month === month ? usage.n || 0 : 0;
  const qt = await compsQuota(), used = qt ? qt.used : own, limit = qt ? qt.limit : COMPS_LIMIT;
  const next = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
  res.set("Cache-Control", "no-store").json({
    soldLookupsLeft: COMPS_KEY ? Math.max(0, limit - used) : null,
    soldLookupsUsed: used,
    monthlyLimit: limit,
    plan: qt ? qt.plan : undefined,
    countFrom: qt ? "CompsAPI" : "Price Plot's own counter (CompsAPI didn't answer)",
    priceplotCounted: own,
    month,
    resets: next.toISOString(),
    soldSource: COMPS_KEY ? "CompsAPI" : ENABLE_SOLD === "true" ? "eBay Marketplace Insights (no monthly counter)" : "none set up",
    counterSaved: kv.on ? "Upstash database (survives restarts)" : "local file (resets when Render restarts)",
    ...(test ? { test } : {}),
    compsApiSays: service,
    recentLookups: compsLog.slice(0, 15),
    note: "Price Plot's own count of requests it sent; a request is used for each new search (up to " + COMPS_MAX_PAGES + " for a card's first search), and repeat searches within " + COMPS_REFRESH_MS / 3600e3 + " hours are free.",
  });
});
app.get("/api/ping", (req, res) => { res.set("Cache-Control", "no-store"); res.type("gif").send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")); });
// reloading the hand-off page can't resend the cards; send the person to Price Plot with a note instead
app.get("/api/collectr-handoff", (req, res) => res.redirect(303, "/#ci=bad"));
app.post("/api/collectr-handoff", express.urlencoded({ extended: false, limit: "25mb" }), async (req, res) => {
  let raw; try { raw = JSON.parse(String(req.body?.data || "")); } catch { return res.redirect(303, "/#ci=bad"); }
  if (!raw || raw.type !== "collectr-import") return res.redirect(303, "/#ci=bad");
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let code = "";
  for (let i = 0; i < 6; i++) code += abc[crypto.randomInt(abc.length)];
  const data = { raw, made: Date.now() };
  handoffs.set(code, data); setTimeout(() => handoffs.delete(code), 30 * 60e3).unref?.();
  await kv.set("handoff:" + code, data, 30 * 60);
  res.redirect(303, "/#ci=" + code);
});
app.get("/api/handoff/:code", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const data = handoffs.get(code) || (await kv.get("handoff:" + code));
  if (!data) return res.status(404).json({ error: "That code wasn't found or has expired (codes last 30 minutes)" });
  handoffs.delete(code); if (kv.on) kv.cmd(["DEL", "pp:handoff:" + code]).catch(() => {});
  res.json(data);
});

// eBay "Marketplace Account Deletion" notifications (required to keep your keys enabled).
// This app stores no eBay user data, so there is nothing to delete: we only answer eBay's
// challenge and acknowledge notifications.
const VERIFY = process.env.EBAY_VERIFICATION_TOKEN;
const ENDPOINT = process.env.EBAY_ENDPOINT_URL; // e.g. https://your-app.onrender.com/ebay/deletion
app.get("/ebay/deletion", (req, res) => {
  const code = String(req.query.challenge_code || "");
  if (!code || !VERIFY || !ENDPOINT) return res.status(400).json({ error: "Not configured" });
  const challengeResponse = crypto.createHash("sha256").update(code).update(VERIFY).update(ENDPOINT).digest("hex");
  res.status(200).json({ challengeResponse });
});
app.post("/ebay/deletion", (req, res) => res.sendStatus(200));

app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
