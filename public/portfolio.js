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
  return `<div class="pr" data-id="${x.id}"><button class="prx" type="button" data-trash="${x.id}" tabindex="-1" aria-label="Remove ${esc(x.name)}"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></button><div class="prc">${thumb(x)}<div class="pm"><b>${esc(x.name)}</b> <span class="cg ${g ? "gr" : ""}">${esc(g ? shortGrade(x.grade) : x.cond || "")}</span>
  <div class="mu">${meta}${view === "all" && x.pf ? ` · <i>${esc(x.pf)}</i>` : ""}</div>
  <div class="mu">${view === "watch" ? "" : x.qty + " × "}${x.mkt == null && !(x.ovr > 0) ? "—" : money(unit(x))}${x.ovr > 0 ? ` <span title="Your own price, set in Collectr or here">(your price)</span>` : x.mkt == null ? (pfq.includes(x) || pfRunning ? " (looking up price…)" : " (no price)") : x.mktEst ? ` <span title="No recent ${esc(x.cond || "")} sales on TCGplayer, so this is the Near Mint price with the usual discount for this condition">(est.)</span>` : ""}${gain != null ? ` · <span style="color:var(${gain >= 0 ? "--up" : "--dn"})">${gain >= 0 ? "+" : "−"}${money(Math.abs(gain))}</span> vs. ${money(x.cost)} paid` : ""}</div>
  ${x.notes ? `<div class="mu">${esc(x.notes)}</div>` : ""}</div>
  <div class="pv"><b>${x.mkt == null && !(x.ovr > 0) && x.qty ? "—" : money(line)}</b><div><button class="pill sm2" type="button" data-cmp="${x.id}">Comp</button><button class="pill sm2" type="button" data-ed="${x.id}">Edit</button></div></div></div></div>`;
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
  <div class="bar"><label class="pill on" for="pff">Import Collectr file</label><button class="pill" type="button" data-pa="clink">From a Collectr link</button><input id="pff" type="file" accept=".csv,.xlsx,.xls,text/csv" hidden>
   <button class="pill" type="button" data-pa="add">+ Add card</button>${P.items.length ? `<button class="pill" type="button" data-pa="export">Export CSV</button><button class="pill" type="button" data-pa="clear">Clear all</button>` : ""}</div>
  ${cimpPanel()}<div class="sm" id="pfs"></div><div id="pfi" class="pbx" hidden></div>
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
        if (j) { x.img = j.img || null; x.big = j.big || null; x.tcgId = x.tcgId || j.tcgId || null; x.imgT = Date.now(); }
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
// The comps chart zooms like the eBay and TCGplayer charts: two fingers pinch and slide, the mouse wheel zooms,
// dragging the price axis (right) or the date axis (bottom) stretches that axis, and "Reset zoom" goes back.
let CG = null, cview = null, cpd0 = 0, cpc = null, cax = null;
const CPT = new Map(), CW = 358, CH = 190, CM = { l: 4, r: 46, t: 10, b: 22 };
function chartSVG(S, all, fairLo, fairHi) {
  if (!all.length) { CG = null; return `<div class="cdx-empty">No sales in this time range yet.</div>`; }
  const ps = all.map((p) => p.price); let lo = Math.min(...ps), hi = Math.max(...ps); const pad = (hi - lo) * 0.12 || hi * 0.1 || 1; lo = Math.max(0, lo - pad); hi += pad;
  CG = { S, all, fairLo, fairHi, full: { x0: S.from, x1: S.now, y0: lo, y1: hi } };
  return `<div id="cdxc">${chartInner()}</div>`;
}
function cClamp(v) { const f = CG.full, fw = f.x1 - f.x0, fh = f.y1 - f.y0, w = Math.min(fw, Math.max(6 * 3600e3, v.x1 - v.x0)), h = Math.min(fh, Math.max(fh / 200, v.y1 - v.y0));
  const x0 = Math.min(Math.max(v.x0, f.x0), f.x1 - w), y0 = Math.min(Math.max(v.y0, f.y0), f.y1 - h); return { x0, x1: x0 + w, y0, y1: y0 + h }; }
