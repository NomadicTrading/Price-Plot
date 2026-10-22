/* Portfolio: log your collection, track its total value, and import a Collectr export (.csv or .xlsx).
   Everything is saved on this device (localStorage), so it works on Render's free tier with no database.
   Relies on helpers from the main script: $, esc, money, load, tab, tcgQ. */
(() => {
const KEY = "pp_portfolio", HKEY = "pp_portfolio_hist";
const CONDS = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];
const PAGE = 50;
let P = readStore(), view = "all", sortBy = "value", findTxt = "", shown = PAGE, editing = null, pending = null;

function readStore() { try { const x = JSON.parse(localStorage.getItem(KEY) || "null"); return x && Array.isArray(x.items) ? x : { items: [], asOf: null }; } catch { return { items: [], asOf: null }; } }
function store() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch { status("Couldn't save on this device: storage is full."); } }
function hist() { try { const h = JSON.parse(localStorage.getItem(HKEY) || "{}"); return h && typeof h === "object" ? h : {}; } catch { return {}; } }
function snap(date) { const h = hist(); h[date || today()] = Math.round(totals(owned(P.items)).value * 100) / 100; try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch {} }
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const num = (v) => { if (v == null || v === "") return null; if (typeof v === "number") return isFinite(v) ? v : null; const n = parseFloat(String(v).replace(/[$,\s]/g, "")); return isFinite(n) ? n : null; };
const unit = (x) => (x.ovr > 0 ? x.ovr : x.mkt ?? 0);
const owned = (a) => a.filter((x) => x.qty > 0);
const keyOf = (x) => [x.pf, x.cat, x.set, x.name, x.num, x.var, x.grade, x.cond].map((s) => String(s || "").toLowerCase()).join("|");
function totals(a) { let value = 0, cost = 0, costed = 0, n = 0, graded = 0;
  for (const x of a) { value += unit(x) * x.qty; n += x.qty; if (isGraded(x)) graded += x.qty; if (x.cost > 0) { cost += x.cost * x.qty; costed += unit(x) * x.qty; } }
  return { value, cost, costed, n, graded }; }
const isGraded = (x) => !!x.grade && !/^ungraded$/i.test(x.grade);
// "PSA 10.0 GEM - MT" -> "PSA 10"
function shortGrade(g) { const m = /^(PSA|BGS|Beckett|CGC|TAG|SGC|ACE)\s*(\d+(?:\.5)?)/i.exec(g || ""); return m ? m[1].toUpperCase().replace("BECKETT", "BGS") + " " + m[2] : g || ""; }
function status(t) { const s = $("pfs"); if (s) s.textContent = t || ""; }

/* ---------- reading files ---------- */
function parseCSV(t) {
  t = t.replace(/^﻿/, ""); const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}
