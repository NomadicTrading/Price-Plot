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
    if (m) return { grader: g, grade: Number(m[1]) };
    // TAG needs a number, since "TAG TEAM" is a PokÃ©mon card type
    if (g !== "TAG" && new RegExp(`\\b${p}\\b`, "i").test(t)) return { grader: g, grade: null };
  }
  return { grader: null, grade: null };
}

// Sold listings: Marketplace Insights API (restricted; needs eBay approval).
// It only reaches back 90 days, so every sale seen is saved to data/sold.json
// and kept for a year. History past 90 days builds up as the app keeps running.
// Field names follow eBay's docs; untested until you have access.
const DB = "data/sold.json";
const YEAR = 365 * 864e5;
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
const COMPS_DAYS = Math.min(1095, Number(process.env.COMPS_DAYS) || 365);
const pulled = {};
async function collectComps(q) {
  const bucket = (store[q] ||= {});
  if (pulled[q] && Date.now() - pulled[q] < COMPS_REFRESH_MS) return Object.values(bucket);
  const pages = Object.keys(bucket).length ? 1 : COMPS_MAX_PAGES;
  for (let page = 1; page <= pages; page++) {
    if (!useRequest()) {
      if (page === 1) throw new Error("monthly sold-data request limit reached, showing saved sales");
      break;
    }
    const r = await fetch(
      "https://api.compsapi.com/v1/sold?" +
        new URLSearchParams({ q, days: COMPS_DAYS, size: 240, page, ...(CATEGORY ? { category: CATEGORY } : {}) }),
      { headers: { "X-API-Key": COMPS_KEY, "User-Agent": "price-plot/0.1" } }
    );
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
    const listings = [...s, ...a].map(({ bc, ...x }) => {
      const gi = parseGrade(x.title);
      return { ...x, ...gi, cond: gi.grader ? null : parseCond(x.title, bc), rel: relevant(x.title, pq, base) };
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
      const q = [`name:"${tokens.slice(0, k).join(" ")}"`, ...(pq.num ? [`number:${pq.num.n}`, `set.printedTotal:${pq.num.d}`] : [])].join(" ");
      const r = await fetch("https://api.pokemontcg.io/v2/cards?" + new URLSearchParams({ q, pageSize: "8", orderBy: "-set.releaseDate", select: "id,name,number,set,images,tcgplayer" }), {
        headers: PTCG_KEY ? { "X-Api-Key": PTCG_KEY } : {},
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`price service returned ${r.status}`);
      cards = (await r.json()).data || [];
    }
    const data = {
      searchUrl,
      cards: cards.map((c) => ({
        id: c.id, name: c.name, number: c.number, set: c.set?.name, printedTotal: c.set?.printedTotal, released: c.set?.releaseDate,
        image: c.images?.small, tcgUrl: c.tcgplayer?.url, updated: c.tcgplayer?.updatedAt, prices: c.tcgplayer?.prices || {},
      })),
    };
    tcgCache.set(base, { exp: Date.now() + 3600e3, data });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message, searchUrl });
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