function cSet(v) { if (!CG) return; cview = cClamp(v); const f = CG.full; if (cview.x1 - cview.x0 >= (f.x1 - f.x0) * 0.999 && cview.y1 - cview.y0 >= (f.y1 - f.y0) * 0.999) cview = null; const b = $("cdxc"); if (b) b.innerHTML = chartInner(); }
function chartInner() {
  const { S, all, fairLo, fairHi } = CG, v = cview ? cClamp(cview) : CG.full, m = CM, W = CW, H = CH, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const X = (t) => m.l + ((t - v.x0) / (v.x1 - v.x0)) * iw, Y = (p) => m.t + (1 - (p - v.y0) / (v.y1 - v.y0)) * ih;
  const ys = nice((v.y1 - v.y0) / 4); let g = `<defs><clipPath id="cdxcp"><rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/></clipPath></defs>`;
  for (let y = Math.ceil(v.y0 / ys - 1e-9) * ys; y <= v.y1 + 1e-9; y += ys) g += `<line x1="0" x2="${m.l + iw}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}" class="cdx-g"/><text x="${W}" y="${(Y(y) + 3).toFixed(1)}" text-anchor="end" class="cdx-t">${m0(+y.toFixed(2))}</text>`;
  g += `<g clip-path="url(#cdxcp)">`;
  if (fairLo != null) g += `<rect x="${m.l}" y="${Y(fairHi).toFixed(1)}" width="${iw}" height="${Math.max(2, Y(fairLo) - Y(fairHi)).toFixed(1)}" class="cdx-band"/>`;
  if (all.length >= 3) { const n = all.length, mx = all.reduce((a, p) => a + p.t, 0) / n, my = all.reduce((a, p) => a + p.price, 0) / n;
    let num = 0, den = 0; for (const p of all) { num += (p.t - mx) * (p.price - my); den += (p.t - mx) ** 2; } const k = den ? num / den : 0;
    const t0 = Math.min(...all.map((p) => p.t)), t1 = S.now; g += `<line x1="${X(t0).toFixed(1)}" y1="${Y(my + k * (t0 - mx)).toFixed(1)}" x2="${X(t1).toFixed(1)}" y2="${Y(my + k * (t1 - mx)).toFixed(1)}" class="cdx-tr"/>`; }
  const r = cview ? 5 : 4.5;
  for (const p of all) { const x = X(Math.min(p.t, S.now)), y = Y(p.price); if (x < m.l - 8 || x > m.l + iw + 8 || y < m.t - 8 || y > m.t + ih + 8) continue;
    const tip = `${p.s === "e" ? "eBay" : "TCGplayer"} ${money(p.price)}, ${p.wk ? "week of " + new Date(p.t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ago(p.t)}`;
    g += p.s === "e" ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" class="cdx-e" data-u="${esc(p.url || "")}"><title>${esc(tip)}</title></circle>` : `<rect x="${(x - r + 1).toFixed(1)}" y="${(y - r + 1).toFixed(1)}" width="${2 * r - 2}" height="${2 * r - 2}" class="cdx-c" data-u="${esc(p.url || "")}"><title>${esc(tip)}</title></rect>`; }
  g += `</g>`;
  const span = (v.x1 - v.x0) / 864e5, lf = span > 180 ? { month: "short", year: "2-digit" } : span > 3 ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", hour: "numeric" };
  for (let i = 0; i <= 2; i++) { const t = v.x0 + ((v.x1 - v.x0) * i) / 2, lbl = i === 2 && v.x1 >= S.now - 3600e3 ? "Today" : new Date(t).toLocaleDateString(undefined, lf);
    g += `<text x="${i === 0 ? m.l : i === 2 ? m.l + iw : X(t)}" y="${H - 5}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}" class="cdx-t">${lbl}</text>`; }
  const pc = (n, d) => ((n / d) * 100).toFixed(2) + "%";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Every sale on both sites in this time range">${g}</svg>
  <div class="az ay" data-cz="y" style="top:0;right:0;width:${pc(m.r, W)};height:${pc(m.t + ih, H)}"></div><div class="az ax" data-cz="x" style="left:0;bottom:0;width:${pc(m.l + iw, W)};height:${pc(m.b, H)}"></div>
  ${cview ? `<div class="zc"><button class="rs" type="button" data-czr="1">Reset zoom</button></div>` : ""}`;
}
{
  const inC = (e) => e.target && e.target.closest && e.target.closest("#cdxc");
  const frac = (cx, cy) => { const b = $("cdxc").querySelector("svg").getBoundingClientRect(), s = b.width / CW; return { fx: ((cx - b.left) / s - CM.l) / (CW - CM.l - CM.r), fy: ((cy - b.top) / s - CM.t) / (CH - CM.t - CM.b) }; };
  const mid = () => { const [a, b] = [...CPT.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }, dist = () => { const [a, b] = [...CPT.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  function gesture(pf, nf, f) { const v = cview || CG.full, w = v.x1 - v.x0, h = v.y1 - v.y0, cx = v.x0 + pf.fx * w, cy = v.y1 - pf.fy * h, nw = w * f, nh = h * f;
    cSet({ x0: cx - nf.fx * nw, x1: cx - nf.fx * nw + nw, y0: cy - (1 - nf.fy) * nh, y1: cy - (1 - nf.fy) * nh + nh }); }
  document.addEventListener("pointerdown", (e) => { const box = inC(e); if (!box || !CG || (e.target.closest && e.target.closest("button"))) return;
    const z = e.target.dataset && e.target.dataset.cz;
    if (z) { cax = { id: e.pointerId, z, x: e.clientX, y: e.clientY, v: { ...(cview || CG.full) } }; try { box.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); return; }
    CPT.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (CPT.size === 2) { cpd0 = dist(); cpc = mid(); CPT.forEach((_, id) => { try { box.setPointerCapture(id); } catch {} }); } });
  document.addEventListener("pointermove", (e) => { if (!CG) return;
    if (cax && e.pointerId === cax.id) { const dx = e.clientX - cax.x, dy = e.clientY - cax.y, v = cax.v;
      if (cax.z === "y") { const h = (v.y1 - v.y0) * Math.exp(dy * 0.008), c = (v.y0 + v.y1) / 2; cSet({ x0: v.x0, x1: v.x1, y0: c - h / 2, y1: c + h / 2 }); }
      else { const w = (v.x1 - v.x0) * Math.exp(-dx * 0.008); cSet({ x0: v.x1 - w, x1: v.x1, y0: v.y0, y1: v.y1 }); } return; }
    if (!CPT.has(e.pointerId)) return; CPT.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (CPT.size === 2) { const nd = dist(), mm = mid(); if (cpd0 && nd && cpc) gesture(frac(cpc.x, cpc.y), frac(mm.x, mm.y), cpd0 / nd); cpd0 = nd; cpc = mm; } });
  const up = (e) => { if (cax && e.pointerId === cax.id) { cax = null; return; } CPT.delete(e.pointerId); cpd0 = 0; cpc = null; };
  document.addEventListener("pointerup", up); document.addEventListener("pointercancel", up);
  document.addEventListener("wheel", (e) => { if (!inC(e) || !CG) return; e.preventDefault(); const c = frac(e.clientX, e.clientY); c.fx = Math.min(1, Math.max(0, c.fx)); c.fy = Math.min(1, Math.max(0, c.fy));
    const f = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.003), v = cview || CG.full, w = v.x1 - v.x0, hh = v.y1 - v.y0, cx = v.x0 + c.fx * w, cy = v.y1 - c.fy * hh;
    cSet({ x0: cx - c.fx * w * f, x1: cx - c.fx * w * f + w * f, y0: cy - (1 - c.fy) * hh * f, y1: cy - (1 - c.fy) * hh * f + hh * f }); }, { passive: false });
  ["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => { if (inC(e)) e.preventDefault(); }, { passive: false }));
  document.addEventListener("touchmove", (e) => { if (inC(e) && e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
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
function openDetail(id) { if (!P.items.some((y) => y.id === id)) return; listY = scrollY; detail = id; cview = null; dsel = ownSel(P.items.find((y) => y.id === id)); editing = null; try { history.pushState({ ppd: id }, ""); } catch {} render(); scrollTo(0, 0); }
function closeDetail(viaHistory) { if (!detail) return; detail = null; render(); scrollTo(0, listY); if (!viaHistory && history.state && history.state.ppd) try { history.back(); } catch {} }
addEventListener("popstate", () => { if (detail) closeDetail(true); });

/* ---------- pop-up windows and short notices ---------- */
// modal({ title, text, buttons: [{ label, value, kind: "primary" | "danger" }] }) → the tapped button's value, or null if dismissed
function modal({ title, text, buttons }) {
  return new Promise((done) => {
    const ov = document.createElement("div"); ov.className = "ppm-ov";
    ov.innerHTML = `<div class="ppm" role="dialog" aria-modal="true" aria-labelledby="ppm-t"><h3 id="ppm-t">${esc(title)}</h3>${text ? `<p>${text}</p>` : ""}
      <div class="ppm-b">${buttons.map((b, i) => `<button type="button" class="ppm-x ${b.kind || ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div></div>`;
    const prev = document.activeElement, close = (v) => { removeEventListener("keydown", key); ov.remove(); try { prev && prev.focus && prev.focus(); } catch {} done(v); };
    const key = (e) => { if (e.key === "Escape") close(null); };
    ov.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) close(buttons[+b.dataset.i].value); else if (e.target === ov) close(null); });
    addEventListener("keydown", key); document.body.appendChild(ov); (ov.querySelector(".ppm-x.primary") || ov.querySelector(".ppm-x")).focus();
  });
}
let toastT;
function toast(msg, action) {
  let t = $("ppt"); if (!t) { t = document.createElement("div"); t.id = "ppt"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`; t.className = "show";
  if (action) t.querySelector("button").onclick = () => { t.className = ""; action.run(); };
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ""), 4500);
}

/* ---------- add a card from the TCGplayer tab ---------- */
// Called by the TCGplayer tab's "Add to portfolio" button with the card on screen, its printing and the conditions picked there.
window.ppAddFromTcg = async (c, print, conds) => {
  if (!c) return;
  const name = String(c.name || "").replace(/\s+-\s+[\w/]+$/, "").trim(), cond = conds && conds.length === 1 ? conds[0] : "Near Mint";
  const v = (c.variants || []).find((k) => k.print === print && k.cond === cond && (k.lang || "English") === "English") || (c.variants || []).find((k) => k.print === print && k.cond === cond);
  const folders = [...new Set(P.items.filter((x) => x.qty > 0 && x.pf).map((x) => x.pf))].sort();
  let pf = folders[0] || "";
  if (folders.length > 1) {
    pf = await modal({ title: "Add to which portfolio?", text: `${esc(name)} · ${esc(c.set || "")}<br><span class="mu">${esc(cond)}${print ? " · " + esc(print) : ""} · 1 copy. You can change these later with Edit.</span>`,
      buttons: [...folders.map((f, i) => ({ label: f, value: f, kind: i === 0 ? "primary" : "" })), { label: "Cancel", value: null, kind: "plain" }] });
    if (pf == null) return;
  }
  const tid = c.tcgId || (String(c.tcgUrl || "").match(/product\/(\d+)/) || [])[1] || null;
  const x = { id: uid(), pf, cat: "Pokemon", set: c.set || "", name, num: c.number || "", rarity: c.rarity || "", var: print || "", grade: "Ungraded", cond, cost: 0, qty: 1,
    mkt: v && v.price != null ? +v.price : null, ovr: 0, watch: false, added: today(), notes: "", tcgId: tid,
    img: tid ? `https://tcgplayer-cdn.tcgplayer.com/product/${tid}_200w.jpg` : undefined, big: tid ? `https://tcgplayer-cdn.tcgplayer.com/product/${tid}_400w.jpg` : undefined, imgT: tid ? Date.now() : 0 };
  const same = P.items.find((y) => y.qty > 0 && keyOf(y) === keyOf(x));
  if (same) { same.qty += 1; if (x.mkt != null) same.mkt = x.mkt; } else P.items.push(x);
  store(); snap(); render();
  toast(same ? `Added another ${name} to ${pf || "your portfolio"} (now ${same.qty})` : `Added ${name} to ${pf || "your portfolio"}`,
    { label: "View", run: () => { const b = $("tb").querySelector('[data-t="pf"]'); if (b) b.click(); view = pf || "all"; findTxt = ""; render(); scrollTo({ top: 0, behavior: "smooth" }); } });
};

/* ---------- swipe a card left to show the trash can ---------- */
let sw = null, swJust = 0;
const closeSwipes = (except) => document.querySelectorAll("#pf .pr.open").forEach((r) => r !== except && r.classList.remove("open"));
document.addEventListener("pointerdown", (e) => {
  const c = e.target.closest && e.target.closest("#pf .prc"); if (!c || e.button > 0 || e.target.closest("button,a,input,select,label")) return;
  const row = c.parentNode; sw = { id: e.pointerId, row, c, x: e.clientX, y: e.clientY, base: row.classList.contains("open") ? -84 : 0, on: false };
});
document.addEventListener("pointermove", (e) => {
  if (!sw || e.pointerId !== sw.id) return; const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  if (!sw.on) { if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) { sw.on = true; sw.c.classList.add("drag"); closeSwipes(sw.row); try { sw.c.setPointerCapture(e.pointerId); } catch {} } else if (Math.abs(dy) > 10) { sw = null; return; } }
  if (sw.on) sw.c.style.transform = `translateX(${Math.min(0, Math.max(-130, sw.base + dx))}px)`;
});
const swEnd = (e) => {
  if (!sw || e.pointerId !== sw.id) return; const s = sw; sw = null; if (!s.on) return;
  const t = s.base + (e.clientX - s.x); s.c.classList.remove("drag"); s.c.style.transform = ""; s.row.classList.toggle("open", t < -40); swJust = Date.now();
};
document.addEventListener("pointerup", swEnd); document.addEventListener("pointercancel", swEnd);
async function askRemove(id) {
  const x = P.items.find((y) => y.id === id); if (!x) return;
  const ok = await modal({ title: "Are you sure you want to remove this item from your portfolio?", text: esc(x.name) + (x.set ? ` · ${esc(x.set)}` : ""), buttons: [{ label: "Yes", value: true, kind: "danger" }, { label: "No", value: false, kind: "primary" }] });
  if (!ok) { closeSwipes(); return; }
  P.items = P.items.filter((y) => y.id !== id); if (editing === id) editing = null; store(); snap(); render();
  toast(`Removed ${x.name}`);
}