let xlsxLib = null;
function loadXLSX() { return xlsxLib || (xlsxLib = new Promise((ok, no) => { const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"; s.onload = () => ok(window.XLSX); s.onerror = () => { xlsxLib = null; no(new Error("couldn't load the Excel reader, check your connection")); }; document.head.appendChild(s); })); }
async function readFile(file) {
  if (/\.(xlsx|xls)$/i.test(file.name)) { const X = await loadXLSX(); const wb = X.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" }).filter((r) => r.some((c) => String(c).trim() !== "")); }
  return parseCSV(await file.text());
}
// Collectr's columns (any order). Names are matched loosely so small wording changes still work.
const COLS = { portfolioname: "pf", category: "cat", set: "set", productname: "name", name: "name", cardname: "name", cardnumber: "num", number: "num", rarity: "rarity", variance: "var", printing: "var", grade: "grade", cardcondition: "cond", condition: "cond", averagecostpaid: "cost", costpaid: "cost", quantity: "qty", qty: "qty", priceoverride: "ovr", watchlist: "watch", dateadded: "added", notes: "notes" };
function toItems(rows) {
  if (rows.length < 2) throw new Error("the file has no rows");
  const head = rows[0].map((h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, "")), idx = {};
  let asOf = null;
  head.forEach((h, i) => { if (h.startsWith("marketprice")) { idx.mkt = i; const m = /(\d{4})(\d{2})(\d{2})/.exec(h); if (m) asOf = m[1] + "-" + m[2] + "-" + m[3]; } else if (COLS[h] && idx[COLS[h]] == null) idx[COLS[h]] = i; });
  if (idx.name == null) throw new Error("this doesn't look like a Collectr export (no Product Name column)");
  const g = (r, k) => (idx[k] == null ? "" : r[idx[k]]), s = (r, k) => { const v = g(r, k); return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").trim(); };
  const items = rows.slice(1).map((r) => {
    const name = s(r, "name"); if (!name) return null;
    const notes = s(r, "notes").replace(/^[\s;,.\-]+$/, "");
    return { id: uid(), pf: s(r, "pf"), cat: s(r, "cat"), set: s(r, "set"), name, num: s(r, "num"), rarity: s(r, "rarity"), var: s(r, "var"),
      grade: s(r, "grade"), cond: s(r, "cond"), cost: num(g(r, "cost")) || 0, qty: Math.max(0, Math.round(num(g(r, "qty")) || 0)),
      mkt: num(g(r, "mkt")), ovr: num(g(r, "ovr")) || 0, watch: /^(true|yes|1)$/i.test(s(r, "watch")), added: s(r, "added"), notes };
  }).filter(Boolean);
  if (!items.length) throw new Error("no cards found in the file");
  return { items, asOf };
}

/* ---------- import flow ---------- */
async function onFile(file) {
  status("Reading " + file.name + "…");
  try { pending = toItems(await readFile(file)); pending.file = file.name; }
  catch (e) { pending = null; status("Import failed: " + e.message); return; }
  const o = owned(pending.items), pfs = new Set(o.map((x) => x.pf).filter(Boolean)), w = pending.items.filter((x) => x.watch).length;
  status(""); render();
  $("pfi").innerHTML = `<div><b>Found ${o.reduce((a, x) => a + x.qty, 0).toLocaleString()} cards</b> <span class="mu">(${o.length.toLocaleString()} entries${pfs.size ? " in " + pfs.size + " portfolio" + (pfs.size === 1 ? "" : "s") : ""}${w ? ", " + w + " on your watchlist" : ""}) worth ${money(totals(o).value)}${pending.asOf ? " as of " + pending.asOf : ""}.</span></div>
  <div class="bar">${P.items.length ? `<button class="pill" type="button" data-pa="merge">Add to my portfolio</button><button class="pill" type="button" data-pa="replace">Replace my portfolio</button>` : `<button class="pill on" type="button" data-pa="replace">Import</button>`}<button class="pill" type="button" data-pa="cancel">Cancel</button></div>
  ${P.items.length ? `<div class="sm">“Add” updates cards you already have and adds new ones. “Replace” clears your current portfolio first.</div>` : ""}`;
  $("pfi").hidden = false;
}
function applyImport(how) {
  if (!pending) return;
  if (how === "replace") P.items = pending.items;
  else { const at = new Map(P.items.map((x, i) => [keyOf(x), i])); for (const x of pending.items) { const k = keyOf(x); if (at.has(k)) { const o = P.items[at.get(k)]; P.items[at.get(k)] = { ...x, id: o.id, img: o.img, big: o.big, tcgId: o.tcgId, imgT: o.imgT }; } else { at.set(k, P.items.length); P.items.push(x); } } }
  P.asOf = pending.asOf || today(); P.source = pending.file; store(); snap(P.asOf);
  status(`Imported ${pending.items.length.toLocaleString()} rows from ${pending.file}.`); pending = null; $("pfi").hidden = true; view = "all"; shown = PAGE; render();
}

/* ---------- drawing ---------- */
function filtered() {
  let a = view === "watch" ? P.items.filter((x) => x.watch) : owned(P.items).filter((x) => view === "all" || (x.pf || "Unsorted") === view);
  if (findTxt) { const w = findTxt.toLowerCase().split(/\s+/).filter(Boolean); a = a.filter((x) => { const t = [x.name, x.set, x.num, x.var, x.grade, x.cond, x.rarity, x.cat, x.notes].join(" ").toLowerCase(); return w.every((y) => t.includes(y)); }); }
  const v = (x) => unit(x) * (view === "watch" ? 1 : x.qty);
  const S = { value: (a, b) => v(b) - v(a), low: (a, b) => v(a) - v(b), unit: (a, b) => unit(b) - unit(a), name: (a, b) => a.name.localeCompare(b.name), added: (a, b) => String(b.added).localeCompare(String(a.added)),
    gain: (a, b) => (b.cost > 0 ? (unit(b) - b.cost) * b.qty : -1e9) - (a.cost > 0 ? (unit(a) - a.cost) * a.qty : -1e9) };
  return a.slice().sort(S[sortBy] || S.value);
}
function chart() {
  const h = Object.entries(hist()).sort((a, b) => a[0].localeCompare(b[0]));
  if (h.length < 2) return `<div class="sm">Value history starts now. Each time you import fresh prices (or edit a card), today's total is added here as a point.</div>`;
  const W = 640, H = 150, m = { l: 8, r: 8, t: 12, b: 22 }, xs = h.map(([d]) => Date.parse(d)), ys = h.map(([, v]) => v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.15 || hi * 0.05 || 1;
  const X = (t) => m.l + ((t - x0) / (x1 - x0 || 1)) * (W - m.l - m.r), Y = (v) => m.t + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - m.t - m.b);
  const pts = h.map(([d, v]) => [X(Date.parse(d)), Y(v)]), up = ys[ys.length - 1] >= ys[0];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio value over time"><path d="M${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join("L")}" fill="none" stroke="var(${up ? "--up" : "--dn"})" stroke-width="2.5" stroke-linejoin="round"/>
  ${pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="var(${up ? "--up" : "--dn"})"><title>${h[i][0]}: ${money(h[i][1])}</title></circle>`).join("")}
  <text x="${m.l}" y="${H - 6}" font-size="11" fill="var(--mut)">${h[0][0]}</text><text x="${W - m.r}" y="${H - 6}" font-size="11" fill="var(--mut)" text-anchor="end">${h[h.length - 1][0]}</text></svg>`;
}
function rowHTML(x) {
  const g = isGraded(x), line = view === "watch" ? unit(x) : unit(x) * x.qty, gain = x.cost > 0 && x.qty ? (unit(x) - x.cost) * x.qty : null;
  const meta = [x.set, x.num, x.var && x.var !== "Normal" ? x.var : "", x.cat && x.cat !== "Pokemon" ? x.cat : ""].filter(Boolean).map(esc).join(" · ");
  if (editing === x.id) return `<div class="pr" data-id="${x.id}">${form(x)}</div>`;
  return `<div class="pr" data-id="${x.id}">${thumb(x)}<div class="pm"><b>${esc(x.name)}</b> <span class="cg ${g ? "gr" : ""}">${esc(g ? shortGrade(x.grade) : x.cond || "")}</span>
  <div class="mu">${meta}${view === "all" && x.pf ? ` · <i>${esc(x.pf)}</i>` : ""}</div>
  <div class="mu">${view === "watch" ? "" : x.qty + " × "}${money(unit(x))}${x.ovr > 0 ? ` <span title="Your own price, set in Collectr or here">(your price)</span>` : x.mkt == null ? " (no price)" : ""}${gain != null ? ` · <span style="color:var(${gain >= 0 ? "--up" : "--dn"})">${gain >= 0 ? "+" : "−"}${money(Math.abs(gain))}</span> vs. ${money(x.cost)} paid` : ""}</div>
  ${x.notes ? `<div class="mu">${esc(x.notes)}</div>` : ""}</div>
  <div class="pv"><b>${money(line)}</b><div><button class="pill sm2" type="button" data-cmp="${x.id}">Comp</button><button class="pill sm2" type="button" data-ed="${x.id}">Edit</button></div></div></div>`;
}
function form(x) {
  const f = (k, l, v, t = "text", extra = "") => `<label>${l}<input name="${k}" type="${t}" value="${esc(v ?? "")}" ${extra}></label>`;
  const pfs = [...new Set(P.items.map((y) => y.pf).filter(Boolean))];
  return `<form class="pe" data-fid="${x.id || ""}"><div class="pg">${f("name", "Card name", x.name, "text", "required")}${f("set", "Set", x.set)}${f("num", "Number", x.num)}${f("var", "Printing", x.var)}
  <label>Condition<select name="cond">${CONDS.map((c) => `<option ${c === (x.cond || "Near Mint") ? "selected" : ""}>${c}</option>`).join("")}</select></label>
  ${f("grade", "Grade (blank if raw)", isGraded(x) ? x.grade : "", "text", 'placeholder="e.g. PSA 10"')}
  ${f("qty", "Quantity", x.qty ?? 1, "number", 'min="0" step="1" inputmode="numeric"')}${f("cost", "Paid each ($)", x.cost || "", "number", 'min="0" step="0.01" inputmode="decimal"')}
  ${f("ovr", "Your price each ($)", x.ovr || "", "number", `min="0" step="0.01" inputmode="decimal" placeholder="${x.mkt != null ? "Market " + money(x.mkt) : "Value per card"}"`)}
  <label>Portfolio<input name="pf" list="pfl" value="${esc(x.pf || (view !== "all" && view !== "watch" ? view : ""))}"><datalist id="pfl">${pfs.map((p) => `<option value="${esc(p)}">`).join("")}</datalist></label>
  ${f("notes", "Notes", x.notes)}</div>
  <div class="bar"><button class="pill on" type="submit">Save</button><button class="pill" type="button" data-cx="1">Cancel</button>${x.id ? `<button class="pill dl" type="button" data-del="${x.id}">Delete</button>` : ""}</div>
  <div class="sm">Leave “Your price” blank to use the market price from your last import.</div></form>`;
}
function render() {
  const box = $("pf"); if (!box) return;
  if (detail) { const x = P.items.find((y) => y.id === detail); if (x) return renderDetail(box, x); detail = null; }
  const o = owned(P.items), T = totals(o), pfs = [...new Set(o.map((x) => x.pf || "Unsorted"))].sort(), w = P.items.filter((x) => x.watch).length;
  if (view !== "all" && view !== "watch" && !pfs.includes(view)) view = "all";
  const list = filtered(), V = view === "all" || view === "watch" ? T : totals(o.filter((x) => (x.pf || "Unsorted") === view));
  const gl = V.cost > 0 ? V.costed - V.cost : null;
  box.innerHTML = `<div id="pfh"><div class="pt1"><span class="mu">${view === "all" ? "Total portfolio value" : view === "watch" ? "Watchlist" : esc(view)}</span>
   <b>${view === "watch" ? w + " card" + (w === 1 ? "" : "s") : money(V.value)}</b>
   ${view !== "watch" && gl != null ? `<span style="color:var(${gl >= 0 ? "--up" : "--dn"});font-weight:600">${gl >= 0 ? "▲ +" : "▼ −"}${money(Math.abs(gl))} <span class="mu">on cards with a cost (${money(V.cost)} paid)</span></span>` : ""}</div>
   ${view !== "watch" ? `<div class="pst"><span><b>${V.n.toLocaleString()}</b> cards</span><span><b>${V.graded}</b> graded</span><span><b>${pfs.length}</b> portfolio${pfs.length === 1 ? "" : "s"}</span>${P.asOf ? `<span>Prices as of <b>${esc(P.asOf)}</b></span>` : ""}</div>` : ""}</div>
  <div class="bar"><label class="pill on" for="pff">Import from Collectr</label><input id="pff" type="file" accept=".csv,.xlsx,.xls,text/csv" hidden>
   <button class="pill" type="button" data-pa="add">+ Add card</button>${P.items.length ? `<button class="pill" type="button" data-pa="export">Export CSV</button><button class="pill" type="button" data-pa="clear">Clear all</button>` : ""}</div>
  <div class="sm" id="pfs"></div><div id="pfi" class="pbx" hidden></div>
  ${editing === "new" ? `<div class="pbx">${form({ qty: 1 })}</div>` : ""}
  ${P.items.length ? `
  ${view === "all" ? `<div class="pch">${chart()}</div>` : ""}
  <div class="tk" id="pfv">${[["all", "All"], ...pfs.map((p) => [p, p]), ...(w ? [["watch", "Watchlist (" + w + ")"]] : [])].map(([k, l]) => `<button class="pill" type="button" data-pv="${esc(k)}" aria-pressed="${k === view}">${esc(l)}${k !== "all" && k !== "watch" ? ` <span class="mu">${money(totals(o.filter((x) => (x.pf || "Unsorted") === k)).value)}</span>` : ""}</button>`).join("")}</div>
  <div class="bar"><input id="pfq" type="search" placeholder="Filter by name, set, number…" value="${esc(findTxt)}" autocomplete="off">
   <select id="pfo" aria-label="Sort">${[["value", "Value: high to low"], ["low", "Value: low to high"], ["unit", "Price per card"], ["gain", "Gain"], ["name", "Name"], ["added", "Recently added"]].map(([k, l]) => `<option value="${k}" ${k === sortBy ? "selected" : ""}>${l}</option>`).join("")}</select></div>
  <div class="sm">${list.length.toLocaleString()} ${list.length === 1 ? "entry" : "entries"}${findTxt ? " match" : ""}</div>
  <div id="pfl2">${list.slice(0, shown).map(rowHTML).join("")}</div>
  ${list.length > shown ? `<button class="pill" type="button" data-pa="more" style="margin-top:10px">Show ${Math.min(PAGE, list.length - shown)} more</button>` : ""}`
  : `<p class="sm">Your portfolio is empty. Import a Collectr export (in Collectr: Portfolio → ⋯ → Export, then open the emailed file here), or add cards one at a time. Everything stays saved on this device.</p>`}`;
  if (P.items.length) fetchImgs(list.slice(0, shown));
}

/* ---------- card pictures ---------- */
// Looked up once per card through the server (TCGplayer's catalog, which Collectr uses), then saved with the card.
const RETRY = 3 * 864e5, queue = [], busy = new Set();
let running = 0, saveT;
function thumb(x) {
  const inner = x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('none');this.remove()">` : "";
  const href = x.tcgId ? "https://www.tcgplayer.com/product/" + encodeURIComponent(x.tcgId) : x.big || x.img;
  return false && href && x.img ? `<a class="pi" data-pid="${x.id}" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(x.name)} picture">${inner}</a>`
    : `<span class="pi${x.img === null ? " none" : ""}" data-pid="${x.id}" aria-hidden="true">${inner}</span>`;
}
function wantImg(x) { return x.img === undefined || (x.img === null && Date.now() - (x.imgT || 0) > RETRY); }
function fetchImgs(list) {
  for (const x of list) if (wantImg(x) && !busy.has(x.id)) { busy.add(x.id); queue.push(x); }
  pump();
}
function pump() {
  while (running < 3 && queue.length) {
    const x = queue.shift(); running++;
    fetch("/api/cardimg?" + new URLSearchParams({ name: x.name, set: x.set || "", num: x.num || "", cat: x.cat || "" }))
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j) => {
        running--; busy.delete(x.id);
        if (j) { x.img = j.img || null; x.big = j.big || null; x.tcgId = j.tcgId || null; x.imgT = Date.now(); }
        else { x.img = null; x.imgT = Date.now() - RETRY + 6e5; } // server unreachable: try again in 10 minutes
        const el = document.querySelector(`[data-pid="${x.id}"]`); if (el) el.outerHTML = thumb(x);
        clearTimeout(saveT); saveT = setTimeout(store, 800);
        pump();
      });
  }
}

/* ---------- card page: eBay + TCGplayer comps (option H) ---------- */
// Tapping a card opens its comps: a fair price from both sites' sales, one chart of every sale, and each site's numbers.
// Numbers load only when a card is opened (and are kept for this visit), so the daily lookup limits stretch.
const COND_CODE = { "Near Mint": "NM", "Lightly Played": "LP", "Moderately Played": "MP", "Heavily Played": "HP", "Damaged": "DMG" };
const DRNG = [["14", "2W"], ["30", "1M"], ["90", "3M"], ["365", "1Y"]];
const compsCache = new Map();
let detail = null, drng = "30", listY = 0;
function gradeOf(x) { const m = /^(PSA|BGS|Beckett|CGC|TAG|SGC|ACE)\s*(\d+(?:\.5)?)/i.exec(x.grade || ""); return isGraded(x) && m ? { g: m[1].toUpperCase().replace("BECKETT", "BGS"), n: +m[2] } : null; }
function compQuery(x) { return [x.name.replace(/\s*\((?:\d+|jp|japanese)\)\s*$/i, ""), x.num, isGraded(x) ? shortGrade(x.grade) : ""].filter(Boolean).join(" "); }
const getJSON = (u) => fetch(u).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "error " + r.status); return j; });
// The condition being looked at: a raw condition ("Near Mint") or a grade ("PSA 10"). Starts at the card's own, from Collectr.
const RAWC = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];
let dsel = "Near Mint";
const selGrade = (sel) => { const m = /^(PSA|BGS|CGC|TAG|SGC|ACE)\s(\d+(?:\.5)?)$/.exec(sel || ""); return m ? { g: m[1], n: +m[2] } : null; };
const ownSel = (x) => (gradeOf(x) ? shortGrade(x.grade) : RAWC.includes(x.cond) ? x.cond : "Near Mint");
const selLabel = (sel) => COND_CODE[sel] || sel;
function condOptions(x) { const o = [...RAWC]; for (const g of [ownSel(x), "PSA 10", "PSA 9", "CGC 10", "TAG 10"]) if (!o.includes(g)) o.push(g); return o; }
function queryFor(x, sel) { const gi = selGrade(sel); return [x.name.replace(/\s*\((?:\d+|jp|japanese)\)\s*$/i, ""), x.num, gi ? gi.g + " " + gi.n : ""].filter(Boolean).join(" "); }
function loadPart(key, make) { if (!compsCache.has(key)) { const p = make(); compsCache.set(key, p); p.catch(() => compsCache.delete(key)); } return compsCache.get(key); }
async function loadComps(x, sel) {
  const gi = selGrade(sel), grader = gi ? (["PSA", "BGS", "CGC", "TAG"].includes(gi.g) ? gi.g : "all") : "raw", out = { ebay: null, tcg: null, warn: [] };
  const eb = loadPart(x.id + "|e|" + (gi ? gi.g + gi.n : "raw"), () => getJSON("/api/listings?" + new URLSearchParams({ q: queryFor(x, sel), grader })));
  const tp = gi ? Promise.resolve(null) : loadPart(x.id + "|t", async () => {
    if (!x.tcgId) { try { const j = await getJSON("/api/cardimg?" + new URLSearchParams({ name: x.name, set: x.set || "", num: x.num || "", cat: x.cat || "" })); if (j.tcgId) { x.tcgId = j.tcgId; if (j.img) { x.img = j.img; x.big = j.big; } x.imgT = Date.now(); store(); } } catch {} }
    if (!x.tcgId) throw new Error("couldn't find this card on TCGplayer");
    return getJSON("/api/tcgplayer?id=" + encodeURIComponent(x.tcgId));
  });
  const [e, t] = await Promise.allSettled([eb, tp]);
  if (e.status === "fulfilled") out.ebay = e.value; else out.warn.push("eBay: " + e.reason.message + ".");
  if (t.status === "fulfilled") out.tcg = t.value; else out.warn.push("TCGplayer: " + t.reason.message + ".");
  return out;
}
// eBay titles that look like the card but aren't the card itself (an oversized copy, a metal or custom card, a box)
const EB_JUNK = /\b(jumbo|oversize|oversized|large size|giant|metal|gold plated|gold card|custom|art card|acrylic|slab case|box|collection|tin|pin|coin|sticker|poster|code)\b/i;
const tcCond = (c) => { c = String(c || "").toLowerCase(); return c.startsWith("near mint") ? "Near Mint" : c.startsWith("lightly") ? "Lightly Played" : c.startsWith("moderately") ? "Moderately Played" : c.startsWith("heavily") ? "Heavily Played" : c.startsWith("damaged") ? "Damaged" : ""; };
const isJp = (x) => /japan/i.test(x.set || "") || /\(jp\)/i.test(x.name);
// ref: a trusted price for this card (TCGplayer's market price). eBay sales far from it are almost always a different item.
function ebayData(x, j, sel, ref) {
  const gi = selGrade(sel), cc = COND_CODE[sel] || "NM", jp = isJp(x), cut = { junk: 0, far: 0, lang: 0 };
  const L = ((j && j.listings) || []).filter((l) => l.rel !== false && l.price > 0)
    .filter((l) => (gi ? l.grader === gi.g && l.grade === gi.n : !l.grader && (l.cond === cc || (!l.cond && cc === "NM"))))
    .filter((l) => { if (EB_JUNK.test(l.title || "") && !EB_JUNK.test(x.name)) return cut.junk++, false;
      if (jp ? l.lang && l.lang !== "jp" : l.lang && l.lang !== "en") return cut.lang++, false;
      if (ref && !gi && (l.price < ref * 0.4 || l.price > ref * 2.5)) return cut.far++, false; return true; });
  let sold = L.filter((l) => l.type === "Sold").map((l) => ({ s: "e", price: l.price, t: Date.parse(l.date), url: l.url, title: l.title }));
  if (sold.length >= 8) { const a = sold.map((p) => p.price).sort((u, w) => u - w), q1 = a[Math.floor(a.length * 0.25)], q3 = a[Math.floor(a.length * 0.75)], iq = q3 - q1;
    const k = sold.filter((p) => p.price >= q1 - 1.5 * iq && p.price <= q3 + 1.5 * iq); cut.far += sold.length - k.length; sold = k; }
  return { sold, act: L.filter((l) => l.type !== "Sold").map((l) => ({ price: l.price })), soldOn: !!(j && j.soldEnabled), cut };
}
function tcgData(x, j, sel) {
  if (!j || selGrade(sel)) return { sold: [], act: [], market: null, url: null, weeks: [] };
  const want = sel, lc = (s) => String(s || "").toLowerCase(), jp = isJp(x);
  const langOk = (l) => !l.lang || (jp ? /japan/i.test(l.lang) : /english/i.test(l.lang));
  const strict = !!x.var && [...(j.sold || []), ...(j.listings || []), ...(j.hist || [])].some((l) => lc(l.print) === lc(x.var));
  const ok = (l) => tcCond(l.cond) === want && langOk(l) && (!strict || lc(l.print) === lc(x.var));
  // weekly sale ranges, oldest first: [start ms, lowest, highest, qty, sales, market price, …]
  const weeks = (j.hist || []).filter(ok).flatMap((s) => s.b).sort((a, b) => a[0] - b[0]);
  let market = null; for (const b of weeks) if (b[5]) market = b[5];
  const sold = (j.sold || []).filter(ok).map((l) => ({ s: "t", price: l.price, t: Date.parse(l.date), url: j.url }));
  // TCGplayer only shows a few single sales to the public, so each week's lowest and highest sale are added as points too
  const pts = [...sold];
  for (const b of weeks) { const t0 = b[0], t1 = t0 + 7 * 864e5, vals = b[4] > 1 && b[2] > b[1] ? [[b[1], 0.3], [b[2], 0.7]] : [[b[2] || b[1], 0.5]];
    for (const [v, f] of vals) if (v && !sold.some((q) => q.t >= t0 && q.t < t1 && Math.abs(q.price - v) < 0.01)) pts.push({ s: "t", price: v, t: Math.min(Date.now(), t0 + 7 * 864e5 * f), url: j.url, wk: true }); }
  return { sold: pts, act: (j.listings || []).filter(ok).map((l) => ({ price: l.price })), market, url: j.url, weeks };
}
const pq = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
function stats(sold, act, days) {
  const now = Date.now(), from = now - days * 864e5, w = sold.filter((s) => s.t >= from && s.t <= now + 864e5).sort((a, b) => a.t - b.t), ps = w.map((s) => s.price);
  const mid = from + (now - from) / 2, a = w.filter((s) => s.t < mid).map((s) => s.price), b = w.filter((s) => s.t >= mid).map((s) => s.price);
  return { n: w.length, med: pq(ps, 0.5), lo: pq(ps, 0.1), hi: pq(ps, 0.9), p25: pq(ps, 0.25), p75: pq(ps, 0.75), last: w[w.length - 1] || null,
    trend: a.length >= 2 && b.length >= 2 ? (pq(b, 0.5) / pq(a, 0.5) - 1) * 100 : null, cheap: act.length ? Math.min(...act.map((l) => l.price)) : null, nAct: act.length, pts: w, from, now };
}
const m0 = (v) => (v == null ? "—" : v >= 100 ? "$" + Math.round(v).toLocaleString() : money(v));
const ago = (t) => { const d = Math.floor((Date.now() - t) / 864e5); return d <= 0 ? "today" : d === 1 ? "yesterday" : d + " days ago"; };
const trendTxt = (v) => (v == null ? "" : `<span class="${v >= 0 ? "up" : "dn"}">${v >= 0 ? "▲" : "▼"} ${Math.abs(v).toFixed(1)}%</span>`);
function chartSVG(S, all, fairLo, fairHi) {
  if (!all.length) return `<div class="cdx-empty">No sales in this time range yet.</div>`;
  const W = 358, H = 170, m = { l: 4, r: 40, t: 10, b: 20 }, ps = all.map((p) => p.price);
  let lo = Math.min(...ps), hi = Math.max(...ps); const pad = (hi - lo) * 0.12 || hi * 0.1 || 1; lo = Math.max(0, lo - pad); hi += pad;
  const X = (t) => m.l + ((t - S.from) / (S.now - S.from)) * (W - m.l - m.r), Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const step = (hi - lo) / 3, grid = [0, 1, 2, 3].map((i) => lo + step * i);
  let g = grid.map((v) => `<line x1="0" x2="${W - m.r + 4}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="cdx-g"/><text x="${W}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" class="cdx-t">${m0(v)}</text>`).join("");
  if (fairLo != null) g += `<rect x="${m.l}" y="${Y(fairHi).toFixed(1)}" width="${W - m.l - m.r}" height="${Math.max(2, Y(fairLo) - Y(fairHi)).toFixed(1)}" class="cdx-band"/>`;
  if (all.length >= 3) { const n = all.length, mx = all.reduce((a, p) => a + p.t, 0) / n, my = all.reduce((a, p) => a + p.price, 0) / n;
    let num = 0, den = 0; for (const p of all) { num += (p.t - mx) * (p.price - my); den += (p.t - mx) ** 2; } const k = den ? num / den : 0;
    const t0 = Math.min(...all.map((p) => p.t)), t1 = S.now; g += `<line x1="${X(t0).toFixed(1)}" y1="${Y(my + k * (t0 - mx)).toFixed(1)}" x2="${X(t1).toFixed(1)}" y2="${Y(my + k * (t1 - mx)).toFixed(1)}" class="cdx-tr"/>`; }
  for (const p of all) { const x = X(Math.min(p.t, S.now)).toFixed(1), y = Y(p.price).toFixed(1), tip = `${p.s === "e" ? "eBay" : "TCGplayer"} ${money(p.price)}, ${ago(p.t)}`;
    g += p.s === "e" ? `<circle cx="${x}" cy="${y}" r="4.5" class="cdx-e" data-u="${esc(p.url || "")}"><title>${esc(tip)}</title></circle>` : `<rect x="${(x - 3.5).toFixed(1)}" y="${(y - 3.5).toFixed(1)}" width="7" height="7" class="cdx-c" data-u="${esc(p.url || "")}"><title>${esc(tip)}</title></rect>`; }
  const d0 = new Date(S.from).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  g += `<text x="0" y="${H - 4}" class="cdx-t">${d0}</text><text x="${W - m.r}" y="${H - 4}" text-anchor="end" class="cdx-t">Today</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Every sale on both sites in this time range">${g}</svg>`;
}
function siteCard(name, cls, head, main, S, extra) {
  return `<div class="cdx-site"><div class="cdx-sh"><span><i class="${cls}"></i>${name}</span>${trendTxt(S.trend)}</div>
  <div><div class="cdx-k">${head}</div><div class="cdx-big">${m0(main)}</div></div>
  <div><div class="cdx-k">Sold range</div><div class="cdx-v">${S.n ? m0(S.lo) + " – " + m0(S.hi) : "—"}</div></div>
  <div><div class="cdx-k">Sales · last sold</div><div class="cdx-v">${S.n}${S.last ? " · " + m0(S.last.price) : ""}</div></div>
  <div><div class="cdx-k">Cheapest for sale</div><div class="cdx-v">${S.cheap != null ? m0(S.cheap) + ` <span class="mu">of ${S.nAct}</span>` : "—"}</div></div>${extra || ""}</div>`;
}
function renderDetail(box, x) {
  const gi = gradeOf(x), meta = [x.set, x.num, x.var].filter(Boolean).map(esc).join(" · ") + " · " + esc(gi ? shortGrade(x.grade) : COND_CODE[x.cond] || x.cond || "NM");
  const pic = x.img ? `<a class="cdx-pic" href="${esc(x.tcgId ? "https://www.tcgplayer.com/product/" + encodeURIComponent(x.tcgId) : x.big || x.img)}" target="_blank" rel="noopener" aria-label="${esc(x.name)} on TCGplayer"><img src="${esc(x.big || x.img)}" alt="${esc(x.name)}"></a>` : `<span class="cdx-pic none" aria-hidden="true"></span>`;
  const head = (fair) => `<div class="cdx-top"><button class="pill" type="button" data-dx="back">‹ Portfolio</button><button class="pill sm2" type="button" data-ed="${x.id}">Edit</button></div>
  <div class="cdx-hd">${pic}<div class="cdx-hm"><div class="cdx-name">${esc(x.name)}</div><div class="mu">${meta}</div>${fair}</div></div>
  <div class="seg cdx-rg" role="group" aria-label="Time range">${DRNG.map(([k, l]) => `<button type="button" data-dr="${k}" aria-pressed="${k === drng}">${l}</button>`).join("")}</div>
  <div class="tk cdx-cd" role="group" aria-label="Condition">${condOptions(x).map((c) => `<button class="pill" type="button" data-dc="${esc(c)}" aria-pressed="${c === dsel}">${esc(selLabel(c))}${c === ownSel(x) ? " ★" : ""}</button>`).join("")}</div>`;
  const sel = dsel, own = sel === ownSel(x), sgi = selGrade(sel);
  box.innerHTML = head(`<div class="cdx-fair"><div class="cdx-fl">Fair price right now</div><div class="cdx-fv">…</div><div class="cdx-fs">Loading eBay and TCGplayer sales…</div></div>`);
  loadComps(x, sel).then((R) => {
    if (detail !== x.id || dsel !== sel) return;
    const days = +drng, T = tcgData(x, R.tcg, sel), E = ebayData(x, R.ebay, sel, T.market), SE = stats(E.sold, E.act, days), ST = stats(T.sold, T.act, days);
    { const from = Date.now() - days * 864e5, wn = T.weeks.filter((b) => b[0] + 7 * 864e5 >= from).reduce((n, b) => n + (b[4] || 0), 0); if (wn > ST.n) ST.n = wn; }
    const all = [...SE.pts, ...ST.pts], SA = stats(all, [], days), fair = SA.med ?? T.market ?? SE.cheap, n = all.length;
    const fairBox = `<div class="cdx-fair"><div class="cdx-fl">Fair price right now</div>
      <div class="cdx-fr"><span class="cdx-fv">${m0(fair)}</span>${SA.trend != null ? `<span class="cdx-ft">${SA.trend >= 0 ? "▲" : "▼"} ${Math.abs(SA.trend).toFixed(1)}%</span>` : ""}</div>
      <div class="cdx-fs">${n ? `${m0(SA.p25)} – ${m0(SA.p75)} · ${n} sale${n === 1 ? "" : "s"}` : SA.med == null && T.market != null ? "TCGplayer market price · no recent sales" : "No sales in this range"}</div></div>`;
    const qty = x.qty || 0, mine = qty && fair != null ? `<div class="cdx-mine"><div><b>Your ${qty} cop${qty === 1 ? "y" : "ies"}</b><div class="mu">${x.ovr > 0 ? "Your price" : "Collectr says"} ${money(unit(x) * qty)}</div></div><div class="cdx-mr"><b>${money(fair * qty)}</b><div class="mu">${own ? "at fair price" : "if " + esc(selLabel(sel))}</div></div></div>` : "";
    const tcgNote = sgi ? `<div class="cdx-k" style="margin-top:2px">TCGplayer doesn't sell graded cards</div>` : "";
    box.innerHTML = head(fairBox) + `<div class="cdx-ch">${chartSVG(SA, all, SA.p25, SA.p75)}</div>
    <div class="cdx-lg"><span><i class="cdx-ie"></i>eBay</span><span><i class="cdx-it"></i>TCGplayer</span><span><i class="cdx-ib"></i>Usual range</span></div>
    <div class="cdx-sites">${siteCard("eBay", "cdx-ie", "Median sold", SE.med, SE, E.soldOn ? "" : `<div class="cdx-k">eBay sold data is off</div>`)}${siteCard("TCGplayer", "cdx-it", T.market != null ? "Market price" : "Median sold", T.market ?? ST.med, ST, tcgNote)}</div>
    ${mine}<div class="cdx-btns"><button class="btn" type="button" data-dx="ebay">eBay chart</button><button class="btn o" type="button" data-dx="tcg">TCGplayer chart</button></div>
    <div class="sm">${esc(sgi ? sel + " sales only." : sel + " raw sales only.")}${own ? "" : " ★ marks your copy's condition."} Tap a dot to open that sale.${E.cut.junk + E.cut.far + E.cut.lang ? ` Left out ${E.cut.junk + E.cut.far + E.cut.lang} eBay result${E.cut.junk + E.cut.far + E.cut.lang === 1 ? "" : "s"} that looked like a different item (jumbo or metal cards, other languages, or prices far from TCGplayer's).` : ""}${R.warn.length ? " " + esc(R.warn.join(" ")) : ""}</div>`;
  }).catch((e) => { if (detail === x.id) box.innerHTML = head(`<div class="cdx-fair"><div class="cdx-fs">Couldn't load comps: ${esc(e.message)}</div></div>`); });
}
function openDetail(id) { if (!P.items.some((y) => y.id === id)) return; listY = scrollY; detail = id; dsel = ownSel(P.items.find((y) => y.id === id)); editing = null; try { history.pushState({ ppd: id }, ""); } catch {} render(); scrollTo(0, 0); }
function closeDetail(viaHistory) { if (!detail) return; detail = null; render(); scrollTo(0, listY); if (!viaHistory && history.state && history.state.ppd) try { history.back(); } catch {} }
addEventListener("popstate", () => { if (detail) closeDetail(true); });

/* ---------- actions ---------- */
function exportCSV() {
  const c = (v) => { v = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const rows = [["Portfolio Name", "Category", "Set", "Product Name", "Card Number", "Rarity", "Variance", "Grade", "Card Condition", "Average Cost Paid", "Quantity", `Market Price (As of ${P.asOf || today()})`, "Price Override", "Watchlist", "Date Added", "Notes"]];
  for (const x of P.items) rows.push([x.pf, x.cat, x.set, x.name, x.num, x.rarity, x.var, x.grade, x.cond, x.qty ? x.cost : "", x.qty || "", x.mkt ?? "", x.ovr || 0, x.watch, x.added, x.notes]);
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(c).join(",")).join("\n")], { type: "text/csv" }));
  a.download = "price-plot-portfolio-" + today() + ".csv"; document.body.appendChild(a); a.click(); a.remove();
}
function comp(x) {
  const q = [x.name.replace(/\s*\((?:\d+|jp|japanese)\)\s*$/i, ""), x.num, isGraded(x) ? shortGrade(x.grade) : ""].filter(Boolean).join(" ");
  $("q").value = q; const b = $("tb").querySelector('[data-t="ebay"]'); if (b) b.click(); tcgQ = ""; load(); scrollTo({ top: 0, behavior: "smooth" });
}
function saveForm(fm) {
  const d = Object.fromEntries(new FormData(fm)), id = fm.dataset.fid, old = P.items.find((x) => x.id === id);
  const x = { ...(old || { id: uid(), cat: "Pokemon", rarity: "", mkt: null, watch: false, added: today() }),
    name: d.name.trim(), set: d.set.trim(), num: d.num.trim(), var: d.var.trim(), cond: d.cond, grade: d.grade.trim() || "Ungraded",
    qty: Math.max(0, Math.round(num(d.qty) ?? 1)), cost: num(d.cost) || 0, ovr: num(d.ovr) || 0, pf: d.pf.trim(), notes: d.notes.trim() };
  if (!x.name) return;
  if (old && (old.name !== x.name || old.set !== x.set || old.num !== x.num)) { x.img = undefined; x.imgT = 0; }
  if (old) Object.assign(old, x); else P.items.push(x);
  editing = null; store(); snap(); render();
}
document.addEventListener("click", (e) => {
  const box = $("pf"); if (!box || !box.contains(e.target)) return;
  const dot = e.target.closest && e.target.closest("[data-u]"); if (dot) { if (dot.dataset.u) openLink(dot.dataset.u); return; }
  const btn = e.target.closest("button");
  if (!btn) { const row = !e.target.closest("a,input,select,label,form") && e.target.closest(".pr[data-id]"); if (row && editing !== row.dataset.id) openDetail(row.dataset.id); return; }
  const d = btn.dataset;
  if (d.dr) { drng = d.dr; render(); return; }
  if (d.dc) { dsel = d.dc; render(); return; }
  if (d.dx) { const x = P.items.find((y) => y.id === detail);
    if (d.dx === "back") closeDetail();
    else if (x && d.dx === "ebay") { const q = queryFor(x, dsel); closeDetail(); $("q").value = q; const b = $("tb").querySelector('[data-t="ebay"]'); if (b) b.click(); tcgQ = ""; load(); scrollTo({ top: 0, behavior: "smooth" }); }
    else if (x && d.dx === "tcg") { closeDetail(); $("q").value = queryFor(x, dsel); tcgQ = ""; const b = $("tb").querySelector('[data-t="tcg"]'); if (b) b.click(); scrollTo({ top: 0, behavior: "smooth" }); }
    return; }
  if (d.ed && detail) { detail = null; }
  if (d.pv != null) { view = d.pv; shown = PAGE; editing = null; render(); }
  else if (d.cmp) { const x = P.items.find((y) => y.id === d.cmp); if (x) comp(x); }
  else if (d.ed) { editing = d.ed; render(); }
  else if (d.cx) { editing = null; render(); }
  else if (d.del) { const x = P.items.find((y) => y.id === d.del); if (x && confirm(`Delete ${x.name} from your portfolio?`)) { P.items = P.items.filter((y) => y.id !== d.del); editing = null; store(); snap(); render(); } }
  else if (d.pa === "merge" || d.pa === "replace") applyImport(d.pa);
  else if (d.pa === "cancel") { pending = null; $("pfi").hidden = true; }
  else if (d.pa === "add") { editing = "new"; render(); }
  else if (d.pa === "more") { shown += PAGE; render(); }
  else if (d.pa === "export") exportCSV();
  else if (d.pa === "clear") { if (confirm("Remove every card from your portfolio on this device? Export a CSV first if you want a backup.")) { P = { items: [], asOf: null }; store(); try { localStorage.removeItem(HKEY); } catch {} render(); } }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "pff" && e.target.files[0]) onFile(e.target.files[0]);
  else if (e.target.id === "pfo") { sortBy = e.target.value; shown = PAGE; render(); }
});
let qt; document.addEventListener("input", (e) => { if (e.target.id !== "pfq") return; clearTimeout(qt);
  qt = setTimeout(() => { findTxt = e.target.value.trim(); shown = PAGE; render(); const q = $("pfq"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 200); });
document.addEventListener("submit", (e) => { if (e.target.classList?.contains("pe")) { e.preventDefault(); saveForm(e.target); } });
render();
})();
