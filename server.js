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
async function useRequest() {
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
let compsNote = "";
const pulled = {};
async function collectComps(q) {
  const bucket = await bucketFor(q);
  if (pulled[q] == null) pulled[q] = (await kv.get("pulled:" + q)) || 0;
  if (pulled[q] && Date.now() - pulled[q] < COMPS_REFRESH_MS) return Object.values(bucket);
  const pages = Object.keys(bucket).length ? 1 : COMPS_MAX_PAGES;
  let days = COMPS_DAYS;
  for (let page = 1; page <= pages; page++) {
    if (!(await useRequest())) {
      if (page === 1) throw new Error("monthly sold-data request limit reached, showing saved sales");
      break;
    }
    const get = (d) =>
      fetch(
        "https://api.compsapi.com/v1/sold?" +
          new URLSearchParams({ q, days: d, size: 240, page, ...(CATEGORY ? { category: CATEGORY } : {}) }),
        { headers: { "X-API-Key": COMPS_KEY, "User-Agent": "price-plot/0.1" } }
      );
    let r = await get(days);
    // the free plan is documented as 1 year of history; if it refuses a longer window, retry with 365 days
    if (!r.ok && days > 365 && [400, 402, 403, 422].includes(r.status)) {
      days = 365;
      compsNote = "Your sold-data plan seems to allow only 1 year of history, so sold sales are limited to that.";
      r = await get(days);
    }
    if (!r.ok) throw new Error(r.status === 429 ? "sold-data service is rate limiting, try again soon" : `sold-data service returned ${r.status}`);
    const j = await r.json();
    for (const i of j.items || []) {
      const price = Number(i.price), date = new Date(i.last_sold);
      if (!(price > 0) || isNaN(date) || !i.url) continue;
      bucket[i.item_id || i.url] = { type: "Sold", price, date: date.toISOString(), title: i.title || "", url: i.url };
    }
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
  const search = parts.filter((w) => !(w.length > 1 && w[0] === "-")).join(" ");
  let num = null;
  const rest = search.replace(/(\d{1,3})\s*\/\s*(\d{1,3})/, (_, n, d) => ((num = { n: String(+n), d: String(+d) }), " "));
  const words = norm(rest).split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w && !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
  return { search, ex, num, words };
}

// true when the listing looks like the card being searched for
function relevant(title, pq, rawQuery) {
  const t = norm(title);
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
    cache.set(key, { exp: Date.now() + LISTINGS_CACHE_MIN * 60000, data });
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
  try {
    let cards = [];
    // try the whole name first, then drop words from the end until something matches
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
  const key = [base, hintName, hintSet, num?.n, num?.d].join("|").toLowerCase();
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
    let found = [];
    for (const q of attempts) {
      found = [];
      for (let offset = 0; offset < (num ? 60 : 20); offset += 20) {
        const j = await jtCards({ q, game: "pokemon", include_price_history: "true", priceHistoryDuration: "1y", limit: "20", offset: String(offset) });
        found.push(...(j.data || []));
        if (!num || found.some(numOk) || !(j.meta || j.pagination || {}).hasMore) break;
      }
      if (found.length && (!num || found.some(numOk))) break;
    }
    const words = new Set([...tokens, ...hintSet.split(/\s+/)].filter(Boolean));
    const setScore = (c) => norm(c.set_name || c.set || "").split(/[^a-z0-9]+/).filter((w) => words.has(w)).length;
    const seen = new Set();
    const cards = found
      .filter((c) => c && c.id && !seen.has(c.id) && seen.add(c.id))
      .map((c, i) => ({ c, i, exact: numOk(c), s: setScore(c) }))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.s - a.s || a.i - b.i)
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
  return rows.map((s) => ({
    cond: s.condition || "", print: s.variant || s.printing || "", lang: s.language || "",
    b: (s.buckets || []).map((k) => {
      const t = Date.parse(k.bucketStartDate);
      return [t, num(k.lowSalePrice), num(k.highSalePrice), num(k.quantitySold) || 0, num(k.transactionCount) || 0, num(k.marketPrice), num(k.lowSalePriceWithShipping), num(k.highSalePriceWithShipping)];
    }).filter((k) => !isNaN(k[0]) && k[4] > 0 && k[1] > 0),
  })).filter((s) => s.b.length);
}
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
    if (sc > bs) { bs = sc; best = { id, set: r.setName }; }
  }
  return best && bs >= 3 ? { img: `https://tcgplayer-cdn.tcgplayer.com/product/${best.id}_200w.jpg`, big: `https://tcgplayer-cdn.tcgplayer.com/product/${best.id}_400w.jpg`, tcgId: best.id } : null;
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
  return best && (bs > 0.3 || cards.length === 1) ? { img: best.images?.small, big: best.images?.large, tcgId: null } : null;
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

// TEMPORARY: finds where Collectr's showcase page loads its card list from, by reading the page's own public
// script files and listing the web addresses in them. Open /api/debug/collectr-finder?id=<showcase id> once,
// copy the result, then this route can be removed.
app.get("/api/debug/collectr-finder", async (req, res) => {
  const id = String(req.query.id || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return res.status(400).json({ error: "Add ?id= with the long code from the end of a Collectr showcase link" });
  const UA = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", Accept: "text/html,*/*" };
  const base = "https://app.getcollectr.com";
  try {
    const r = await fetch(`${base}/showcase/profile/${id}`, { headers: UA, signal: AbortSignal.timeout(20000) });
    const html = await r.text();
    const scripts = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]
      .map((u) => (u.startsWith("/") ? base + u : u)).filter((u) => /^https:\/\/([a-z0-9-]+\.)*getcollectr\.com\//i.test(u)).slice(0, 60);
    const urls = new Map(), paths = new Map();
    const scan = (txt, from) => {
      for (const m of txt.matchAll(/https?:\/\/[a-z0-9.-]*(?:getcollectr|collectr)[a-z0-9.-]*\.[a-z]{2,}[^"'`\s\\)]{0,120}/gi)) if (!urls.has(m[0])) urls.set(m[0], from);
      for (const m of txt.matchAll(/["'`](\/?(?:api\/|v\d\/)?[a-z0-9_\-/]*(?:showcase|portfolio|profile|collection|products|user)[a-z0-9_\-/${}.?=&]*)["'`]/gi)) {
        const k = m[1]; if (k.length < 4 || k.length > 140 || paths.has(k)) continue;
        const i = m.index; paths.set(k, { from, near: txt.slice(Math.max(0, i - 70), i + k.length + 70).replace(/\s+/g, " ") });
      }
    };
    scan(html, "page");
    const nextData = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    for (const u of scripts) {
      try { const t = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) })).text(); scan(t, u.split("/").pop()); } catch {}
    }
    // step 2: the code around the clues, and a few test reads of the data server with this showcase id
    const want = [/x-collectr-username/g, /replace\(encodeURIComponent\("\{username\}"\)/g, /\/collections\/\{username\}\/products\?/g, /api-v2\.getcollectr\.com/g, /showcase_profile_page/g, /anonUsername/g];
    const snips = [];
    if (req.query.more) for (const u of scripts) {
      let t = ""; try { t = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) })).text(); } catch { continue; }
      for (const re of want) for (const m of t.matchAll(re)) { if (snips.length < 24) snips.push({ file: u.split("/").pop(), find: re.source.slice(0, 30), code: t.slice(Math.max(0, m.index - 600), m.index + 700) }); }
    }
    const probes = [];
    if (req.query.more) {
      const api = "https://api-v2.getcollectr.com", tries = [
        [`/collections/${id}/products?offset=0&limit=5`, {}],
        [`/collections/${id}/products?offset=0&limit=5`, { "x-collectr-username": id }],
        [`/collections/${id}/products?offset=0&limit=5&unstackedView=false&currency=USD`, { "x-collectr-username": id }],
        [`/collections/${id}/overview?days=all&currency=USD`, { "x-collectr-username": id }],
      ];
      for (const [path, h] of tries) {
        try { const pr = await fetch(api + path, { headers: { ...UA, Accept: "application/json", Origin: base, Referer: base + "/", ...h }, signal: AbortSignal.timeout(15000) });
          probes.push({ path, header: Object.keys(h).join(",") || "none", status: pr.status, body: (await pr.text()).slice(0, 1500) }); }
        catch (e) { probes.push({ path, error: e.message }); }
      }
    }
    if (req.query.more) return res.json({ probes, snips });
    res.json({
      pageStatus: r.status, pageSize: html.length, scriptsRead: scripts.length, hasNextData: !!nextData,
      nextDataStart: nextData ? nextData[1].slice(0, 600) : null,
      cardWordsInPage: (html.match(/near mint|ungraded|quantity/gi) || []).length,
      addresses: [...urls.keys()].slice(0, 80),
      paths: [...paths.entries()].slice(0, 80).map(([p, v]) => ({ path: p, near: v.near })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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
