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
const MAX_RESULTS = Number(process.env.MAX_RESULTS) || 600; // cap on active listings per search (Browse API allows up to 10,000)
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
let store = {};
try { store = JSON.parse(fs.readFileSync(DB, "utf8")); } catch {}
function save() {
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(store));
}

async function collectSold(q) {
  const bucket = (store[q] ||= {});
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
  save();
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
let usage = {};
try { usage = JSON.parse(fs.readFileSync(USAGE, "utf8")); } catch {}
function useRequest() {
  const month = new Date().toISOString().slice(0, 7);
  if (usage.month !== month) usage = { month, n: 0 };
  if (usage.n >= COMPS_LIMIT) return false;
  usage.n++;
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(USAGE, JSON.stringify(usage));
  return true;
}
const COMPS_DAYS = Math.min(1000, Number(process.env.COMPS_DAYS) || 1000);
let compsNote = "";
const pulled = {};
async function collectComps(q) {
  const bucket = (store[q] ||= {});
  if (pulled[q] && Date.now() - pulled[q] < COMPS_REFRESH_MS) return Object.values(bucket);
  const pages = Object.keys(bucket).length ? 1 : COMPS_MAX_PAGES;
  let days = COMPS_DAYS;
  for (let page = 1; page <= pages; page++) {
    if (!useRequest()) {
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
  for (const [u, x] of Object.entries(bucket)) if (Date.now() - new Date(x.date) > YEAR) delete bucket[u];
  save();
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
const cache = new Map(); // 5 minute cache keeps you well inside eBay rate limits
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
    cache.set(key, { exp: Date.now() + 5 * 60000, data });
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
      const r = await fetch("https://api.pokemontcg.io/v2/cards?" + new URLSearchParams({ q, pageSize: pq.num ? "80" : "250", orderBy: "set.releaseDate", select: "id,name,number,set,images,tcgplayer" }), {
        headers: PTCG_KEY ? { "X-Api-Key": PTCG_KEY } : {},
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`price service returned ${r.status}`);
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
// so each search is cached for 12 hours and uses 1 to 3 requests.
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
    jtCache.set(key, { exp: Date.now() + 12 * 3600e3, data });
    res.json({ ...data, left: jtLeft });
  } catch (e) {
    console.error(e);
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