/* ---------- prices for cards that came in without one (TCGplayer market price) ---------- */
// Cards added from a Collectr link (or by hand) have no price yet. They're looked up a couple at a time through the
// same server lookup as the pictures, then saved with the card. Lookups that found nothing are retried after 3 days.
let pfq = [], pfRunning = 0, pfTotal = 0, pfDone = 0;
// Each card gets TCGplayer's market price for its own condition and printing. Cards whose price came from TCGplayer's
// search (older versions, which ignored condition and printing) are looked up again. Prices from a Collectr file and
// your own prices are left alone (the TCGplayer price is still fetched behind them, for when they are removed);
// graded cards have no TCGplayer price.
const needsPrice = (x, now) => x.qty > 0 && !isGraded(x) && x.mktV !== 2 && (x.mkt == null || x.pT) && !(x.pTry && now - x.pTry < 3 * 864e5);
function fillPrices() {
  const now = Date.now(), want = P.items.filter((x) => needsPrice(x, now) && !pfq.includes(x));
  if (!want.length) return; pfq.push(...want); pfTotal += want.length; pricePump();
}
async function priceOne(x) {
  if (!x.tcgId) { const j = await getJSON("/api/cardimg?" + new URLSearchParams({ name: x.name, set: x.set || "", num: x.num || "", cat: x.cat || "" })).catch(() => null);
    if (j && j.tcgId) { x.tcgId = j.tcgId; if (!x.img && j.img) { x.img = j.img; x.big = j.big; x.imgT = Date.now(); } } }
  if (!x.tcgId) return false;
  const j = await getJSON("/api/tcgprice?" + new URLSearchParams({ id: x.tcgId, cond: x.cond || "Near Mint", print: x.var || "", jp: isJp(x) ? "1" : "" })).catch(() => null);
  if (!j || !(j.market > 0)) return false;
  x.mkt = j.market; x.mktEst = !!j.est; x.mktV = 2; x.pT = Date.now(); return true;
}
function pricePump() {
  while (pfRunning < 2 && pfq.length) {
    const x = pfq.shift(); pfRunning++;
    priceOne(x).then((ok) => {
      pfRunning--; pfDone++; x.pTry = Date.now(); if (!ok && x.pT && x.mktV !== 2) { x.mkt = null; x.mktEst = false; }
      const s = $("pfs"); if (s && !pending) s.textContent = pfq.length || pfRunning ? `Looking up TCGplayer prices: ${pfDone.toLocaleString()} of ${pfTotal.toLocaleString()}…` : "";
      clearTimeout(saveT); saveT = setTimeout(store, 1500);
      if (!pfq.length && !pfRunning) { pfTotal = pfDone = 0; store(); snap(); if (!detail && !editing) render(); }
      else pricePump();
    });
  }
}

