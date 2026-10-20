import "dotenv/config";
import fs from "node:fs";
import express from "express";

const { EBAY_CLIENT_ID: ID, EBAY_CLIENT_SECRET: SECRET, PORT = 3000, ENABLE_SOLD } = process.env;
if (!ID || !SECRET) {
  console.error("Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env (see .env.example)");
  process.exit(1);
}

const API = "https://api.ebay.com";
const MARKET = "EBAY_US";
const CATEGORY = process.env.CATEGORY || ""; // optional eBay category ID; blank searches everything, like eBay's search box
const MAX_RESULTS = Number(process.env.MAX_RESULTS) || 600; // cap on active listings per search (Browse API allows up to 10,000)
const catParam = CATEGORY ? { category_ids: CATEGORY } : {};
const SCOPE_BROWSE = "https://api.ebay.com/oauth/api_scope";
const SCOPE_INSIGHTS = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

const tokens = {};
async function token(scope) {
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
    // TAG needs a number, since "TAG TEAM" is a Pokémon card type
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

// Optional: re-collect sold sales for these searches every 6 hours, so the
// year of history keeps growing even when nobody is searching. Use the exact
// search text, including grader terms (see .env.example).
const WATCH = (process.env.WATCH || "").split("|").map((x) => x.trim()).filter(Boolean);
if (ENABLE_SOLD === "true" && WATCH.length) {
  const run = () => WATCH.forEach((q) => collectSold(q).catch((e) => console.error("watch:", q, e.message)));
  run();
  setInterval(run, 6 * 3600e3);
}

const GRADERS = { PSA: "PSA", BGS: "(BGS,Beckett)", CGC: "CGC", TAG: "TAG" };
const cache = new Map(); // 5 minute cache keeps you well inside eBay rate limits
const app = express();
app.use(express.static("public"));

app.get("/api/listings", async (req, res) => {
  const base = String(req.query.q || "").trim().slice(0, 100);
  if (!base) return res.status(400).json({ error: "Missing q" });
  const g = GRADERS[req.query.grader]; // PSA, BGS, CGC or TAG; anything else adds no grader term
  const q = g ? `${base} ${g}` : base;
  const hit = cache.get(q);
  if (hit && hit.exp > Date.now()) return res.json(hit.data);
  try {
    const warnings = [];
    const [a, s] = await Promise.all([
      active(q),
      ENABLE_SOLD === "true"
        ? collectSold(q).catch((e) => (warnings.push("Sold data unavailable: " + e.message), Object.values(store[q] || {})))
        : [],
    ]);
    const listings = [...s, ...a].map((x) => ({ ...x, ...parseGrade(x.title) }));
    const data = { listings, soldEnabled: ENABLE_SOLD === "true", warnings };
    cache.set(q, { exp: Date.now() + 5 * 60000, data });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