/* ---------- import from a Collectr showcase link (bookmark) ---------- */
// The "Send to Price Plot" bookmark runs on the showcase page in the person's own browser, reads the cards that page
// loaded, opens Price Plot at #collectr-import and hands the cards over with postMessage.
const COLLECTR_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*getcollectr\.com$/;
let cimp = null; // { status: "waiting" | "ready" | "error", items, raw, msg }
function flat(o, pre = "", out = {}, depth = 0) {
  if (!o || typeof o !== "object" || depth > 3) return out;
  for (const [k, v] of Object.entries(o)) { const key = (pre ? pre + "." : "") + k.toLowerCase();
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, key, out, depth + 1); else if (v != null && typeof v !== "object") out[key] = v; }
  return out;
}
function pick(f, re, not) { for (const [k, v] of Object.entries(f)) { const leaf = k.split(".").pop(), full = k.replace(/\./g, "_"); if ((re.test(leaf) || re.test(full)) && !(not && not.test(k)) && String(v).trim() !== "") return v; } return null; }
const COND_NAMES = { nm: "Near Mint", lp: "Lightly Played", mp: "Moderately Played", hp: "Heavily Played", dmg: "Damaged", d: "Damaged" };
function normCond(c) { const s = String(c || "").trim(), l = s.toLowerCase(); if (!s) return "Near Mint";
  return l.startsWith("near mint") || l === "mint" ? "Near Mint" : l.startsWith("lightly") ? "Lightly Played" : l.startsWith("moderately") ? "Moderately Played" : l.startsWith("heavily") ? "Heavily Played" : l.startsWith("damaged") ? "Damaged" : COND_NAMES[l] || s; }
function mapCollectr(o) {
  const f = flat(o);
  const name = pick(f, /^(product_?name|card_?name|name|title)$/, /(collection|portfolio|group|set|user|account|condition|grad|rarity|category|line)[^.]*\./);
  if (!name) return null;
  const company = pick(f, /^(grad(e|ing)_?(company|service|provider|er)|grader|company)$/), gval = pick(f, /^(grade_?(label|value|number|score)?|grade)$/, /company|service/);
  let grade = "Ungraded";
  if (company && gval == null) grade = String(company).toUpperCase();
  else if (company && !/^ungraded$/i.test(String(gval))) { const gn = /\d+(?:\.\d)?/.exec(String(gval)); grade = `${String(company).toUpperCase()} ${gn ? gn[0] : gval}`; }
  else if (gval != null && /[a-z]{2,}\s*\d/i.test(String(gval))) grade = String(gval);
  const n = (v) => { const x = parseFloat(String(v ?? "").replace(/[$,]/g, "")); return isFinite(x) ? x : null; };
  // Collectr's product numbers are TCGplayer's for TCGplayer products; its own (Japanese and other) items are 10,000,000 and up
  const pid = pick(f, /^product_?id$/), tid = pick(f, /^(tcg_?player_?(product_?)?id|tcgplayerid|external_?product_?id)$/) || (pid && /^\d+$/.test(String(pid)) && +pid < 1e7 ? pid : null);
  const img = pick(f, /^(image_?url|img_?url|image|photo_?url|thumbnail)$/);
  return { id: uid(), pf: String(o.__pf || pick(f, /^(collection_?name|portfolio_?name|collection_?title)$/) || "").trim(),
    cat: String(pick(f, /^(product_?line(_?name)?|category(_?name)?|game|catalog_?category(_?name)?)$/) || "Pokemon").replace(/^pok[eé]mon.*$/i, "Pokemon"),
    set: String(pick(f, /^(catalog_?group(_?name)?|group_?name|set_?name|expansion(_?name)?|set)$/, /\.id$/) || "").trim(),
    name: String(name).trim(), num: String(pick(f, /^(card_?number|collector_?number|number)$/) || "").trim(), rarity: String(pick(f, /^rarity(_?name)?$/) || ""),
    var: String(pick(f, /^(variance|printing|variant|(product_?)?sub_?type(_?name)?)$/) || ""), grade, cond: grade === "Ungraded" ? normCond(pick(f, /^(card_?)?condition(_?name)?$/)) : "Near Mint",
    cost: n(pick(f, /^(average_?cost(_?paid)?|avg_?cost|purchase_?price|cost_?paid|cost_?basis|paid)$/)) || 0,
    qty: Math.max(1, Math.round(n(pick(f, /^(quantity|qty|count|owned_?quantity)$/)) || 1)),
    mkt: null, ovr: n(pick(f, /^price_?override$/)) || 0, watch: o.watchlist === true, added: today(), notes: "", sealed: o.is_card === false || undefined,
    tcgId: tid && /^\d+$/.test(String(tid)) ? String(tid) : null, img: /^https:\/\//.test(String(img || "")) ? String(img) : undefined, src: "collectr-link" };
}
function cimpReceive(d) {
  const items = (d.items || []).map(mapCollectr).filter(Boolean);
  cimp = items.length ? { status: "ready", items, raw: d } : { status: "error", raw: d, msg: "Couldn't read the cards from that page." };
  const b = $("tb").querySelector('[data-t="pf"]'); if (b && tab !== "pf") b.click(); detail = null; render(); scrollTo(0, 0);
}
addEventListener("message", (e) => { if (COLLECTR_ORIGIN.test(e.origin) && e.data && e.data.type === "collectr-import" && cimp && cimp.status === "waiting") cimpReceive(e.data); });
if (/^#ci=/.test(location.hash)) {
  const code = location.hash.slice(4); cimp = { status: "waiting" };
  try { history.replaceState(null, "", location.pathname); } catch {}
  setTimeout(() => { const b = $("tb").querySelector('[data-t="pf"]'); if (b) b.click(); render(); }, 0);
  (code === "bad" ? Promise.reject(new Error("The cards didn't come through. Go back to your Collectr showcase and run Send to Price Plot again.")) : getJSON("/api/handoff/" + encodeURIComponent(code)))
    .then((j) => { if (j.raw) cimpReceive(j.raw); else { cimp = { status: "ready", items: j.items || [], raw: { count: (j.items || []).length } }; render(); } })
    .catch((e) => { cimp = { status: "error", msg: e.message }; render(); });
} else if (location.hash === "#collectr-import") {
  cimp = { status: "waiting" };
  try { history.replaceState(null, "", location.pathname); } catch {}
  setTimeout(() => { const b = $("tb").querySelector('[data-t="pf"]'); if (b) b.click(); render(); }, 0);
  let tries = 0; const ping = setInterval(() => { if (!cimp || cimp.status !== "waiting" || ++tries > 90) { clearInterval(ping); if (cimp && cimp.status === "waiting") { cimp = { status: "error", msg: "No cards arrived from the Collectr tab. Keep that tab open, wait for your cards to show, and tap the bookmark again." }; render(); } return; }
    try { window.opener && window.opener.postMessage({ type: "pp-ready" }, "*"); } catch {} }, 700);
}
function cimpPanel() {
  if (!cimp) return "";
  if (cimp.status === "waiting") return `<div class="pbx"><b>Reading your Collectr showcase…</b><div class="sm">Keep the Collectr tab open. This can take a minute for big collections.</div></div>`;
  const diag = `<button class="pill" type="button" data-cx2="copy">Copy details for Claude</button><button class="pill" type="button" data-cx2="cancel">Close</button>`;
  if (cimp.status === "error") return `<div class="pbx"><b>${esc(cimp.msg || "Import didn't work.")}</b><div class="sm">Wait until all your cards show on the showcase page before tapping the bookmark. If it keeps failing, copy the details and send them to Claude.</div><div class="bar">${diag}</div></div>`;
  const it = cimp.items, copies = it.reduce((a, x) => a + x.qty, 0), pfs = new Set(it.map((x) => x.pf).filter(Boolean)), noSet = it.filter((x) => !x.set).length;
  return `<div class="pbx"><b>Found ${copies.toLocaleString()} card${copies === 1 ? "" : "s"}</b> <span class="mu">(${it.length.toLocaleString()} entries${pfs.size ? " in " + pfs.size + " portfolio" + (pfs.size === 1 ? "" : "s") : ""})</span>
  <div class="cimp-l">${it.slice(0, 6).map((x) => `<div>${esc(x.name)} <span class="mu">${esc([x.set, x.num].filter(Boolean).join(" · "))} · ${esc(isGraded(x) ? shortGrade(x.grade) : COND_CODE[x.cond] || x.cond)} × ${x.qty}</span></div>`).join("")}${it.length > 6 ? `<div class="mu">…and ${(it.length - 6).toLocaleString()} more</div>` : ""}</div>
  ${noSet > it.length / 2 ? `<div class="sm" style="color:var(--dn)">Most cards came in without a set name, so matching may be off. Copy the details for Claude if the cards look wrong.</div>` : ""}
  ${((cimp.raw && cimp.raw.log) || []).some((l) => /^PARTIAL/.test(l)) ? `<div class="sm" style="color:var(--dn)">Collectr asked Price Plot to slow down, so some cards may be missing. Import these now, then wait an hour, run Send to Price Plot again and tap “Add to my portfolio” to fill in the rest.</div>` : ""}
  ${cimp.raw && cimp.raw.portfolio ? `<div class="sm">These are the cards in <b>${esc(cimp.raw.portfolio)}</b>.${(cimp.raw.others || []).length ? ` To bring in ${esc(cimp.raw.others.join(" or "))}, switch the portfolio on your Collectr showcase, wait for it to load, and run Send to Price Plot again.` : ""}</div>` : ""}
  <div class="sm">Prices come from TCGplayer and fill in after import.</div>
  <div class="bar">${P.items.length ? `<button class="pill on" type="button" data-cx2="merge">Add to my portfolio</button><button class="pill" type="button" data-cx2="replace">${cimp.raw && cimp.raw.portfolio ? "Replace " + esc(cimp.raw.portfolio) + " only" : "Replace my portfolio"}</button>` : `<button class="pill on" type="button" data-cx2="replace">Import</button>`}
  ${typeof HOME_APP !== "undefined" && !HOME_APP ? `<button class="pill" type="button" data-cx2="code">Send to my Price Plot app</button>` : ""}${diag}</div></div>`;
}
async function cimpAction(a) {
  if (a === "cancel") { cimp = null; render(); return; }
  if (a === "copy") { const d = cimp.raw || {}, txt = JSON.stringify({ v: d.v, page: d.page, used: d.used, count: d.count, log: d.log, first: (d.items || []).slice(0, 2), sample: (d.sample || "").slice(0, 2500), mapped: (cimp.items || []).slice(0, 2) }, null, 1);
    try { await navigator.clipboard.writeText(txt); toast("Copied. Paste it into your chat with Claude."); } catch { modal({ title: "Copy these details", text: `<textarea readonly style="width:100%;height:160px;font:12px monospace">${esc(txt)}</textarea>`, buttons: [{ label: "Done", value: 1, kind: "primary" }] }); } return; }
  if (a === "code") {
    try { const r = await fetch("/api/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: cimp.items }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
      await modal({ title: `Your code: ${j.code}`, text: "Open the Price Plot app from your home screen, go to Portfolio → From a Collectr link, and enter this code. It works once and expires in 30 minutes.", buttons: [{ label: "Done", value: 1, kind: "primary" }] });
    } catch (e) { toast("Couldn't make a code: " + e.message); } return; }
  if (a === "merge" || a === "replace") {
    const only = cimp.raw && cimp.raw.portfolio;
    if (a === "replace" && P.items.length && !(await modal({ title: only ? `Replace ${only}?` : "Replace your whole portfolio?", text: only ? `Every card in ${esc(only)} in Price Plot is removed first, then these Collectr cards are added. Your other portfolios aren't touched.` : "Every card in Price Plot is removed first, then your Collectr cards are added.", buttons: [{ label: "Replace", value: true, kind: "danger" }, { label: "Cancel", value: false }] }))) return;
    const items = cimp.items;
    if (a === "replace") P.items = only ? P.items.filter((x) => x.pf !== only).concat(items) : items;
    else { const at = new Map(P.items.map((x, i) => [keyOf(x), i])); for (const x of items) { const k = keyOf(x); if (at.has(k)) { const o = P.items[at.get(k)]; o.qty = x.qty; if (x.cost) o.cost = x.cost; } else { at.set(k, P.items.length); P.items.push(x); } } }
    P.source = "Collectr link"; store(); cimp = null; view = "all"; shown = PAGE; render(); fillPrices();
    toast(`Imported ${items.length.toLocaleString()} entries from Collectr`);
  }
}
// The iCloud link of the shared "Send to Price Plot" Shortcut. Empty until it has been built and shared once.
const SHORTCUT_URL = "https://www.icloud.com/shortcuts/73e3a76a379841a097a0df146ef1da7e";
async function cimpSetup() {
  let code = "";
  try { code = await (await fetch("/collectr-bookmark.js", { cache: "no-store" })).text(); } catch {}
  const bm = code ? "javascript:" + encodeURIComponent(code.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/\n\s*/g, " ").trim()) : "";
  const chrome = `<ol>
    <li><button type="button" class="ppm-x primary" data-s="copybm">Copy bookmark code</button></li>
    <li><b>Make a bookmark:</b> on this page, tap Chrome's <b>⋮</b> (or <b>•••</b>) menu → the <b>☆</b> star or <b>Add to Bookmarks</b>. On a computer, press <b>Ctrl+D</b> (<b>⌘D</b> on a Mac).</li>
    <li><b>Put the code in it:</b> open <b>Bookmarks</b>, find the new one, and choose <b>Edit</b>. Name it <b>Send to Price Plot</b>, replace its URL with the code you copied, and save.</li>
    <li><b>Use it:</b> open your Collectr showcase in Chrome and wait for the cards. Tap the address bar, type <b>Send to</b>, and tap <b>Send to Price Plot</b> in the suggestions. On a computer you can also click it in the bookmarks bar.</li></ol>
    ${bm ? `<p class="mu">On a computer, you can instead drag this to your bookmarks bar: <a class="pill" href="${esc(bm)}" onclick="return false">Send to Price Plot</a></p>` : ""}
    <p class="mu">If you sign into Chrome, a bookmark made on a computer shows up on your phone too.</p>`;
  const use = `<p><b>Each time:</b> open your Collectr showcase link in Safari and wait for your cards to show. Tap <b>Share</b> (the square with an arrow), scroll down the list and tap <b>Send to Price Plot</b>. If it isn't there, tap <b>Edit Actions…</b> at the bottom and turn it on. Price Plot opens with your cards to review.</p>`;
  const build = `<ol>
    <li>Open the <b>Shortcuts</b> app, tap <b>+</b>, and name the shortcut <b>Send to Price Plot</b>.</li>
    <li>Add the action <b>Get Contents of URL</b> and set its address to <b>https://price-plot.onrender.com/collectr-bookmark.js</b>. This keeps the Shortcut up to date by itself.</li>
    <li>Add the action <b>Run JavaScript on Web Page</b> below it. Tap the blue word after "on" and pick <b>Shortcut Input</b>.</li>
    <li>Tap inside its code, select all and delete it. Then tap <b>Contents of URL</b> in the bar above the keyboard, so that's the only thing in the code box.</li>
    <li>Tap the shortcut's name at the top → <b>Details</b> → turn on <b>Show in Share Sheet</b>. At the top of the editor, tap the blue word after "Receive" and pick only <b>Safari web pages</b>. Tap <b>Done</b>.</li>
    <li>In <b>Settings → Apps → Shortcuts → Advanced</b>, turn on <b>Allow Running Scripts</b>.</li></ol>
    <p class="mu">If step 4 won't let you insert Contents of URL, paste the code instead: <button type="button" class="pill" data-s="copy" style="padding:3px 10px">Copy code</button> (you'd then repeat this whenever Price Plot updates it).</p>
    <p class="mu">To share it: in Shortcuts, hold the shortcut → <b>Share</b> → <b>Copy iCloud Link</b>, and send that link to Claude to update the Install button.</p>`;
  const ov = document.createElement("div"); ov.className = "ppm-ov";
  ov.innerHTML = `<div class="ppm cimp-s" role="dialog" aria-modal="true" aria-labelledby="cs-t"><h3 id="cs-t">Import from a Collectr link</h3>
  <div data-pane="pick"><p class="mu">Works without Collectr PRO. Which browser do you use to open your Collectr showcase?</p>
    <div class="cs-pick"><button type="button" data-s="safari"><b>Safari</b><span>iPhone or iPad</span></button><button type="button" data-s="chrome"><b>Chrome</b><span>iPhone, Android or computer</span></button></div></div>
  <div data-pane="safari" hidden><button type="button" class="cs-back" data-s="pick">‹ Choose a different browser</button><p class="cs-h"><b>Safari</b> · iPhone or iPad</p>
  ${SHORTCUT_URL ? `<p><b>Once:</b></p><a class="ppm-x primary" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="${esc(SHORTCUT_URL)}" target="_blank" rel="noopener">Install the Shortcut</a>
    <p class="mu" style="margin-top:8px">Tap <b>Add Shortcut</b>. Then in <b>Settings → Apps → Shortcuts → Advanced</b>, turn on <b>Allow Running Scripts</b>.</p>${use}
    <details style="margin-top:8px"><summary class="mu">Build the Shortcut yourself instead</summary>${build}</details>`
  : `<p><b>Once — build the Shortcut</b> (about 2 minutes):</p>${build}${use}`}</div>
  <div data-pane="chrome" hidden><button type="button" class="cs-back" data-s="pick">‹ Choose a different browser</button><p class="cs-h"><b>Chrome</b> · iPhone, Android or computer</p>${chrome}</div>
  <p class="mu" style="margin-top:12px">Using the Price Plot home-screen app? After your browser shows your cards, tap “Send to my Price Plot app” there for a code, then enter it here:</p>
  <div class="cimp-c"><input id="cs-code" maxlength="6" placeholder="Code" autocapitalize="characters" autocomplete="off" aria-label="Import code"><button type="button" class="ppm-x" data-s="code">Get cards</button></div>
  <div class="ppm-b"><button type="button" class="ppm-x plain" data-s="close">Close</button></div></div>`;
  const close = () => ov.remove();
  ov.addEventListener("click", async (e) => { const s = e.target.closest("[data-s]")?.dataset.s; if (!s) { if (e.target === ov) close(); return; }
    if (s === "close") close();
    else if (s === "pick" || s === "safari" || s === "chrome") { ov.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== s)); ov.querySelector(".ppm").scrollTop = 0; }
    else if (s === "copy") { if (!code) return toast("Couldn't load the code. Check your connection."); try { await navigator.clipboard.writeText(code); e.target.textContent = "Copied ✓"; } catch { const t = document.createElement("textarea"); t.value = code; t.style.cssText = "width:100%;height:90px;font:11px monospace"; e.target.replaceWith(t); t.select(); toast("Copy the code from the box."); } }
    else if (s === "copybm") { if (!bm) return toast("Couldn't load the code. Check your connection."); try { await navigator.clipboard.writeText(bm); e.target.textContent = "Copied ✓"; } catch { const t = document.createElement("textarea"); t.value = bm; t.style.cssText = "width:100%;height:90px;font:11px monospace"; e.target.replaceWith(t); t.select(); toast("Copy the code from the box."); } }
    else if (s === "code") { const c = ov.querySelector("#cs-code").value.trim(); if (!c) return;
      try { const r = await fetch("/api/handoff/" + encodeURIComponent(c)); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); close(); if (j.raw) cimpReceive(j.raw); else { cimp = { status: "ready", items: j.items, raw: { count: j.items.length } }; render(); } scrollTo(0, 0); }
      catch (err) { toast(err.message); } } });
  document.body.appendChild(ov);
}

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
  if (old && x.pT && (old.cond !== x.cond || old.var !== x.var || old.name !== x.name)) { x.mktV = 0; x.pTry = 0; }
  const unpriced = old && old.ovr > 0 && !(x.ovr > 0); if (unpriced) x.pTry = 0;
  if (old) Object.assign(old, x); else P.items.push(x);
  editing = null; store(); snap(); render();
  // you removed your own price: look this card's TCGplayer price up now, ahead of the background queue
  const it = old || x;
  if (unpriced && it.mkt == null) {
    const i = pfq.indexOf(it); if (i >= 0) { pfq.splice(i, 1); pfTotal = Math.max(0, pfTotal - 1); }
    priceOne(it).then((ok) => { it.pTry = Date.now(); store(); snap(); if (!detail && !editing) render(); if (!ok) toast(`TCGplayer has no price for ${it.name} in ${it.cond || "this condition"}`); });
  }
  fillPrices();
}
document.addEventListener("click", (e) => {
  const box = $("pf"); if (!box || !box.contains(e.target)) return;
  const dot = e.target.closest && e.target.closest("[data-u]"); if (dot) { if (dot.dataset.u) openLink(dot.dataset.u); return; }
  if (Date.now() - swJust < 400) return;
  const btn = e.target.closest("button");
  const openRow = document.querySelector("#pf .pr.open"); if (openRow && !(btn && btn.dataset.trash)) { closeSwipes(); return; }
  if (!btn) { const row = !e.target.closest("a,input,select,label,form") && e.target.closest(".pr[data-id]"); if (row && editing !== row.dataset.id) openDetail(row.dataset.id); return; }
  const d = btn.dataset;
  if (d.czr) { cSet({ x0: -Infinity, x1: Infinity, y0: -Infinity, y1: Infinity }); return; }
  if (d.dr) { drng = d.dr; cview = null; render(); return; }
  if (d.dc) { dsel = d.dc; cview = null; render(); return; }
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
  else if (d.del) askRemove(d.del);
  else if (d.trash) askRemove(d.trash);
  else if (d.pa === "merge" || d.pa === "replace") applyImport(d.pa);
  else if (d.pa === "cancel") { pending = null; $("pfi").hidden = true; }
  else if (d.pa === "clink") cimpSetup();
  else if (d.cx2) cimpAction(d.cx2);
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
setTimeout(fillPrices, 1500);
})();
