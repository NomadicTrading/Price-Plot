/* Portfolio: log your collection, track its total value, and import a Collectr export (.csv or .xlsx).
   Everything is saved on this device (localStorage), so it works on Render's free tier with no database.
   Relies on helpers from the main script: $, esc, money, load, tab, tcgQ. */
(() => {
const KEY = "pp_portfolio", HKEY = "pp_portfolio_hist";
const CONDS = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];
const PAGE = 50;
let P = readStore(), view = "all", sortBy = "value", findTxt = "", shown = PAGE, editing = null, pending = null, impOpen = false;
let selMode = false, selJust = 0, selJustId = "";
// portfolio filters: kind, condition, gain, value range (each), set, added, needs attention. Remembered on this device.
let PFF = (() => { try { const f = JSON.parse(localStorage.getItem("pp_pffilter") || "{}") || {}; delete f.gain; delete f.added; delete f.attn; return f; } catch { return {}; } })(), pffOpen = false; const selIds = new Set(); // selecting several cards (press and hold a card)
/* ---------- trade analyzer ----------
   Your cards: cards from your portfolio (or found on TCGplayer), at their full market value.
   Their cards: the trader's cards (TCGplayer search or the scanner), counted at a trade % (list-wide, or per card).
   Your position = their trade credit + cash they add − (your cards + cash you add): green when you come out ahead.
   Their cards needed = what you give (net of cash) ÷ the trade %: the reverse calculation ($80 at 80% → $100).
   Graded cards are valued at Collectr's price (from your portfolio); a graded card you don't own needs its price typed.
   The trade is saved on this device as you go, and Complete trade updates the portfolio (with Undo). */
const TR_KEY = "pp_trade";
const TR_GRADES = ["PSA 10", "PSA 9", "PSA 8", "PSA 7", "CGC 10", "CGC 9.5", "CGC 9", "BGS 10", "BGS 9.5", "BGS 9", "TAG 10", "TAG 9"];
let tradeOpen = false, trFind = "", trSug = [], trSugT = 0, trSugSide = "";
let TRD = (() => { try { const t = JSON.parse(localStorage.getItem(TR_KEY) || "null"); if (t && Array.isArray(t.give) && Array.isArray(t.get)) return t; } catch {} return null; })() || { give: [], get: [], pct: 80, cashPct: 70, cashIn: 0, cashOut: 0 };
const trSave = () => { try { localStorage.setItem(TR_KEY, JSON.stringify(TRD)); } catch {} };
const trQ = (c) => Math.max(1, Math.round(+c.qty || 1));
const trSrc = (c) => (c.pid ? P.items.find((x) => x.id === c.pid) : null);
const trGraded = (c) => !!c.grade && !/^ungraded$/i.test(c.grade);
// one card's market value each: your typed price, else the portfolio card's own value, else TCGplayer's (Collectr's for graded)
function trEach(c) {
  if (c.own > 0) return c.own;
  const src = trSrc(c);
  const gr = (x) => (x.grade && !/^ungraded$/i.test(x.grade) ? shortGrade(x.grade) : "");
  if (src && (src.ovr > 0 || src.mkt != null) && (gr(src) ? gr(src) === gr(c) : !gr(c) && (src.cond || "Near Mint") === (c.cond || "Near Mint")) && (src.var || "") === (c.var || "")) return unit(src);
  return c.px > 0 ? c.px : null;
}
const trPctOf = (c) => (c.pct != null ? c.pct : TRD.pct);
function trMath() {
  const give = TRD.give.reduce((a, c) => a + (trEach(c) || 0) * trQ(c), 0);
  const getMk = TRD.get.reduce((a, c) => a + (trEach(c) || 0) * trQ(c), 0);
  const credit = TRD.get.reduce((a, c) => a + (trEach(c) || 0) * trQ(c) * trPctOf(c) / 100, 0);
  const cin = +TRD.cashIn || 0, cout = +TRD.cashOut || 0;
  const pos = credit + cin - give - cout, owed = Math.max(0, give + cout - cin);
  const missing = [...TRD.give, ...TRD.get].filter((c) => !(trEach(c) > 0)).length;
  return { give, getMk, credit, pos, need: TRD.pct > 0 ? owed / (TRD.pct / 100) : null, cash: getMk * (TRD.cashPct || 0) / 100, missing };
}
// TCGplayer price for a card's condition and printing; graded cards take Collectr's price from a matching portfolio card
async function trPrice(c) {
  const k = [c.cond, c.var, c.grade].join("|"); if (c.pxK === k) return; c.pxK = k; c.px = null; c.pxNote = "";
  if (trGraded(c)) {
    const g = shortGrade(c.grade).toLowerCase(), m = P.items.find((x) => isGraded(x) && x.mkt > 0 && mName(x.name) === mName(c.name) && mNum(x.num) === mNum(c.num) && shortGrade(x.grade).toLowerCase() === g);
    if (m) { c.px = m.mkt; c.pxNote = "Collectr"; } else c.pxNote = "type Collectr's price";
    return trDraw();
  }
  trDraw();
  try {
    if (!c.tcgId) { const j = await getJSON("/api/cardimg?" + new URLSearchParams({ name: c.name, set: c.set || "", num: c.num || "", cat: "Pokemon" })); if (j && j.tcgId) { c.tcgId = j.tcgId; if (!c.img && j.img) c.img = j.img; } }
    if (c.tcgId) { const j = await getJSON("/api/tcgprice?" + new URLSearchParams({ id: c.tcgId, cond: c.cond || "Near Mint", print: c.var || "", jp: /japan/i.test(c.set || "") ? "1" : "", live: "1" })); if (c.pxK === k) { c.px = j.market > 0 ? j.market : null; c.pxNote = j.market > 0 ? (j.est ? "est." : "") : j.why || "no TCGplayer price"; } }
    else c.pxNote = "not found on TCGplayer";
  } catch { c.pxNote = "TCGplayer didn't answer"; }
  trSave(); trDraw();
}
function trCard(src, side) {
  return { id: uid(), side, pid: src.pid || null, name: src.name, set: src.set || "", num: src.num || "", var: src.var || "", cond: src.cond || "Near Mint", grade: src.grade && !/^ungraded$/i.test(src.grade) ? src.grade : "",
    img: src.img || "", tcgId: src.tcgId || null, qty: src.qty || 1, max: src.max || null, px: src.px ?? null, pxK: src.px != null ? [src.cond || "Near Mint", src.var || "", src.grade || ""].join("|") : null, own: 0, pct: null };
}
function trAddFromPortfolio(x) {
  const have = TRD.give.find((c) => c.pid === x.id);
  if (have) { if (have.qty < x.qty) have.qty++; else toast(`You have ${x.qty} of these`); }
  else TRD.give.push(trCard({ ...x, pid: x.id, qty: 1, max: x.qty, grade: isGraded(x) ? x.grade : "" }, "give"));
  trSave(); trDraw();
}
function trAddFound(s, side) {
  const c = trCard({ name: s.name, set: s.set, num: s.numberText || s.number, var: s.print || "", tcgId: s.tcgId, img: s.image, cond: "Near Mint", px: s.print && s.nm > 0 && !s.overall ? s.nm : null }, side);
  (side === "give" ? TRD.give : TRD.get).push(c); trSave(); trDraw(); if (c.px == null) trPrice(c);
}

/* drawing */
const trMoneyIn = (v) => (v > 0 ? (Math.round(v * 100) / 100).toFixed(2) : "");
function trRow(c) {
  const each = trEach(c), q = trQ(c), get = c.side === "get", pc = trPctOf(c);
  const opts = [...CONDS, ...TR_GRADES].map((o) => `<option ${o === (c.grade ? shortGrade(c.grade) : c.cond) ? "selected" : ""}>${o}</option>`).join("");
  const note = c.own > 0 ? "your price" : trSrc(c) && each != null && c.px == null ? "portfolio value" : c.pxNote || (c.px == null && !trGraded(c) ? "looking up…" : "");
  return `<div class="tr-r" data-tc="${c.id}">
    <button type="button" class="tr-pic" data-tzm="${c.id}" ${c.img ? "" : "disabled"} aria-label="Enlarge picture">${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy">` : ""}</button>
    <div class="tr-m"><b>${esc(c.name)}</b><div class="mu">${esc([c.set, c.num].filter(Boolean).join(" · "))}${c.pid ? " · from your portfolio" : ""}</div>
      <div class="tr-v" data-tv="${c.id}">${trValTxt(c)}</div></div>
    <button type="button" class="sq-x" data-tdel="${c.id}" aria-label="Remove from trade">✕</button>
    <div class="tr-f">
      <select data-tf="cond" data-tid="${c.id}" aria-label="Condition or grade">${opts}</select>
      <select data-tf="var" data-tid="${c.id}" aria-label="Printing">${printOpts(printsCache.get(String(c.tcgId)) || (c.tcgId ? (c.var ? [c.var] : []) : PRINTS_ANY), c.var || "")}${!c.var && !printsCache.get(String(c.tcgId)) && c.tcgId ? `<option value="" selected disabled>Printing…</option>` : ""}</select>
      <label class="tr-q">×<input data-tf="qty" data-tid="${c.id}" type="number" min="1" ${c.max ? `max="${c.max}"` : ""} step="1" inputmode="numeric" value="${q}" aria-label="Quantity"></label>
      <label class="tr-p">$<input data-tf="own" data-tid="${c.id}" type="number" min="0" step="any" inputmode="decimal" value="${trMoneyIn(c.own)}" placeholder="${each != null && !(c.own > 0) ? (Math.round(each * 100) / 100).toFixed(2) : "Price"}" aria-label="Price each (leave blank for market)"></label>
      ${get ? `<label class="tr-c"><input data-tf="pct" data-tid="${c.id}" type="number" min="0" step="any" inputmode="decimal" value="${c.pct != null ? c.pct : ""}" placeholder="${TRD.pct}" aria-label="Trade percent for this card">%</label>` : ""}
    </div>${note ? `<div class="tr-n mu">${esc(note)}</div>` : ""}</div>`;
}
function trValTxt(c) {
  const each = trEach(c), q = trQ(c);
  if (each == null) return `<span class="mu">no price yet</span>`;
  const tot = each * q;
  if (c.side === "give") return `<b>${money(tot)}</b>${q > 1 ? ` <span class="mu">(${q} × ${money(each)})</span>` : ""}`;
  return `<b>${money(tot * trPctOf(c) / 100)}</b> <span class="mu">credit · ${money(tot)} at ${trPctOf(c)}%</span>`;
}
function trBalHTML() {
  const m = trMath(), up = m.pos >= -0.005;
  return `<div class="tr-pos" style="color:var(${up ? "--up" : "--dn"})">${up ? "+" : "−"}${money(Math.abs(m.pos))}</div>
    <div class="tr-st"><span>Your cards <b>${money(m.give)}</b></span><span>Their cards <b>${money(m.getMk)}</b> <span class="mu">= ${money(m.credit)} credit</span></span>
    <span>Their cards needed <b>${m.need != null ? money(m.need) : "—"}</b> <span class="mu">at ${TRD.pct}%</span></span>
    <span>Cash offer for their cards <b>${money(m.cash)}</b> <span class="mu">at ${TRD.cashPct}%</span></span></div>
    ${m.missing ? `<div class="mu" style="font-size:12.5px">${m.missing} card${m.missing === 1 ? " has" : "s have"} no price yet and count as $0.</div>` : ""}`;
}
// update the numbers in place (so typing in a box isn't interrupted)
function trDraw() {
  if (!tradeOpen) return;
  const b = $("tr-bal"); if (!b) return render();
  b.innerHTML = trBalHTML();
  for (const c of [...TRD.give, ...TRD.get]) { const v = document.querySelector(`[data-tv="${c.id}"]`); if (v) v.innerHTML = trValTxt(c); }
  const pr = $("tr-pr"); if (pr) pr.querySelectorAll("[data-tpp]").forEach((x) => x.setAttribute("aria-pressed", String(+x.dataset.tpp === TRD.pct)));
}
function trPickHTML() {
  const w = trFind.toLowerCase().split(/\s+/).filter(Boolean);
  if (!w.length) return "";
  const hits = owned(P.items).filter((x) => { const t = [x.name, x.set, x.num, x.var, x.grade, x.cond].join(" ").toLowerCase(); return w.every((k) => t.includes(k)); }).slice(0, 8);
  return hits.length ? hits.map((x) => `<button type="button" class="tr-hit" data-tpick="${x.id}">${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy">` : `<span class="ph"></span>`}<span class="sug-m"><b>${esc(x.name)}</b><span>${esc([x.set, x.num, isGraded(x) ? shortGrade(x.grade) : COND_CODE[x.cond] || x.cond, x.var].filter(Boolean).join(" · "))} · you have ${x.qty}</span></span><span class="sug-v">${x.mkt == null && !(x.ovr > 0) ? "–" : money(unit(x))}</span></button>`).join("")
    : `<div class="sug-n">No cards in your portfolio match.</div>`;
}
function trSugHTML(side) {
  if (trSugSide !== side) return "";
  if (trSug === null) return `<div class="sug-n">Looking on TCGplayer…</div>`;
  return trSug.length ? trSug.map((s, i) => `<button type="button" class="tr-hit" data-tsug="${i}" data-tside="${side}">${s.image ? `<img src="${esc(s.image)}" alt="" loading="lazy">` : `<span class="ph"></span>`}<span class="sug-m"><b>${esc(s.name)}</b><span>${esc([s.numberText || s.number, s.set].filter(Boolean).join(" · "))}</span>${s.print ? `<i class="sug-p">${esc(s.print)}</i>` : ""}</span><span class="sug-v">${s.nm != null ? money(s.nm) : "–"}<small>${s.overall ? "market" : "NM"}</small></span></button>`).join("") : `<div class="sug-n">No TCGplayer matches.</div>`;
}
function renderTrade(box) {
  box.innerHTML = `<div class="tr">
  <div class="cdx-top"><button class="pill" type="button" data-tx="back">‹ Portfolio</button><b class="tr-t">Trade</b>${TRD.give.length || TRD.get.length ? `<button class="pill sm2" type="button" data-tx="clear">Clear</button>` : "<span></span>"}</div>
  <div class="tr-bal" id="tr-bal">${trBalHTML()}</div>
  <div class="tr-sec"><div class="tr-h"><b>Their trade %</b><label class="sq-pn"><input id="tr-pct" type="number" min="0" step="any" inputmode="decimal" value="${TRD.pct}" aria-label="Trade percent for their cards">%</label></div>
    <input type="range" class="sq-rg" id="tr-rg" min="0" max="100" step="1" value="${Math.min(100, Math.round(TRD.pct))}" aria-label="Trade percent for their cards">
    <div class="sq-pp" id="tr-pr">${SQ_PRESETS.map((x) => `<button type="button" class="sq-pb" data-tpp="${x}" aria-pressed="${TRD.pct === x}">${x}%</button>`).join("")}</div>
    <div class="tr-cash"><label>Cash they add $<input id="tr-cin" type="number" min="0" step="any" inputmode="decimal" value="${trMoneyIn(TRD.cashIn)}" placeholder="0"></label><label>Cash you add $<input id="tr-cout" type="number" min="0" step="any" inputmode="decimal" value="${trMoneyIn(TRD.cashOut)}" placeholder="0"></label><label>Cash offer %<input id="tr-cpct" type="number" min="0" step="any" inputmode="decimal" value="${TRD.cashPct}"></label></div></div>
  <div class="tr-sec"><div class="tr-h"><b>Your cards</b><span class="mu">${TRD.give.length} card${TRD.give.length === 1 ? "" : "s"}</span></div>
    ${TRD.give.map(trRow).join("")}
    <div class="tr-add"><input id="tr-find" type="search" placeholder="Add from your portfolio…" value="${esc(trFind)}" autocomplete="off"><button type="button" class="pill" data-tx="scang">📷 Scan</button></div>
    <div class="tr-hits" id="tr-hits">${trPickHTML()}</div>
    <input id="tr-sq-give" type="search" placeholder="…or search TCGplayer" autocomplete="off"><div class="tr-hits" id="tr-sug-give">${trSugHTML("give")}</div></div>
  <div class="tr-sec"><div class="tr-h"><b>Their cards</b><span class="mu">${TRD.get.length} card${TRD.get.length === 1 ? "" : "s"}</span></div>
    ${TRD.get.map(trRow).join("")}
    <div class="tr-add"><input id="tr-sq-get" type="search" placeholder="Search their card on TCGplayer" autocomplete="off"><button type="button" class="pill" data-tx="scan">📷 Scan</button></div>
    <div class="tr-hits" id="tr-sug-get">${trSugHTML("get")}</div></div>
  <div class="bar"><button class="pill on" type="button" data-tx="done" ${TRD.give.length || TRD.get.length ? "" : "disabled"}>Complete trade</button></div>
  <div class="sm">Your cards count at full market value; theirs at the trade % (set one card's own % in its box). The green or red number is where you stand: trade credit plus cash they add, minus your cards and cash you add. Graded cards use Collectr's price.</div></div>`;
  for (const c of [...TRD.give, ...TRD.get]) { if (c.pxK !== [c.cond, c.var, c.grade].join("|") && !(c.pid && trEach(c) != null)) trPrice(c); trLoadPrints(c); trLive(c); }
}
// a live price found for one copy goes to every copy of the same card, condition and printing in all your portfolios
// (no extra lookups: it's the same TCGplayer price). Graded copies and prices you typed in are left alone.
function pfSetLive(x, px, est, live) {
  const same = (y) => y === x || (!isGraded(y) && !(y.ovr > 0) && (y.cond || "Near Mint") === (x.cond || "Near Mint") && mVar(y.var) === mVar(x.var) &&
    mName(y.name) === mName(x.name) && mNum(y.num) === mNum(x.num) &&
    ((y.tcgId && x.tcgId && String(y.tcgId) === String(x.tcgId)) || mSetWords(y.set).join(" ") === mSetWords(x.set).join(" ")));
  const differs = P.items.some((y) => same(y) && (Math.abs((y.mkt ?? -1) - px) >= 0.005 || !!y.mktEst !== !!est || y.mktV !== 2));
  if (!differs) return 0;
  let n = 0;
  for (const y of P.items) if (same(y)) { y.mkt = px; y.mktEst = !!est; y.mktV = 2; y.pT = Date.now(); if (live) y.mktLive = Date.now(); else delete y.mktLive; if (!y.tcgId && x.tcgId) y.tcgId = x.tcgId; delete y.pWhy; delete y.mktSrc; n++; }
  store(); return n;
}
// on load: copies of a card that has a live price from the last day take that price too (nothing is looked up)
function pfSpreadLive() {
  let n = 0;
  const live = P.items.filter((x) => x.mktLive && Date.now() - x.mktLive < 864e5 && x.mkt > 0 && !isGraded(x) && !(x.ovr > 0)).sort((a, b) => b.mktLive - a.mktLive);
  const done = new Set();
  for (const x of live) { if (done.has(x)) continue; const t = x.mktLive; n += pfSetLive(x, x.mkt, x.mktEst, true); x.mktLive = t;
    for (const y of P.items) if (y.mktLive >= Date.now() - 1000) { y.mktLive = t; done.add(y); } }
  if (n) { store(); if (!detail && !editing && !tradeOpen) render(); else trDraw(); }
}
setTimeout(pfSpreadLive, 0);
// your portfolio cards in a trade get TCGplayer's live price; when it differs, your portfolio is updated to it
// (raw cards only: graded cards keep Collectr's price). Checked at most every 6 hours per card.
async function trLive(c) {
  const x = c.pid && P.items.find((y) => y.id === c.pid);
  if (!x || isGraded(x) || c.grade || !x.tcgId || (c.cond || "Near Mint") !== (x.cond || "Near Mint") || (c.var || "") !== (x.var || "")) return;
  if (c.liveT && Date.now() - c.liveT < 6 * 3600e3) return;
  c.liveT = Date.now(); trSave();
  try {
    const j = await getJSON("/api/tcgprice?" + new URLSearchParams({ id: x.tcgId, cond: x.cond || "Near Mint", print: x.var || "", jp: isJp(x) ? "1" : "", live: "1" }));
    if (j.market > 0 && pfSetLive(x, j.market, j.est, j.live)) {
      trDraw();
      const pr = document.querySelector(`.tr [data-tid="${c.id}"][data-tf="own"]`); if (pr && !(c.own > 0)) pr.placeholder = (Math.round(unit(x) * 100) / 100).toFixed(2);
    }
  } catch { c.liveT = 0; }
}
// fill a card's Printing dropdown with what TCGplayer lists for it
async function trLoadPrints(c) {
  if (!c.tcgId || printsCache.get(String(c.tcgId))) return;
  try { printsCache.set(String(c.tcgId), (await getJSON("/api/tcgprints?id=" + encodeURIComponent(c.tcgId))).prints || []); } catch { return; }
  const list = printsCache.get(String(c.tcgId)); if (!list.length) return;
  if (!c.var) { c.var = list.find((p) => /holofoil/i.test(p) && !/reverse/i.test(p)) || list[0]; trSave(); trPrice(c); }
  document.querySelectorAll(`.tr select[data-tf="var"][data-tid="${c.id}"]`).forEach((s) => (s.innerHTML = printOpts(list, c.var)));
}

/* events */
document.addEventListener("click", (e) => {
  const root = e.target.closest && e.target.closest(".tr"); if (!root) return;
  const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
  if (d.tx === "back") { tradeOpen = false; render(); scrollTo(0, 0); }
  else if (d.tx === "clear") modal({ title: "Clear this trade?", text: "Both sides and the cash are emptied. Your portfolio isn't changed.", buttons: [{ label: "Clear", value: true, kind: "danger" }, { label: "Keep", value: false, kind: "primary" }] })
    .then((v) => { if (v) { TRD = { give: [], get: [], pct: TRD.pct, cashPct: TRD.cashPct, cashIn: 0, cashOut: 0 }; trSave(); render(); } });
  else if (d.tx === "scan") { sqTarget = "trade"; sqOpen(); }
  else if (d.tx === "scang") { sqTarget = "tradeGive"; sqOpen(); }
  else if (d.tx === "done") trComplete();
  else if (d.tpick) { const x = P.items.find((y) => y.id === d.tpick); if (x) { trAddFromPortfolio(x); trFind = ""; render(); } }
  else if (d.tsug != null) { const s = trSug[+d.tsug]; if (s) { trAddFound(s, d.tside); trSug = []; trSugSide = ""; render(); } }
  else if (d.tdel) { TRD.give = TRD.give.filter((c) => c.id !== d.tdel); TRD.get = TRD.get.filter((c) => c.id !== d.tdel); trSave(); render(); }
  else if (d.tpp) { TRD.pct = +d.tpp; trSave(); const n = $("tr-pct"), r = $("tr-rg"); if (n) n.value = TRD.pct; if (r) r.value = TRD.pct; trDraw(); trRowsPct(); }
  else if (d.tzm) { const c = [...TRD.give, ...TRD.get].find((x) => x.id === d.tzm); if (c) ppZoom([c.tcgId ? `https://tcgplayer-cdn.tcgplayer.com/product/${c.tcgId}_in_1000x1000.jpg` : "", c.img], c.name); }
});
// the list-wide % shows as the placeholder in each card's own % box
function trRowsPct() { document.querySelectorAll('.tr [data-tf="pct"]').forEach((i) => (i.placeholder = TRD.pct)); }
document.addEventListener("input", (e) => {
  const t = e.target; if (!t.closest || !t.closest(".tr")) return;
  if (t.id === "tr-pct" || t.id === "tr-rg") { if (t.value === "" || !Number.isFinite(+t.value)) return; TRD.pct = Math.max(0, Math.round(+t.value * 10) / 10); const o = t.id === "tr-pct" ? $("tr-rg") : $("tr-pct"); if (o) o.value = t.id === "tr-pct" ? Math.min(100, Math.round(TRD.pct)) : TRD.pct; trSave(); trDraw(); trRowsPct(); return; }
  if (t.id === "tr-cin" || t.id === "tr-cout" || t.id === "tr-cpct") { const v = Math.max(0, +t.value || 0); if (t.id === "tr-cin") TRD.cashIn = v; else if (t.id === "tr-cout") TRD.cashOut = v; else TRD.cashPct = v; trSave(); trDraw(); return; }
  if (t.id === "tr-find") { trFind = t.value; const h = $("tr-hits"); if (h) h.innerHTML = trPickHTML(); return; }
  if (t.id === "tr-sq-give" || t.id === "tr-sq-get") {
    const side = t.id === "tr-sq-give" ? "give" : "get", q = t.value.trim(); clearTimeout(trSugT);
    const box = $("tr-sug-" + side), other = $("tr-sug-" + (side === "give" ? "get" : "give")); if (other) other.innerHTML = "";
    if (q.length < 3) { trSug = []; trSugSide = ""; if (box) box.innerHTML = ""; return; }
    trSugSide = side; trSug = null; if (box) box.innerHTML = trSugHTML(side);
    trSugT = setTimeout(async () => { try { const j = await getJSON("/api/suggest?q=" + encodeURIComponent(q)); if (trSugSide !== side || t.value.trim() !== q) return; trSug = j.items || []; } catch { trSug = []; } const bx = $("tr-sug-" + side); if (bx) bx.innerHTML = trSugHTML(side); }, 400);
    return;
  }
  const c = [...TRD.give, ...TRD.get].find((x) => x.id === t.dataset.tid); if (!c) return;
  if (t.dataset.tf === "qty") { c.qty = Math.max(1, Math.min(c.max || 9999, Math.round(+t.value || 1))); }
  else if (t.dataset.tf === "own") c.own = Math.max(0, +t.value || 0);
  else if (t.dataset.tf === "pct") c.pct = t.value === "" || !Number.isFinite(+t.value) ? null : Math.max(0, +t.value);
  else return;
  trSave(); trDraw();
});
document.addEventListener("change", (e) => {
  const t = e.target; if (!t.closest || !t.closest(".tr")) return;
  const c = [...TRD.give, ...TRD.get].find((x) => x.id === t.dataset.tid); if (!c) return;
  if (t.dataset.tf === "cond") { if (TR_GRADES.includes(t.value)) { c.grade = t.value; c.cond = "Near Mint"; } else { c.grade = ""; c.cond = t.value; } trSave(); trPrice(c); render(); }
  else if (t.dataset.tf === "var") { c.var = t.value; trSave(); trPrice(c); render(); }
  else if (t.dataset.tf === "qty") { t.value = trQ(c); }
});

/* Complete trade: your cards leave the portfolio, theirs come in. What you gave (your cards at market, plus cash you
   added, less cash they added) becomes the cost of their cards, shared out by market value. */
async function trComplete() {
  const m = trMath(); if (!TRD.give.length && !TRD.get.length) return;
  const gave = Math.max(0, m.give + (+TRD.cashOut || 0) - (+TRD.cashIn || 0)), share = (c) => (m.getMk > 0 ? ((trEach(c) || 0) * trQ(c)) / m.getMk : TRD.get.length ? 1 / TRD.get.length : 0);
  const costEach = (c) => Math.round((gave * share(c) / trQ(c)) * 100) / 100;
  const pfs = [...new Set(P.items.filter((x) => x.qty > 0 && x.pf).map((x) => x.pf))].sort();
  const li = (a) => a.length ? `<ul class="mg-l">${a.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : `<div class="mu" style="font-size:13px">None</div>`;
  const out = TRD.give.filter((c) => c.pid).map((c) => `${c.name} ×${trQ(c)}`), notOwned = TRD.give.filter((c) => !c.pid).length;
  const inn = TRD.get.map((c) => `${c.name}${c.grade ? " · " + shortGrade(c.grade) : " · " + (COND_CODE[c.cond] || c.cond)} ×${trQ(c)} · cost ${money(costEach(c))} each`);
  const pf = await modal({ title: "Complete this trade?",
    text: `<b>Leaving your portfolio</b>${li(out)}${notOwned ? `<div class="mu" style="font-size:12.5px">${notOwned} card${notOwned === 1 ? " isn't" : "s aren't"} in your portfolio, so nothing to remove.</div>` : ""}<b>Coming in</b>${li(inn)}<div class="mu" style="font-size:12.5px">Their cards' cost is what you traded for them (${money(gave)}), shared by market value. You can undo this afterward. Add them to:</div>`,
    buttons: [...(pfs.length ? pfs : ["Trades"]).map((p, i) => ({ label: p, value: p, kind: i === 0 ? "primary" : "" })), ...(pfs.length && !pfs.includes("Trades") ? [{ label: "New: Trades", value: "Trades" }] : []), { label: "Cancel", value: null, kind: "plain" }] });
  if (pf == null) return;
  try { localStorage.setItem(UNDO_KEY, JSON.stringify({ at: Date.now(), source: "trade", P })); } catch {}
  for (const c of TRD.give) { const x = trSrc(c); if (x) x.qty = Math.max(0, x.qty - trQ(c)); }
  P.items = P.items.filter((x) => x.qty > 0 || x.watch);
  for (const c of TRD.get) {
    const each = trEach(c), g = trGraded(c);
    P.items.push({ id: uid(), pf, cat: "Pokemon", set: c.set, name: c.name, num: c.num, rarity: "", var: c.var, grade: g ? c.grade : "Ungraded", cond: c.cond, qty: trQ(c), cost: costEach(c),
      mkt: each ?? null, ...(g ? {} : c.px > 0 ? { mktV: 2, pT: Date.now() } : {}), ovr: 0, watch: false, added: today(), notes: "From a trade", img: c.img || undefined, tcgId: c.tcgId || undefined });
  }
  TRD = { give: [], get: [], pct: TRD.pct, cashPct: TRD.cashPct, cashIn: 0, cashOut: 0 }; trSave(); tradeOpen = false;
  store(); snap(); render(); fillPrices(); scrollTo(0, 0);
  toast("Trade completed", { label: "Undo", run: undoImport });
}


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
  if (idx.name == null) throw new Error("this doesn't look like a Collectr or Price Plot export (no Product Name column)");
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
  ${P.items.length ? `<div class="sm">“Add” merges: quantities follow Collectr, what you paid in Price Plot is kept, and you see every change before it happens. “Replace” clears your current portfolio first.</div>` : ""}`;
  $("pfi").hidden = false;
}

/* ---------- merging a Collectr import into the portfolio ----------
   Collectr is the up-to-date count of what you own; Price Plot is where what you paid is kept.
   Cards are matched by the card itself (name without Collectr's notes, card number, set, printing, grade,
   condition), across portfolio names, so a card scanned into Price Plot meets its Collectr entry.
   - quantity follows Collectr
   - Price Plot's cost is kept; Collectr's cost is used only where Price Plot has none
   - more copies in Collectr: added (to a copy without a cost, or as a new entry with Collectr's cost)
   - fewer copies in Collectr: copies without a cost go first, then the oldest paid-for copies
   - cards only in Price Plot are kept unless you choose to remove them */
const mName = (s) => String(s || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+-\s+[\w/]+$/, " ").replace(/[^a-z0-9]+/g, " ").trim();
const mNum = (s) => { const t = String(s || "").toLowerCase().split("/")[0].replace(/[^a-z0-9]/g, ""); return /^\d+$/.test(t) ? String(+t) : t.replace(/^([a-z]+)0+(\d)/, "$1$2"); };
const SET_SKIP = new Set(["set", "the", "pokemon", "tcg", "and", "of", "series", "expansion", "promos", "promo"]);
const mSetWords = (s) => String(s || "").toLowerCase().replace(/\b(sv|swsh|sm|xy|bw|me)\d+[a-z]?\b/g, " ").split(/[^a-z0-9]+/).filter((w) => w && !SET_SKIP.has(w));
const mVar = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const mGrade = (x) => (isGraded(x) ? shortGrade(x.grade).toLowerCase() : "");
const mCond = (x) => (isGraded(x) ? "" : String(x.cond || "Near Mint").toLowerCase());
const mBase = (x) => [x.watch && !x.qty ? "w" : "o", mName(x.name), mNum(x.num), mGrade(x), mCond(x)].join("|");
function mSetFit(a, b) {
  if (a.tcgId && b.tcgId) return String(a.tcgId) === String(b.tcgId) ? 9 : -1;
  const wa = mSetWords(a.set), wb = mSetWords(b.set); if (!wa.length || !wb.length) return 1;
  const hit = wa.filter((w) => wb.includes(w)).length; return hit ? 2 + hit : -1;
}
const mVarFit = (a, b) => { const va = mVar(a.var), vb = mVar(b.var); return !va || !vb ? 1 : va === vb ? 2 : -1; };
const byAdded = (a, b) => String(a.added || "").localeCompare(String(b.added || ""));
// collectrPfs: every Collectr portfolio name. Copies in a Price Plot-only portfolio (like one made while scanning) count
// toward the matching Collectr card; copies in another Collectr portfolio belong to that portfolio's own row.
function planMerge(incoming, scopePfs, collectrPfs, links) {
  const cPfs = new Set([...(collectrPfs || []), ...incoming.map((r) => String(r.pf || ""))]);
  const items = P.items.map((x) => ({ ...x })), used = new Set(), plan = { same: [], up: [], down: [], added: [], addedRi: [], zeroRi: [], costFilled: 0, costKept: 0 };
  const groups = new Map(); items.forEach((x, i) => { const k = mBase(x); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const orig = items.length, made = new Set(); // made: extra copies created by this merge
  incoming.forEach((r, ri) => {
    let mine;
    if (links && links.has(ri)) { const li = links.get(ri); mine = li >= 0 && li < orig && !used.has(li) ? [li] : []; }
    else {
      const cand = (groups.get(mBase(r)) || []).filter((i) => !used.has(i) && mVarFit(items[i], r) > 0 && mSetFit(items[i], r) > 0);
      // this Collectr portfolio's copies, plus copies in Price Plot-only portfolios
      mine = cand.filter((i) => { const pf = String(items[i].pf || ""); return pf === String(r.pf || "") || !cPfs.has(pf); });
    }
    if (!mine.length) {
      if (!(r.qty > 0) && !r.watch) { plan.zeroRi.push(ri); return; } // at 0 in Collectr and not in Price Plot: nothing to add
      const x = { ...r, id: uid() }; items.push(x); plan.added.push(x); plan.addedRi.push(ri); return;
    }
    mine.forEach((i) => used.add(i));
    const es = mine.map((i) => items[i]), have = es.reduce((a, x) => a + (x.qty || 0), 0), want = r.qty || 0, label = r.name;
    for (const e of es) {
      if (!e.tcgId && r.tcgId) e.tcgId = r.tcgId; if (!e.img && r.img) { e.img = r.img; e.big = r.big; }
      // graded cards are valued at Collectr's price, so each import brings its latest; raw cards use TCGplayer's,
      // and Collectr's only fills one that has no price yet
      if (r.mkt != null && (isGraded(e) || e.mkt == null)) e.mkt = r.mkt;
      if (r.watch) e.watch = true;
      if (r.cost > 0 && !(e.cost > 0) && e.qty > 0) { e.cost = r.cost; plan.costFilled++; } else if (e.cost > 0) plan.costKept++;
    }
    if (want === have) { plan.same.push(label); return; }
    if (want > have) {
      // extra copies have Collectr's condition and grade (the same as the card's own, unless you linked a different one)
      const extra = want - have, free = es.find((e) => !(e.cost > 0) && mCond(e) === mCond(r) && mGrade(e) === mGrade(r));
      if (free && !(r.cost > 0 && free.qty > 0)) { free.qty += extra; if (r.cost > 0) free.cost = r.cost; }
      else { const x = { ...es[0], id: uid(), qty: extra, cost: r.cost > 0 ? r.cost : 0, added: r.added || today(), cond: r.cond || es[0].cond, grade: r.grade || es[0].grade, var: r.var || es[0].var }; delete x.pT; delete x.mktV; items.push(x); made.add(x); }
      plan.up.push(`${label} +${extra}`);
    } else {
      let cut = have - want; const order = [...es.filter((e) => !(e.cost > 0)).sort(byAdded), ...es.filter((e) => e.cost > 0).sort(byAdded)], paid = [];
      for (const e of order) { if (!cut) break; const k = Math.min(cut, e.qty); e.qty -= k; cut -= k; if (e.cost > 0) paid.push(`${k} at ${money(e.cost)}`); }
      plan.down.push(`${label} −${have - want}${paid.length ? " (incl. " + paid.join(", ") + " paid)" : ""}`);
    }
  });
  // for each new card, the cards you already have that look like it (same name and number, any set, condition or portfolio),
  // so you can say it's more copies of one of them
  const looks = (x) => P.items.map((y, i) => i).filter((i) => !used.has(i) && P.items[i].qty > 0 && mName(P.items[i].name) === mName(x.name) && (!mNum(x.num) || !mNum(P.items[i].num) || mNum(x.num) === mNum(P.items[i].num)) && !!x.watch === !!P.items[i].watch);
  plan.cands = plan.added.map(looks);
  plan.zcands = plan.zeroRi.map((ri) => looks(incoming[ri]));
  // cards only in Price Plot, in the portfolios this import covers
  const inScope = (pf) => (scopePfs ? scopePfs.has(pf) : true) || !cPfs.has(pf);
  const onlyPP = items.map((x, i) => [x, i]).filter(([x, i]) => !used.has(i) && i < orig && !made.has(x) && x.qty > 0 && !plan.added.includes(x) && inScope(String(x.pf || "")));
  plan.onlyPP = onlyPP.map(([x]) => x);
  plan.items = items.filter((x) => x.qty > 0 || x.watch);
  return plan;
}
// the review window: what will change, before anything does. A new card that looks like one you already have gets a
// choice: keep it as a new card, or say it's more copies of that card. The summary recounts as you choose.
function mergeReview(make, source) {
  return new Promise((done) => {
    const links = new Map(); let rmOnly = false, plan = make(links);
    // a list showing its first few, with "…and N more" opening the rest (and staying open when the review recounts)
    const openLists = new Set();
    const li = (a, n = 8, k = "") => a.length ? `<ul class="mg-l">${a.slice(0, n).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>${a.length > n ? `<details class="mg-more" data-mgk="${k}"${openLists.has(k) ? " open" : ""}><summary>…and ${a.length - n} more</summary><ul class="mg-l">${a.slice(n).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>` : ""}` : "";
    const desc = (y) => [y.name + (y.num ? " " + y.num : ""), y.set, isGraded(y) ? shortGrade(y.grade) : COND_CODE[y.cond] || y.cond, y.var, "×" + y.qty, y.cost > 0 ? "paid " + money(y.cost) : "", y.pf].filter(Boolean).join(" · ");
    const ov = document.createElement("div"); ov.className = "ppm-ov";
    const draw = () => {
      const ask = [], plainNew = [], zero = (ri) => !(make.incoming[ri].qty > 0);
      plan.added.forEach((x, k) => (plan.cands[k].length ? ask : plainNew).push(k));
      // rows you've linked are no longer "new" or "sold", but they stay in the list so the choice can be changed
      const linked = [...links.keys()];
      const all = [...linked.map((ri) => ({ ri, x: make.incoming[ri], cands: make.candsFor(ri) })), ...ask.map((k) => ({ ri: plan.addedRi[k], x: plan.added[k], cands: plan.cands[k] })),
        ...plan.zeroRi.map((ri, k) => ({ ri, x: make.incoming[ri], cands: plan.zcands[k] })).filter((o) => o.cands.length)];
      const rows = all.filter((o) => !zero(o.ri)), zrows = all.filter((o) => zero(o.ri));
      const zIgnored = plan.zeroRi.length - plan.zeroRi.filter((ri, k) => plan.zcands[k].length).length;
      const pick = rows.length ? `<div class="mg-s"><b>Already have some of these?</b> <span class="mu">These look like cards in your portfolio. Choose “Same as…” if they're more copies of one; quantities then follow Collectr and what you paid is kept.</span></div>
        ${rows.map(({ ri, x, cands }) => `<div class="mg-p"><div>${esc(x.name)}${x.num ? " " + esc(x.num) : ""} <span class="mu">· ${esc([x.set, isGraded(x) ? shortGrade(x.grade) : COND_CODE[x.cond] || x.cond, x.var].filter(Boolean).join(" · "))} ×${x.qty}</span></div>
          <select data-mgl="${ri}" aria-label="Is this a new card?"><option value="-1">New card</option>${cands.map((i) => `<option value="${i}" ${links.get(ri) === i ? "selected" : ""}>Same as: ${esc(desc(P.items[i]))}</option>`).join("")}</select></div>`).join("")}` : "";
      const sold = zrows.length ? `<div class="mg-s"><b>Sold or removed in Collectr?</b> <span class="mu">Collectr has these at 0. If one is a card in your portfolio, choose it to remove it (or lower its count).</span></div>
        ${zrows.map(({ ri, x, cands }) => `<div class="mg-p"><div>${esc(x.name)}${x.num ? " " + esc(x.num) : ""} <span class="mu">· ${esc([x.set, isGraded(x) ? shortGrade(x.grade) : COND_CODE[x.cond] || x.cond, x.var].filter(Boolean).join(" · "))} · 0 in Collectr</span></div>
          <select data-mgl="${ri}" aria-label="Remove a card you sold?"><option value="-1">Keep (no change)</option>${cands.map((i) => `<option value="${i}" ${links.get(ri) === i ? "selected" : ""}>Remove: ${esc(desc(P.items[i]))}</option>`).join("")}</select></div>`).join("")}` : "";
      ov.innerHTML = `<div class="ppm mg" role="dialog" aria-modal="true" aria-labelledby="mg-t"><h3 id="mg-t">Merge ${esc(source)} into Price Plot</h3>
      <p class="mu" style="margin:0 0 8px">Nothing changes until you tap Merge, and you can undo it afterward.</p>
      <div class="mg-s"><b>${plan.same.length}</b> ${plan.same.length === 1 ? "card already matches" : "cards already match"} (no change)</div>
      ${plan.up.length ? `<div class="mg-s"><b>${plan.up.length}</b> with more copies in Collectr</div>${li(plan.up, 8, "up")}` : ""}
      ${plan.down.length ? `<div class="mg-s"><b>${plan.down.length}</b> with fewer copies in Collectr (copies without a cost are removed first)</div>${li(plan.down, 8, "down")}` : ""}
      ${plainNew.length + ask.length ? `<div class="mg-s"><b>${plainNew.length + ask.length}</b> new card${plainNew.length + ask.length === 1 ? "" : "s"}</div>${li(plainNew.map((k) => plan.added[k]).map((x) => `${x.name}${x.num ? " " + x.num : ""}${x.qty > 1 ? " ×" + x.qty : ""}`), 5, "new")}` : ""}
      ${pick}
      ${sold}${zIgnored ? `<div class="mg-s mu" style="font-size:13px">${zIgnored} other card${zIgnored === 1 ? " is" : "s are"} at 0 in Collectr and not in Price Plot, so nothing changes for ${zIgnored === 1 ? "it" : "them"}.</div>` : ""}
      <div class="mg-s">What you paid is kept on <b>${plan.costKept}</b> entr${plan.costKept === 1 ? "y" : "ies"}${plan.costFilled ? `; Collectr's cost fills in <b>${plan.costFilled}</b> that had none` : ""}.</div>
      ${plan.onlyPP.length ? `<div class="mg-s"><b>${plan.onlyPP.length}</b> card${plan.onlyPP.length === 1 ? " is" : "s are"} in Price Plot but not in this Collectr import</div>${li(plan.onlyPP.map((x) => `${x.name}${x.num ? " " + x.num : ""} ×${x.qty}${x.cost > 0 ? " · paid " + money(x.cost) : ""}${x.pf ? " · " + x.pf : ""}`), 6, "pp")}
        <label class="mg-c"><input type="checkbox" id="mg-rm" ${rmOnly ? "checked" : ""}> Remove these from Price Plot (leave unticked to keep them)</label>` : ""}
      <div class="ppm-b"><button type="button" class="ppm-x primary" data-mg="go">Merge</button><button type="button" class="ppm-x plain" data-mg="no">Cancel</button></div></div>`;
    };
    const close = (v) => { removeEventListener("keydown", key); ov.remove(); done(v); }, key = (e) => { if (e.key === "Escape") close(null); };
    ov.addEventListener("toggle", (e) => { const d = e.target; if (d.dataset && d.dataset.mgk != null) { if (d.open) openLists.add(d.dataset.mgk); else openLists.delete(d.dataset.mgk); } }, true);
    ov.addEventListener("click", (e) => { const b = e.target.closest("[data-mg]"); if (b) close(b.dataset.mg === "go" ? { plan, removeOnly: rmOnly } : null); else if (e.target === ov) close(null); });
    ov.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "mg-rm") { rmOnly = t.checked; return; }
      if (t.dataset.mgl != null) { const ri = +t.dataset.mgl, v = +t.value; if (v >= 0) links.set(ri, v); else links.delete(ri);
        const top = ov.querySelector(".ppm").scrollTop; plan = make(links); draw(); ov.querySelector(".ppm").scrollTop = top; }
    });
    draw(); addEventListener("keydown", key); document.body.appendChild(ov); ov.querySelector("[data-mg=go]").focus();
  });
}
const UNDO_KEY = "pp_portfolio_undo";
async function smartMerge(incoming, source, scopePfs, collectrPfs) {
  // the possible "Same as" cards for a Collectr row, worked out once from a plan with no choices made
  const base = planMerge(incoming, scopePfs, collectrPfs), candMap = new Map([...base.addedRi.map((ri, k) => [ri, base.cands[k]]), ...base.zeroRi.map((ri, k) => [ri, base.zcands[k]])]);
  const make = (links) => planMerge(incoming, scopePfs, collectrPfs, links);
  make.incoming = incoming; make.candsFor = (ri) => candMap.get(ri) || [];
  const ok = await mergeReview(make, source); if (!ok) return false;
  const plan = ok.plan;
  try { localStorage.setItem(UNDO_KEY, JSON.stringify({ at: Date.now(), source, P })); } catch {}
  const drop = ok.removeOnly ? new Set(plan.onlyPP) : null;
  P = { ...P, items: drop ? plan.items.filter((x) => !drop.has(x)) : plan.items };
  return true;
}
function undoImport() {
  let u = null; try { u = JSON.parse(localStorage.getItem(UNDO_KEY) || "null"); } catch {}
  if (!u || !u.P || !Array.isArray(u.P.items)) return toast("Nothing to undo");
  P = u.P; try { localStorage.removeItem(UNDO_KEY); } catch {} store(); snap(); render(); toast(/^bulk/.test(u.source || "") ? "Undid the change" : u.source === "trade" ? "Undid the trade" : "Undid the last import");
}
const canUndo = () => { try { const u = JSON.parse(localStorage.getItem(UNDO_KEY) || "null"); return !!(u && Date.now() - u.at < 14 * 864e5); } catch { return false; } };
async function applyImport(how) {
  if (!pending) return;
  if (how === "replace") { try { localStorage.setItem(UNDO_KEY, JSON.stringify({ at: Date.now(), source: pending.file, P })); } catch {} P = { ...P, items: pending.items }; }
  else if (!(await smartMerge(pending.items, pending.file || "Collectr file"))) return;
  P.asOf = pending.asOf || today(); P.source = pending.file; store(); snap(P.asOf);
  status(`Imported ${pending.items.length.toLocaleString()} rows from ${pending.file}.`); pending = null; $("pfi").hidden = true; view = "all"; shown = PAGE; render(); fillPrices();
  toast("Import done", { label: "Undo", run: undoImport });
}

/* ---------- drawing ---------- */
const PFF_OPTS = {
  kind: [["", "Any kind"], ["raw", "Raw"], ["graded", "Graded"], ["sealed", "Sealed"]],
  cond: [["", "Any condition"], ...["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"].map((c) => [c, c])],
  lang: [["", "Any language"], ["en", "English"], ["jp", "Japanese"], ["other", "Other languages"]] };
const PFF_NAMES = { kind: "Kind", cond: "Condition", lang: "Language", set: "Set", vmin: "Value from", vmax: "Value to" };
// a card's language from its set, category or name (Collectr marks Japanese cards in the set or category)
const langOf = (x) => { const t = [x.set, x.cat, x.name].join(" "); return /japan|\(jp\)/i.test(t) ? "jp" : /chinese|korean|korea|china|\(cn\)|\(kr\)|german|french|italian|spanish|portuguese/i.test(t) ? "other" : "en"; };
const pffOn = () => Object.entries(PFF).filter(([, v]) => v !== "" && v != null);
const pffLabel = (k, v) => k === "set" ? v : k === "vmin" ? `≥ ${money(+v)} each` : k === "vmax" ? `≤ ${money(+v)} each` : ((PFF_OPTS[k] || []).find((o) => o[0] === v) || [, v])[1];
const isSealedX = (x) => x.cond === "Sealed";
function pffOk(x) {
  const f = PFF, g = isGraded(x), u = unit(x);
  if (f.kind === "raw" && (g || isSealedX(x))) return false; if (f.kind === "graded" && !g) return false; if (f.kind === "sealed" && !isSealedX(x)) return false;
  if (f.cond && (g || (x.cond || "Near Mint") !== f.cond)) return false;
  if (f.lang && langOf(x) !== f.lang) return false;
  if (f.vmin !== undefined && f.vmin !== "" && !(u >= +f.vmin)) return false; if (f.vmax !== undefined && f.vmax !== "" && !(u <= +f.vmax)) return false;
  if (f.set && (x.set || "") !== f.set) return false;
  return true;
}
function pffSet(k, v) { if (v === "" || v == null) delete PFF[k]; else PFF[k] = v; try { localStorage.setItem("pp_pffilter", JSON.stringify(PFF)); } catch {} shown = PAGE; render(); }
function pffHTML() {
  const on = pffOn(), sets = [...new Set(owned(P.items).map((x) => x.set).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sel = (k) => `<label><span>${PFF_NAMES[k]}</span><select data-pff="${k}">${PFF_OPTS[k].map(([v, l]) => `<option value="${esc(v)}" ${v === (PFF[k] || "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  return `<div class="rf pf-rf"><button type="button" class="pill rf-b" data-pffo="1" aria-expanded="${pffOpen}">Filter${on.length ? ` · ${on.length}` : ""} ▾</button>${on.map(([k, v]) => `<button type="button" class="pill rf-c" data-pffx="${k}" aria-label="Remove filter ${esc(pffLabel(k, v))}">${esc(pffLabel(k, v))} ✕</button>`).join("")}
  ${pffOpen ? `<div class="rf-p">${sel("kind")}${sel("lang")}
    <label><span>Value each from $</span><input data-pff="vmin" type="number" min="0" step="any" inputmode="decimal" value="${esc(PFF.vmin ?? "")}" placeholder="0"></label>
    <label><span>to $</span><input data-pff="vmax" type="number" min="0" step="any" inputmode="decimal" value="${esc(PFF.vmax ?? "")}" placeholder="Any"></label>
    ${sel("cond")}<label><span>Set</span><select data-pff="set"><option value="">Any set</option>${sets.map((t) => `<option ${t === PFF.set ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
    <div class="rf-a">${on.length ? `<button type="button" class="cs-back" data-pffc="1">Clear all</button>` : ""}<button type="button" class="cs-back" data-pffo="1">Done</button></div></div>` : ""}</div>`;
}
function filtered() {
  let a = view === "watch" ? P.items.filter((x) => x.watch) : owned(P.items).filter((x) => view === "all" || (x.pf || "Unsorted") === view);
  if (pffOn().length) a = a.filter(pffOk);
  if (findTxt) { const w = findTxt.toLowerCase().split(/\s+/).filter(Boolean); a = a.filter((x) => { const t = [x.name, x.set, x.num, x.var, x.grade, x.cond, x.rarity, x.cat, x.notes].join(" ").toLowerCase(); return w.every((y) => t.includes(y)); }); }
  const v = (x) => unit(x) * (view === "watch" ? 1 : x.qty);
  const S = { value: (a, b) => v(b) - v(a), low: (a, b) => v(a) - v(b), unit: (a, b) => unit(b) - unit(a), unitlow: (a, b) => unit(a) - unit(b), name: (a, b) => a.name.localeCompare(b.name), added: (a, b) => String(b.added).localeCompare(String(a.added)),
    gain: (a, b) => (b.cost > 0 ? (unit(b) - b.cost) * b.qty : -1e9) - (a.cost > 0 ? (unit(a) - a.cost) * a.qty : -1e9),
    // cards without a cost go last in every gain sort
    gainlow: (a, b) => (a.cost > 0 ? (unit(a) - a.cost) * a.qty : 1e9) - (b.cost > 0 ? (unit(b) - b.cost) * b.qty : 1e9),
    gainpct: (a, b) => (b.cost > 0 ? unit(b) / b.cost : -1e9) - (a.cost > 0 ? unit(a) / a.cost : -1e9),
    addedold: (a, b) => String(a.added || "9999").localeCompare(String(b.added || "9999")) };
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
  return `<div class="pr${selMode ? " selm" : ""}${selMode && selIds.has(x.id) ? " sel" : ""}" data-id="${x.id}"><button class="prx" type="button" data-trash="${x.id}" tabindex="-1" aria-label="Remove ${esc(x.name)}"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></button><div class="prc">${selMode ? `<span class="pr-ck" role="checkbox" aria-checked="${selIds.has(x.id)}" aria-label="Select ${esc(x.name)}"></span>` : ""}${thumb(x)}<div class="pm"><b>${esc(x.name)}</b> <span class="cg ${g ? "gr" : ""}">${esc(g ? shortGrade(x.grade) : x.cond || "")}</span>
  <div class="mu">${meta}${view === "all" && x.pf ? ` · <i>${esc(x.pf)}</i>` : ""}</div>
  <div class="mu">${view === "watch" ? "" : x.qty + " × "}${x.mkt == null && !(x.ovr > 0) ? "—" : money(unit(x)) + (view !== "watch" && x.qty > 1 ? " = " + money(line) : "")}${x.ovr > 0 ? ` <span title="Your own price, set in Collectr or here">(your price)</span>` : x.mkt == null ? (pfq.includes(x) || pfRunning ? " (looking up price…)" : " (no price)") : x.mktV !== 2 && !isGraded(x) ? ` <span title="Collectr's price until TCGplayer's is found">(Collectr${pfq.includes(x) || (pfRunning && !x.pTry) ? " · looking up TCGplayer…" : x.pWhy ? " · " + esc(x.pWhy) : ""})</span>` : x.mktEst ? ` <span title="No recent ${esc(x.cond || "")} sales on TCGplayer, so this is the Near Mint price with the usual discount for this condition">(est.)</span>` : ""}</div>${gain != null ? `<div class="mu pr-g">vs. ${money(x.cost)} paid · <span style="color:var(${gain >= 0 ? "--up" : "--dn"});font-weight:600;white-space:nowrap">${gain >= 0 ? "+" : "−"}${money(Math.abs(gain))} (${gain >= 0 ? "+" : "−"}${Math.abs((gain / (x.cost * x.qty)) * 100).toFixed(1)}%)</span></div>` : ""}
  ${x.notes ? `<div class="mu">${esc(x.notes)}</div>` : ""}</div>
  <div class="pv"><b>${x.mkt == null && !(x.ovr > 0) ? "—" : money(unit(x))}</b>${selMode ? "" : `<div><button class="pill sm2" type="button" data-cmp="${x.id}">Comp</button><button class="pill sm2" type="button" data-ed="${x.id}">Edit</button></div>`}</div></div></div>`;
}
// "Paid each" with a small % box beside it: the % is of the card's market price. Typing either one fills in the other.
function costField(x) {
  const mk = x.mkt > 0 ? x.mkt : null, pc = mk && x.cost > 0 ? String(Math.round((x.cost / mk) * 1000) / 10) : "";
  return `<div class="pe-cl"><div class="pe-lh"><label for="pe-cost">Paid each ($)</label>
    <span class="pe-pct" title="${mk ? "Percent of the market price, " + money(mk) : "No market price yet"}"><input name="costPct" type="number" min="0" step="any" inputmode="decimal" aria-label="Paid as a percent of the market price" data-mk="${mk ?? ""}" value="${pc}" ${mk ? "" : "disabled placeholder=\"–\""}>%</span></div>
    <input id="pe-cost" name="cost" type="number" min="0" step="any" inputmode="decimal" value="${esc(x.cost || "")}"></div>`;
}
document.addEventListener("input", (e) => {
  const t = e.target, fm = t.closest && t.closest("form.pe"); if (!fm || (t.name !== "cost" && t.name !== "costPct")) return;
  const c = fm.querySelector('[name="cost"]'), p = fm.querySelector('[name="costPct"]'), mk = +p.dataset.mk; if (!(mk > 0)) return;
  if (t.name === "costPct") c.value = t.value === "" || !Number.isFinite(+t.value) ? "" : (Math.round(mk * +t.value) / 100).toFixed(2);
  else p.value = t.value === "" || !Number.isFinite(+t.value) ? "" : String(Math.round((+t.value / mk) * 1000) / 10);
});
const PRINTS_ANY = ["Normal", "Holofoil", "Reverse Holofoil", "1st Edition", "1st Edition Holofoil", "Unlimited", "Unlimited Holofoil"];
const printsCache = new Map();
// the card's own printing stays in its usual place in the list (or first, if TCGplayer doesn't list it)
function printOpts(list, cur) { const a = !cur || list.includes(cur) ? list.slice() : [cur, ...list]; return a.map((p) => `<option ${p === cur ? "selected" : ""}>${esc(p)}</option>`).join(""); }
function printField(x) {
  const known = x.tcgId && printsCache.get(String(x.tcgId));
  return `<label>Printing<select name="var" data-pr="${x.id || ""}">${known ? printOpts(known, x.var) : printOpts(x.tcgId || x.id ? [] : PRINTS_ANY, x.var || "")}${known ? "" : x.id ? `<option value="" disabled>Loading printings…</option>` : ""}</select></label>`;
}
// fill the dropdown with the printings TCGplayer has for this card (finding the card on TCGplayer first if needed)
async function loadPrints(x) {
  let list = null;
  try {
    if (!x.tcgId) { const j = await getJSON("/api/cardimg?" + new URLSearchParams({ name: x.name, set: x.set || "", num: x.num || "", cat: x.cat || "" })); if (j && j.tcgId) { x.tcgId = j.tcgId; if (!x.img && j.img) { x.img = j.img; x.big = j.big; } store(); } }
    if (x.tcgId) { list = printsCache.get(String(x.tcgId)); if (!list) { list = (await getJSON("/api/tcgprints?id=" + encodeURIComponent(x.tcgId))).prints || []; printsCache.set(String(x.tcgId), list); } }
  } catch {}
  const sel = document.querySelector(`#pf select[data-pr="${x.id}"]`); if (!sel) return;
  const cur = sel.value || x.var || "";
  sel.innerHTML = printOpts(list && list.length ? list : PRINTS_ANY, cur);
}
function form(x) {
  const f = (k, l, v, t = "text", extra = "") => `<label>${l}<input name="${k}" type="${t}" value="${esc(v ?? "")}" ${extra}></label>`;
  const pfs = [...new Set(P.items.map((y) => y.pf).filter(Boolean))];
  const pic = x.big || x.img;
  return `<form class="pe" data-fid="${x.id || ""}"><button type="button" class="pe-x" data-cx="1" aria-label="Close without saving">✕</button>
  ${x.id ? `<div class="pe-h"><button type="button" class="pe-pic" data-zm="${x.id}" aria-label="Enlarge the picture of ${esc(x.name)}" ${pic ? "" : "disabled"}>${pic ? `<img src="${esc(x.img || pic)}" alt="">` : ""}</button>
    <div class="pe-hm"><b>${esc(x.name)}</b>${esc([x.set, x.num].filter(Boolean).join(" · "))}</div></div>` : ""}<div class="pg">${f("name", "Card name", x.name, "text", "required")}${f("set", "Set", x.set)}${f("num", "Number", x.num)}${printField(x)}
  <label>Condition<select name="cond">${[...CONDS, "Sealed", ...(x.cond && !CONDS.includes(x.cond) && x.cond !== "Sealed" ? [x.cond] : [])].map((c) => `<option ${c === (x.cond || "Near Mint") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
  ${f("grade", "Grade (blank if raw)", isGraded(x) ? x.grade : "", "text", 'placeholder="e.g. PSA 10"')}
  ${f("qty", "Quantity", x.qty ?? 1, "number", 'min="0" step="1" inputmode="numeric"')}${costField(x)}
  ${f("ovr", "Your price each ($)", x.ovr || "", "number", `min="0" step="any" inputmode="decimal" placeholder="${x.mkt != null ? "Market " + money(x.mkt) : "Value per card"}"`)}
  ${pfField(x.pf || (view !== "all" && view !== "watch" ? view : ""), pfs)}
  ${f("notes", "Notes", x.notes)}</div>
  <div class="bar"><button class="pill on" type="submit">Save</button><button class="pill" type="button" data-cx="1">Cancel</button>${x.id ? `<button class="pill dl" type="button" data-del="${x.id}">Delete</button>` : ""}</div>
  <div class="sm">Leave “Your price” blank to use the market price (TCGplayer's; Collectr's for graded cards). The % beside Paid each is of that market price.</div></form>`;
}
// the card list under the search box: its count, the rows shown so far and the Show more button
function listHTML(list) {
  const fv = pffOn().length || findTxt.trim() ? list.reduce((a, x) => a + unit(x) * (view === "watch" ? 1 : x.qty), 0) : null;
  return `<div class="sm">${list.length.toLocaleString()} ${list.length === 1 ? "entry" : "entries"}${findTxt.trim() || pffOn().length ? (list.length === 1 ? " matches" : " match") : ""}${fv != null && view !== "watch" ? ` · worth <b>${money(fv)}</b>` : ""}${selMode ? "" : ` · <span class="mu">press and hold a card to select several</span>`}</div>
  <div id="pfl2">${list.slice(0, shown).map(rowHTML).join("")}</div>
  ${list.length > shown ? `<button class="pill" type="button" data-pa="more" style="margin-top:10px">Show ${Math.min(PAGE, list.length - shown)} more</button>` : ""}`;
}
// redraw only the list, leaving the search box (and everything above it) untouched, so typing doesn't move the page
function renderList() {
  const box = $("pflist"); if (!box || detail || editing) return render();
  const list = filtered(); box.innerHTML = listHTML(list); fetchImgs(list.slice(0, shown)); watchMore(); selSync();
}
function render() {
  const box = $("pf"); if (!box) return;
  if (detail) { const x = detailItem(); if (x) return renderDetail(box, x); detail = null; }
  if (tradeOpen) return renderTrade(box);
  const o = owned(P.items), T = totals(o), pfs = [...new Set(o.map((x) => x.pf || "Unsorted"))].sort(), w = P.items.filter((x) => x.watch).length;
  if (view !== "all" && view !== "watch" && !pfs.includes(view)) view = "all";
  const list = filtered(), V = view === "all" || view === "watch" ? T : totals(o.filter((x) => (x.pf || "Unsorted") === view));
  const gl = V.cost > 0 ? V.costed - V.cost : null;
  box.innerHTML = `<div id="pfh"><div class="pt1"><span class="mu">${view === "all" ? "Total portfolio value" : view === "watch" ? "Watchlist" : esc(view)}</span>
   <b>${view === "watch" ? w + " card" + (w === 1 ? "" : "s") : money(V.value)}</b>
   ${view !== "watch" && gl != null ? `<span style="color:var(${gl >= 0 ? "--up" : "--dn"});font-weight:600">${gl >= 0 ? "▲ +" : "▼ −"}${money(Math.abs(gl))} <span class="mu">on cards with a cost (${money(V.cost)} paid)</span></span>` : ""}</div>
   ${view !== "watch" ? `<div class="pst"><span><b>${V.n.toLocaleString()}</b> cards</span><span><b>${V.graded}</b> graded</span><span><b>${pfs.length}</b> portfolio${pfs.length === 1 ? "" : "s"}</span>${P.asOf ? `<span>Prices as of <b>${esc(P.asOf)}</b></span>` : ""}</div>` : ""}</div>
${P.items.length ? `
  <div class="tk" id="pfv">${[["all", "All"], ...pfs.map((p) => [p, p]), ...(w ? [["watch", "Watchlist (" + w + ")"]] : [])].map(([k, l]) => `<button class="pill" type="button" data-pv="${esc(k)}" aria-pressed="${k === view}">${esc(l)}${k !== "all" && k !== "watch" ? ` <span class="mu">${money(totals(o.filter((x) => (x.pf || "Unsorted") === k)).value)}</span>` : ""}</button>`).join("")}</div>
` : ""}  <div class="bar"><span class="imp"><button class="pill on" type="button" data-pa="imp" aria-haspopup="true" aria-expanded="${impOpen}">Import portfolio ▾</button>
   <div class="imp-m" id="impm"${impOpen ? "" : " hidden"}><div class="imp-h">Import from</div>
    <label class="imp-i" for="pff">Collectr file <span>.xlsx or .csv export</span></label>
    <button class="imp-i" type="button" data-pa="clink">Collectr link <span>a shared portfolio link</span></button>
    <label class="imp-i" for="pff2">CSV file <span>a Price Plot or Collectr CSV</span></label>
    ${canUndo() ? `<button class="imp-i" type="button" data-pa="undo">Undo last import</button>` : ""}
    ${P.items.length ? `<div class="imp-sep"></div><button class="imp-i" type="button" data-pa="export">Export as CSV</button><button class="imp-i imp-dn" type="button" data-pa="clear">Clear all</button>` : ""}</div></span>
   <input id="pff" type="file" accept=".csv,.xlsx,.xls,text/csv" hidden><input id="pff2" type="file" accept=".csv,text/csv" hidden>
   <button class="pill" style="margin-left:auto" type="button" data-pa="trade">⇄ Trade${TRD.give.length + TRD.get.length ? ` (${TRD.give.length + TRD.get.length})` : ""}</button></div>
  ${cimpPanel()}<div class="sm" id="pfs">${pfText()}</div>${pfBarHTML()}<div id="pfi" class="pbx" hidden></div>
  ${editing === "new" ? `<div class="pbx">${form({ qty: 1 })}</div>` : ""}
  ${P.items.length ? `
  ${view === "all" ? `<div class="pch">${chart()}</div>` : ""}
  <div class="bar"><input id="pfq" type="search" placeholder="Filter by name, set, number…" value="${esc(findTxt)}" autocomplete="off"><button class="pill pf-scan" type="button" data-ps="scan" aria-label="Scan cards to select them in your portfolio">📷</button>
   <select id="pfo" aria-label="Sort">${[["value", "Total value: high to low"], ["low", "Total value: low to high"], ["unit", "Individual value: high to low"], ["unitlow", "Individual value: low to high"], ["gain", "Gain: high to low"], ["gainlow", "Gain: low to high"], ["gainpct", "Gain %: high to low"], ["added", "Date added: newest first"], ["addedold", "Date added: oldest first"], ["name", "Name"]].map(([k, l]) => `<option value="${k}" ${k === sortBy ? "selected" : ""}>${l}</option>`).join("")}</select></div>
  ${pffHTML()}
  <div id="pflist">${listHTML(list)}</div>${selMode ? `<div id="pfsel" class="pfsel">${selBarHTML()}</div>` : ""}`
  : `<p class="sm">Your portfolio is empty. Import a Collectr export (in Collectr: Portfolio → ⋯ → Export, then open the emailed file here), or add cards with the 📷 scanner or the TCGplayer tab’s Add to portfolio. Everything stays saved on this device.</p>`}`;
  if (P.items.length) fetchImgs(list.slice(0, shown));
  watchMore();
}
// the next 50 cards load by themselves as you scroll near the end of the list (the button still works too)
let moreObs = null;
function watchMore() {
  if (!("IntersectionObserver" in window)) return;
  if (!moreObs) moreObs = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    moreObs.disconnect();
    if (detail || editing) return;
    shown += PAGE; renderList();
  }, { rootMargin: "0px 0px 600px 0px" });
  moreObs.disconnect();
  const b = document.querySelector('#pf [data-pa="more"]'); if (b && !detail && !editing) moreObs.observe(b);
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
// preview: a scanned card (not in the portfolio yet) shown on the comps page; previewTab: the tab to go back to
let preview = null, previewTab = "";
const detailItem = () => P.items.find((y) => y.id === detail) || (preview && preview.id === detail ? preview : null);
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
// eBay sellers write the card's name and its own number ("Arceus VSTAR GG70"), not Collectr's notes ("(Secret)")
// or gallery numbers in full ("GG70/GG70"), so those are trimmed before searching
const ebName = (n) => String(n || "").replace(/\s*\([^)]*\)/g, " ").replace(/\s+-\s+\S+$/, "").replace(/\s+/g, " ").trim();
const ebNum = (n) => { n = String(n || "").trim(); const m = /^([a-z]{1,4}\d{1,3}[a-z]?)\s*\/\s*[a-z]{1,4}\d{1,3}$/i.exec(n); return m ? m[1] : n; };
function queryFor(x, sel) { const gi = selGrade(sel); return [ebName(x.name), ebNum(x.num), gi ? gi.g + " " + gi.n : ""].filter(Boolean).join(" "); }
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
  if (e.status === "fulfilled") { out.ebay = e.value; for (const w of e.value.warnings || []) out.warn.push("eBay: " + w); } else out.warn.push("eBay: " + e.reason.message + ".");
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
  const head = (fair) => `<div class="cdx-top"><button class="pill" type="button" data-dx="back">‹ ${x === preview ? "Scan list" : "Portfolio"}</button>${x === preview ? `<span class="mu">Scanned, not in your portfolio yet</span>` : `<button class="pill sm2" type="button" data-ed="${x.id}">Edit</button>`}</div>
  <div class="cdx-hd">${pic}<div class="cdx-hm"><div class="cdx-name">${esc(x.name)}</div><div class="mu">${meta}</div>
    <div class="cdx-frow">${fair}<div class="cdx-hb"><button class="btn" type="button" data-dx="ebay" aria-label="eBay chart">eBay</button><button class="btn o" type="button" data-dx="tcg" aria-label="TCGplayer chart">TCGplayer</button></div></div></div></div>
  <div class="seg cdx-rg" role="group" aria-label="Time range">${DRNG.map(([k, l]) => `<button type="button" data-dr="${k}" aria-pressed="${k === drng}">${l}</button>`).join("")}</div>
  <div class="tk cdx-cd" role="group" aria-label="Condition">${condOptions(x).map((c) => `<button class="pill" type="button" data-dc="${esc(c)}" aria-pressed="${c === dsel}">${esc(selLabel(c))}${c === ownSel(x) ? " ★" : ""}</button>`).join("")}</div>`;
  const sel = dsel, own = sel === ownSel(x), sgi = selGrade(sel);
  box.innerHTML = head(`<div class="cdx-fair"><div class="cdx-fl">Combined market price</div><div class="cdx-fv">…</div><div class="cdx-fs">Loading eBay and TCGplayer sales…</div></div>`);
  loadComps(x, sel).then((R) => {
    if (detail !== x.id || dsel !== sel) return;
    const days = +drng, T = tcgData(x, R.tcg, sel), E = ebayData(x, R.ebay, sel, T.market), SE = stats(E.sold, E.act, days), ST = stats(T.sold, T.act, days);
    { const from = Date.now() - days * 864e5, wn = T.weeks.filter((b) => b[0] + 7 * 864e5 >= from).reduce((n, b) => n + (b[4] || 0), 0); if (wn > ST.n) ST.n = wn; }
    const all = [...SE.pts, ...ST.pts], SA = stats(all, [], days), fair = SA.med ?? T.market ?? SE.cheap, n = all.length;
    const fairBox = `<div class="cdx-fair"><div class="cdx-fl">Combined market price</div>
      <div class="cdx-fr"><span class="cdx-fv">${m0(fair)}</span>${SA.trend != null ? `<span class="cdx-ft">${SA.trend >= 0 ? "▲" : "▼"} ${Math.abs(SA.trend).toFixed(1)}%</span>` : ""}</div>
      <div class="cdx-fs">${n ? `${m0(SA.p25)} – ${m0(SA.p75)} · ${n} sale${n === 1 ? "" : "s"}` : SA.med == null && T.market != null ? "TCGplayer market price · no recent sales" : "No sales in this range"}</div></div>`;
    const qty = x.qty || 0, mine = qty && fair != null ? `<div class="cdx-mine"><div><b>Your ${qty} cop${qty === 1 ? "y" : "ies"}</b><div class="mu">${x.ovr > 0 ? "Your price" : "Collectr says"} ${money(unit(x) * qty)}</div></div><div class="cdx-mr"><b>${money(fair * qty)}</b><div class="mu">${own ? "at combined price" : "if " + esc(selLabel(sel))}</div></div></div>` : "";
    const tcgNote = sgi ? `<div class="cdx-k" style="margin-top:2px">TCGplayer doesn't sell graded cards</div>` : "";
    box.innerHTML = head(fairBox) + `<div class="cdx-ch">${chartSVG(SA, all, SA.p25, SA.p75)}</div>
    <div class="cdx-lg"><span><i class="cdx-ie"></i>eBay</span><span><i class="cdx-it"></i>TCGplayer</span><span><i class="cdx-ib"></i>Usual range</span></div>
    <div class="cdx-sites">${siteCard("eBay", "cdx-ie", "Median sold", SE.med, SE, E.soldOn ? "" : `<div class="cdx-k">eBay sold data is off</div>`)}${siteCard("TCGplayer", "cdx-it", T.market != null ? "Market price" : "Median sold", T.market ?? ST.med, ST, tcgNote)}</div>
    ${mine}
    <div class="sm">${esc(sgi ? sel + " sales only." : sel + " raw sales only.")}${own ? "" : " ★ marks your copy's condition."} Tap a dot to open that sale.${E.cut.junk + E.cut.far + E.cut.lang ? ` Left out ${E.cut.junk + E.cut.far + E.cut.lang} eBay result${E.cut.junk + E.cut.far + E.cut.lang === 1 ? "" : "s"} that looked like a different item (jumbo or metal cards, other languages, or prices far from TCGplayer's).` : ""}${R.warn.length ? " " + esc(R.warn.join(" ")) : ""}</div>`;
  }).catch((e) => { if (detail === x.id) box.innerHTML = head(`<div class="cdx-fair"><div class="cdx-fs">Couldn't load comps: ${esc(e.message)}</div></div>`); });
}
function openDetail(id) { if (!P.items.some((y) => y.id === id)) return; listY = scrollY; detail = id; cview = null; dsel = ownSel(P.items.find((y) => y.id === id)); editing = null; try { history.pushState({ ppd: id }, ""); } catch {} render(); scrollTo(0, 0); }
// toTab: leaving for the eBay or TCGplayer tab, so a scanned card's page doesn't reopen the scan list on top of it
function closeDetail(viaHistory, toTab) { if (!detail) return; const wasPreview = !!(preview && preview.id === detail); detail = null; preview = null; render(); scrollTo(0, listY); if (!viaHistory && history.state && history.state.ppd) try { history.back(); } catch {}
  // a scanned card's comps go back to the tab you were on, with the scan list open again
  if (wasPreview && !toTab) { const b = previewTab && previewTab !== "pf" && $("tb").querySelector(`[data-t="${previewTab}"]`); if (b) b.click(); sqOpen(); } }
// comps for a card in the scan list, before it's added to the portfolio
function sqComp(id) {
  const it = sqItem(id), c = it && it.pick >= 0 ? it.cards[it.pick] : null; if (!c) return;
  const x = { ...sqToItem(it, ""), id: "scan-" + it.id + "-" + it.pick, qty: 0 };
  if (!x.tcgId && c.tcgId) x.tcgId = c.tcgId;
  previewTab = typeof tab === "string" ? tab : ""; const ov = $("ppscan"); if (ov) ov.remove(); sqView = null; syncScrollLock();
  const b = $("tb").querySelector('[data-t="pf"]'); if (b && tab !== "pf") b.click();
  preview = x; listY = 0; detail = x.id; cview = null; dsel = ownSel(x); editing = null; try { history.pushState({ ppd: x.id }, ""); } catch {} render(); scrollTo(0, 0);
}
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
    mkt: v && v.price != null ? +v.price : null, ...(v && v.price != null ? { mktV: 2, pT: Date.now() } : {}), ovr: 0, watch: false, added: today(), notes: "", tcgId: tid,
    img: tid ? `https://tcgplayer-cdn.tcgplayer.com/product/${tid}_200w.jpg` : undefined, big: tid ? `https://tcgplayer-cdn.tcgplayer.com/product/${tid}_400w.jpg` : undefined, imgT: tid ? Date.now() : 0 };
  const same = P.items.find((y) => y.qty > 0 && keyOf(y) === keyOf(x));
  if (same) { same.qty += 1; if (x.mkt != null) same.mkt = x.mkt; } else P.items.push(x);
  store(); snap(); render();
  toast(same ? `Added another ${name} to ${pf || "your portfolio"} (now ${same.qty})` : `Added ${name} to ${pf || "your portfolio"}`,
    { label: "View", run: () => { const b = $("tb").querySelector('[data-t="pf"]'); if (b) b.click(); view = pf || "all"; findTxt = ""; render(); scrollTo({ top: 0, behavior: "smooth" }); } });
};

/* ---------- swipe a card left to show the trash can ---------- */
let sw = null, swJust = 0;
// fingers on the screen: a second finger means a pinch (zoom), so any swipe in progress is dropped
const swFingers = new Set();
const swCancel = () => { if (!sw) return; const s = sw; sw = null; s.c.classList.remove("drag"); s.c.style.transform = ""; if (s.on) swJust = Date.now(); };
document.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") { swFingers.add(e.pointerId); if (swFingers.size > 1) swCancel(); } }, true);
const swLift = (e) => swFingers.delete(e.pointerId);
document.addEventListener("pointerup", swLift, true); document.addEventListener("pointercancel", swLift, true);
document.addEventListener("touchstart", (e) => { if (e.touches.length > 1) swCancel(); }, { passive: true, capture: true });
const closeSwipes = (except) => document.querySelectorAll("#pf .pr.open").forEach((r) => r !== except && r.classList.remove("open"));
document.addEventListener("pointerdown", (e) => {
  const c = e.target.closest && e.target.closest("#pf .prc"); if (!c || selMode || e.button > 0 || swFingers.size > 1 || e.target.closest("button,a,input,select,label")) return;
  const row = c.parentNode; sw = { id: e.pointerId, row, c, x: e.clientX, y: e.clientY, base: row.classList.contains("open") ? -84 : 0, on: false };
});
document.addEventListener("pointermove", (e) => {
  if (!sw || e.pointerId !== sw.id) return; if (swFingers.size > 1) return swCancel(); const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
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
// every raw card gets TCGplayer's price for its condition and printing, including ones that came in with Collectr's
// price (that one stays until TCGplayer's arrives). Graded and Japanese cards keep Collectr's. A failed lookup is
// tried again a day later.
// TCGplayer's price for every raw card (Japanese included), for its condition and printing, refreshed once a day.
// Collectr's price shows only until TCGplayer's arrives. Graded cards keep Collectr's: TCGplayer sells no graded cards.
const needsPrice = (x, now) => x.qty > 0 && !isGraded(x) && (x.mktV !== 2 || now - (x.pT || 0) > 864e5) && !(x.pTry && now - x.pTry < 864e5);
function fillPrices() {
  const now = Date.now(), want = P.items.filter((x) => needsPrice(x, now) && !pfq.includes(x));
  if (!want.length) return; pfq.push(...want); pfTotal += want.length; pricePump(); pfProgress();
}
// the TCGplayer price lookup's progress: "N of M" and a bar that fills as cards are priced
const pfBusy = () => pfq.length > 0 || pfRunning > 0;
function pfBarHTML() {
  const on = pfBusy() && pfTotal > 0, pc = on ? Math.min(100, (pfDone / pfTotal) * 100) : 0;
  return `<div class="pfb" id="pfb" role="progressbar" aria-label="TCGplayer prices looked up" aria-valuemin="0" aria-valuemax="${pfTotal}" aria-valuenow="${pfDone}"${on ? "" : " hidden"}><i style="width:${pc.toFixed(1)}%"></i></div>`;
}
const pfText = () => (pfBusy() && pfTotal > 0 && !pending ? `Looking up TCGplayer prices: ${pfDone.toLocaleString()} of ${pfTotal.toLocaleString()} (${Math.floor((pfDone / pfTotal) * 100)}%)…` : "");
function pfProgress() {
  const s = $("pfs"), b = $("pfb"), on = pfBusy() && pfTotal > 0;
  if (s && !pending) s.textContent = pfText();
  if (b) { b.hidden = !on; b.setAttribute("aria-valuemax", pfTotal); b.setAttribute("aria-valuenow", pfDone); b.firstElementChild.style.width = (on ? Math.min(100, (pfDone / pfTotal) * 100) : 0).toFixed(1) + "%"; }
}
async function priceOne(x) {
  if (!x.tcgId) { const j = await getJSON("/api/cardimg?" + new URLSearchParams({ name: x.name, set: x.set || "", num: x.num || "", cat: x.cat || "" })).catch(() => null);
    if (j && j.tcgId) { x.tcgId = j.tcgId; if (!x.img && j.img) { x.img = j.img; x.big = j.big; x.imgT = Date.now(); } } }
  if (!x.tcgId) { x.pWhy = "not found on TCGplayer"; return false; }
  // a live price set in the last day (from the trade analyzer) isn't replaced by the slower weekly figure
  if (x.mktLive && Date.now() - x.mktLive < 864e5 && x.mkt > 0) return true;
  const j = await getJSON("/api/tcgprice?" + new URLSearchParams({ id: x.tcgId, cond: x.cond || "Near Mint", print: x.var || "", jp: isJp(x) ? "1" : "" })).catch(() => null);
  if (!j) { x.pWhy = "TCGplayer didn't answer, trying again tomorrow"; return false; }
  if (!(j.market > 0)) { x.pWhy = j.why || "no TCGplayer price"; return false; }
  x.mkt = j.market; x.mktEst = !!j.est; x.mktV = 2; x.pT = Date.now(); delete x.mktSrc; delete x.pWhy; return true;
}
function pricePump() {
  while (pfRunning < 2 && pfq.length) {
    const x = pfq.shift(); pfRunning++;
    priceOne(x).then((ok) => {
      pfRunning--; pfDone++; x.pTry = Date.now(); if (!ok && x.pT && x.mktV !== 2) { x.mkt = null; x.mktEst = false; }
      pfProgress();
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
    tcgId: tid && /^\d+$/.test(String(tid)) ? String(tid) : null, img: /^https:\/\//.test(String(img || "")) ? String(img) : undefined, src: "collectr-link",
    ...jpPrice(o, name, f) };
}
// Japanese cards: TCGplayer seldom has comps for them, so they keep the price Collectr lists
function jpPrice(o, name, f) {
  const set = String(pick(f, /^(catalog_?group(_?name)?|group_?name|set_?name)$/) || ""), mp = parseFloat(o.market_price);
  return (/japan/i.test(set) || /\(jp\)/i.test(String(name))) && mp > 0 ? { mkt: +mp.toFixed(2), mktSrc: "collectr" } : {};
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
    if (a === "replace") { try { localStorage.setItem(UNDO_KEY, JSON.stringify({ at: Date.now(), source: "Collectr link", P })); } catch {} P = { ...P, items: only ? P.items.filter((x) => x.pf !== only).concat(items) : items }; }
    else if (!(await smartMerge(items, only ? `Collectr's ${only}` : "the Collectr link", only ? new Set([only]) : null, new Set([only, ...((cimp.raw && cimp.raw.others) || [])].filter(Boolean))))) return;
    P.source = "Collectr link"; store(); cimp = null; view = "all"; shown = PAGE; render(); fillPrices();
    toast(`Imported ${items.length.toLocaleString()} entries from Collectr`, { label: "Undo", run: undoImport });
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
    <li><b>Paste the URL code:</b> open <b>Bookmarks</b>, find the new one, and choose <b>Edit</b>. Name it <b>Send to Price Plot</b>, replace its URL with the code you copied, and save.</li>
    <li><b>Send to bookmark:</b> open your Collectr showcase link in Chrome, choose your desired portfolio, and wait for your cards to load. Tap the address bar, type <b>Send to</b>, and tap <b>Send to Price Plot</b> in the suggestions. On a computer you can also click it in the bookmarks bar.</li></ol>
    ${bm ? `<p class="mu">On a computer, you can instead drag this to your bookmarks bar: <a class="pill" href="${esc(bm)}" onclick="return false">Send to Price Plot</a></p>` : ""}
    <p class="mu">If you sign into Chrome, a bookmark made on a computer shows up on your phone too.</p>`;
  const use = `<p><b>Send to Shortcut:</b> open your Collectr showcase link in Safari, choose your desired portfolio, and wait for your cards to load. Tap <b>Share</b> (the square with an arrow), scroll down the list and tap <b>Send to Price Plot</b>. If it isn't there, tap <b>Edit Actions…</b> at the bottom and turn it on. Price Plot opens with your cards to review.</p>`;
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
  <div data-pane="pick">${typeof HOME_APP !== "undefined" && HOME_APP ? "" : `<div class="cs-tip"><b>For the best experience, add Price Plot to your Home Screen before importing your portfolio.</b>
    <details><summary>How</summary><p><b>iPhone (Safari or Chrome):</b> tap <b>Share</b> → <b>Add to Home Screen</b> → <b>Add</b>.<br><b>Android (Chrome):</b> tap <b>⋮</b> → <b>Add to Home screen</b> (or <b>Install app</b>).<br><b>Computer (Chrome or Edge):</b> click the install icon at the right of the address bar.</p></details></div>`}
  <p class="mu">Works without Collectr PRO. Which browser do you use to open your Collectr showcase?</p>
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

/* ---------- card scanner ---------- */
// Take a photo of a card: the phone reads the text on it (free, in the browser), Price Plot finds the matching cards
// by name and number, and you pick the right one and add it to a portfolio.
let ocrWorker = null;
function loadOcr() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = new Promise((ok, no) => {
    const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = async () => { try { ok(await window.Tesseract.createWorker("eng")); } catch (e) { no(e); } };
    s.onerror = () => no(new Error("couldn't load the text reader, check your connection")); document.head.appendChild(s);
  });
  ocrWorker.catch(() => (ocrWorker = null));
  return ocrWorker;
}
// photo → a smaller, high-contrast gray image, which reads faster and better
function prepImage(file) {
  return new Promise((ok, no) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { const sc = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc); const g = c.getContext("2d"); g.drawImage(img, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
      for (let i = 0; i < p.length; i += 4) { let v = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; v = Math.max(0, Math.min(255, (v - 128) * 1.5 + 128)); p[i] = p[i + 1] = p[i + 2] = v; }
      const color = document.createElement("canvas"), s2 = Math.min(1, 960 / Math.max(img.width, img.height)); color.width = Math.round(img.width * s2); color.height = Math.round(img.height * s2);
      color.getContext("2d").drawImage(img, 0, 0, color.width, color.height); const photo = color.toDataURL("image/jpeg", 0.8);
      g.putImageData(d, 0, 0); URL.revokeObjectURL(url); ok({ canvas: c, preview: photo, photo }); };
    img.onerror = () => no(new Error("couldn't open that photo")); img.src = url;
  });
}
const SKIP_WORDS = /^(basic|stage|stage ?[12]|pok[eé]mon|trainer|item|supporter|stadium|energy|evolves|tool|ability|weakness|resistance|retreat|illus\.?|hp)$/i;
function parseCardText(text) {
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let n = "", d = "";
  const m = /\b([A-Z]{0,4}\d{1,3}[a-z]?)\s*\/\s*([A-Z]{0,4}\d{1,3})\b/.exec(text);
  if (m) { n = m[1]; d = /^\d+$/.test(m[2]) ? String(+m[2]) : ""; }
  else { const p = /\b(SVP|SWSH|SM|XY|BW|DP|HGSS|SV)\s*-?\s*(\d{1,3})\b/i.exec(text); if (p) n = p[1].toUpperCase() + p[2].padStart(p[1].length > 2 ? 3 : 2, "0"); }
  let name = "";
  for (const l of lines.slice(0, 8)) {
    const w = l.replace(/[^A-Za-zÀ-ÿ'’&.\- ]/g, " ").split(/\s+/).filter((x) => x.length > 1 && !SKIP_WORDS.test(x));
    const t = w.join(" ").replace(/\bHP\b.*$/i, "").trim();
    if (t.replace(/[^A-Za-z]/g, "").length >= 3) { name = t.split(" ").slice(0, 4).join(" "); break; }
  }
  return { name, n, d };
}
/* Scan queue: take photos one after another (or pick several from the photo library). Each card is read in the
   background while you take the next, and the results build up in one list you can check, edit and add
   individually or all at once. The list is kept on this device (with small thumbnails) until you clear it. */
const SQ_KEY = "pp_scanq", SQ_MAX = 80, SQ_PARALLEL = 2;
let scanQ = (() => { try { const q = JSON.parse(localStorage.getItem(SQ_KEY) || "[]"); return Array.isArray(q) ? q : []; } catch { return []; } })();
// a card that was still being read when the page closed lost its photo
// a price lookup cut off when the page closed starts again
for (const it of scanQ) if (it.px === undefined) it.pxK = null;
for (const it of scanQ) if (it.st === "wait" || it.st === "reading") { it.st = "error"; it.err = "The photo was lost when the page closed. Scan this card again."; }
const sqPhotos = new Map(); // id -> { photo, canvas }, kept only until the card is read
let sqView = null, sqBusy = 0, sqDefaults = (() => { try { return JSON.parse(localStorage.getItem(SQ_KEY + "_d") || "{}"); } catch { return {}; } })();
function sqSave() {
  try { localStorage.setItem(SQ_KEY, JSON.stringify(scanQ.slice(-SQ_MAX))); localStorage.setItem(SQ_KEY + "_d", JSON.stringify(sqDefaults)); }
  catch { try { localStorage.setItem(SQ_KEY, JSON.stringify(scanQ.slice(-SQ_MAX).map((x) => ({ ...x, thumb: "" })))); } catch {} }
}
const sqItem = (id) => scanQ.find((x) => x.id === id);
const sqNum = (c) => (c ? `${c.number}${c.printedTotal && /^\d+$/.test(c.number) ? "/" + c.printedTotal : ""}` : "");
function sqThumb(dataUrl) {
  return new Promise((ok) => { const img = new Image(); img.onload = () => { const s = Math.min(1, 220 / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); ok(c.toDataURL("image/jpeg", 0.7)); };
    img.onerror = () => ok(""); img.src = dataUrl; });
}

// add photos (File or Blob) to the list; reading starts right away, two at a time
async function sqAdd(files) {
  const list = [...files].filter(Boolean);
  for (const f of list) {
    const it = { id: uid(), st: "wait", thumb: "", cards: [], pick: -1, cond: "Near Mint", qty: 1, /* every new scan starts at Near Mint, whatever the last card was set to */ sel: true, added: Date.now() };
    scanQ.push(it);
    const lst = !sqView && document.querySelector("#ppscan .sq-list");
    if (lst) { lst.insertAdjacentHTML("beforeend", sqRowHTML(it)); const top = document.querySelector("#ppscan .sq-top .mu"); if (top) top.textContent = `${scanQ.length} card${scanQ.length === 1 ? "" : "s"}`; sqBar(); }
    else { sqView = null; sqRender(); }
    try { const im = await prepImage(f); sqPhotos.set(it.id, im); it.thumb = await sqThumb(im.preview); }
    catch (e) { it.st = "error"; it.err = "Couldn't open that photo: " + e.message; }
    sqRow(it); sqSave(); sqPump();
  }
  if (scanQ.length > SQ_MAX) toast(`The list keeps the last ${SQ_MAX} cards. Add or clear some to make room.`);
}
function sqPump() {
  while (sqBusy < SQ_PARALLEL) {
    const it = scanQ.find((x) => x.st === "wait" && sqPhotos.has(x.id)); if (!it) break;
    sqBusy++; it.st = "reading"; sqRow(it);
    sqRead(it).catch((e) => { it.st = "error"; it.err = "Couldn't read the card: " + e.message; })
      .finally(() => { sqBusy--; sqPhotos.delete(it.id); sqRow(it); sqBar(); sqSave(); sqPump(); });
  }
  sqCount();
}
async function sqRead(it) {
  const im = sqPhotos.get(it.id); it.aiErr = "";
  // the AI reads the whole card (edition, holo, language, stamps); text reading is the fallback
  try {
    let r, j;
    for (let t = 0; t < 4; t++) {
      r = await fetch("/api/scan-ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: im.photo }) }).catch(() => null);
      j = r ? await r.json().catch(() => null) : null;
      if (r && (r.ok || j) && !(r.status === 429 && t < 3 && !/today/i.test((j && j.error) || ""))) break;
      if (t === 3) break;
      it.note = r && r.status === 429 ? "Busy, waiting a moment…" : "Price Plot is starting up, trying again…"; sqRow(it);
      await new Promise((ok) => setTimeout(ok, r && r.status === 429 ? 15000 : 5000));
    }
    it.note = ""; j = j || {};
    if (!r) throw new Error("no connection");
    if (r.ok) { const a = j.read || {};
      it.ai = a; it.print = j.print || ""; it.grade = j.grade || "";
      it.read = { name: a.name_english || a.name || "", n: a.number || "", d: a.set_total || "" };
      it.cards = j.cards || []; it.pick = it.cards.length ? 0 : -1;
      it.unsure = a.found === false || !it.cards.length || (a.confidence != null && +a.confidence < 0.6);
      it.err = a.found === false ? "Couldn't find a card in that photo. Try again closer, with less glare." : !it.cards.length ? "No matching cards found. Tap Fix to search." : "";
      it.st = "ready"; return; }
    it.aiErr = j.error || (r.status >= 502 ? "Price Plot's server was restarting" : "AI scan failed (" + r.status + ")");
  } catch (e) { it.aiErr = "AI scan failed: " + e.message; }
  it.ai = null; it.print = ""; it.grade = "";
  it.note = "Reading the text instead…"; sqRow(it);
  const w = await loadOcr(); const { data } = await w.recognize(im.canvas);
  await sqFind(it, parseCardText(data.text));
  it.unsure = true;
}
async function sqFind(it, read) {
  it.read = read; it.err = ""; it.note = ""; it.manual = false; it.okPf = false;
  try { const j = await getJSON("/api/scan-match?" + new URLSearchParams({ name: read.name || "", n: read.n || "", d: read.d || "" })); it.cards = j.cards || []; }
  catch (e) { it.cards = []; it.err = e.message; }
  it.pick = it.cards.length ? 0 : -1; if (!it.cards.length && !it.err) it.err = "No matching cards found. Tap Fix to search.";
  it.st = "ready"; it.pxK = null;
  if (it.pick >= 0) setTimeout(() => sqPrice(it), 0);
}

// --- TCGplayer market price for each scanned card, for its chosen condition and printing ---
const sqJp = (it, c) => /japan/i.test(c.set || "") || !!(it.ai && /japan/i.test(it.ai.language || ""));
function sqPrints(it, c) { if (!c) return []; let pr = c.prints && c.prints.length ? c.prints.slice() : ["Normal"]; if (it.print && !pr.includes(it.print)) pr = [it.print, ...pr]; return pr; }
const sqPxKey = (it) => [it.pick, it.cond || "Near Mint", it.print || "", sqOwnMode() ? (it.pid || "") + (it.mcond || "") : ""].join("|");
async function sqPrice(it) {
  const c = it.pick >= 0 ? it.cards[it.pick] : null; if (!c) return;
  if (!it.print) it.print = sqPrints(it, c)[0];
  const k = sqPxKey(it); if (it.pxK === k) return;
  it.pxK = k; it.px = undefined; it.pxEst = false; it.pxCond = "";
  // one of your cards in the trade: TCGplayer's live price for your copy's product, condition and printing.
  // When it differs from what your portfolio has, your portfolio is updated to it. Graded copies keep Collectr's price.
  // a price you typed in for your copy is its value; graded copies use Collectr's; finding cards in your portfolio uses
  // the portfolio's own price (nothing is looked up unless the condition is changed)
  const cp = sqOwnMode() && it.pid ? P.items.find((x) => x.id === it.pid) : null, same = cp && (!it.mcond || it.mcond === sqCopyCond(cp));
  it.pxSrc = "";
  const showCopy = () => { it.px = unit(cp); it.pxEst = !!cp.mktEst && !(cp.ovr > 0); it.pxCond = ""; it.pxSrc = cp.ovr > 0 ? "own" : isGraded(cp) ? "collectr" : ""; sqSave(); if (!sqView) sqRow(it); else sqBar(); };
  if (same && cp.ovr > 0) return showCopy();
  if (same && isGraded(cp)) { if (cp.mkt != null) showCopy(); else { it.px = null; sqSave(); if (!sqView) sqRow(it); } return; }
  if (same && sqTarget === "select" && cp.mkt != null) return showCopy();
  let px = null, est = false, cond = "", fbUsed = false, live = false;
  try {
    // cards matched through pokemontcg.io don't carry a TCGplayer product id yet: find it the same way card pictures are found
    let fb = null;
    if (!c.tcgId && !(cp && cp.tcgId)) { const j = await getJSON("/api/cardimg?" + new URLSearchParams({ name: c.name, set: c.set || "", num: sqNum(c), cat: "Pokemon" })); if (j.tcgId) c.tcgId = j.tcgId; else if (j.market > 0) fb = j.market; }
    const tid = (cp && cp.tcgId) || c.tcgId;
    if (tid) { const j = await getJSON("/api/tcgprice?" + new URLSearchParams({ id: tid, cond: it.cond || "Near Mint", print: it.print || "", jp: sqJp(it, c) ? "1" : "", ...(sqTarget === "trade" || sqTarget === "tradeGive" ? { live: "1" } : {}) })); px = j.market ?? null; est = !!j.est; cond = j.cond || ""; live = !!j.live; }
    else if (fb) { px = fb; est = true; fbUsed = true; }
  } catch {}
  if (it.pxK !== k) return; // the condition, printing or match changed while this was loading
  if (same && !(px > 0) && (cp.ovr > 0 || cp.mkt != null)) return showCopy(); // TCGplayer had nothing: your copy's price
  if (same && px > 0 && !fbUsed && sqTarget === "tradeGive") {
    if (!cp.tcgId && c.tcgId) cp.tcgId = c.tcgId;
    if (pfSetLive(cp, px, est, live)) trDraw();
  }
  it.px = px; it.pxEst = est; it.pxCond = cond; sqSave();
  if (!sqView) sqRow(it); else sqBar();
}
// price every card that has a match, two at a time
function sqPriceAll() {
  const todo = scanQ.filter((it) => it.pick >= 0 && it.pxK !== sqPxKey(it)); let i = 0;
  const next = () => { const it = todo[i++]; if (it) sqPrice(it).finally(next); };
  next(); next();
}
const sqVal = (it) => (it.px > 0 ? it.px * Math.max(1, Math.round(+it.qty || 1)) : 0);
function sqPriceHTML(it, c) {
  if (!c) return "";
  if (it.pxK !== sqPxKey(it) || it.px === undefined) return `<div class="sq-p mu">TCGplayer: looking up price…</div>`;
  if (!(it.px > 0)) return `<div class="sq-p mu">TCGplayer: no price found</div>`;
  const q = Math.max(1, Math.round(+it.qty || 1));
  const tip = it.pxEst ? ` <span class="mu" title="No recent sales in this condition on TCGplayer, so this is the Near Mint price with the usual discount">(est.)</span>` : "";
  return `<div class="sq-p">${it.pxSrc === "own" ? "Your price" : it.pxSrc === "collectr" ? "Collectr" : "TCGplayer"} <span class="sq-pv">${money(it.px)}</span>${q > 1 ? ` <span class="mu">× ${q} =</span> <span class="sq-pv">${money(it.px * q)}</span>` : ""}${tip}${it.grade && !it.pxSrc ? ` <span class="mu">(raw price, not graded)</span>` : ""}</div>`;
}

// --- Shadowless: Base Set cards only. TCGplayer lists the Shadowless print as its own product, so ticking the box swaps
// the matched card for that product (and back), and the price, sales and comps follow. ---
const sqIsBase = (c) => !!c && /^base( set)?( \(shadowless\))?$/i.test(String(c.set || "").trim());
const sqIsShadow = (c) => !!c && /shadowless/i.test(String(c.set || ""));
function sqShadowHTML(it, c) {
  if (!sqIsBase(c)) return "";
  return `<label class="sq-sh"><input type="checkbox" data-qsh="${it.id}" ${sqIsShadow(c) ? "checked" : ""} ${it.shBusy ? "disabled" : ""}> Shadowless${it.shBusy ? ` <span class="mu">finding it…</span>` : it.shErr ? ` <span class="sq-st warn">${esc(it.shErr)}</span>` : ""}</label>`;
}
async function sqShadow(it, on) {
  const c = it.pick >= 0 ? it.cards[it.pick] : null; if (!c || on === sqIsShadow(c)) return;
  it.shErr = "";
  // going back to the version the scan first matched, when there is one
  if (!on && it.shFrom != null && it.cards[it.shFrom] && !sqIsShadow(it.cards[it.shFrom])) { it.pick = it.shFrom; it.shFrom = null; sqSave(); return sqRow(it, true); }
  it.shBusy = true; sqRow(it, true);
  try {
    const j = await getJSON("/api/scan-edition?" + new URLSearchParams({ name: c.name, n: c.number, d: c.printedTotal || "", want: on ? "shadowless" : "unlimited" }));
    const nc = j.card, at = it.cards.findIndex((x) => x.tcgId && x.tcgId === nc.tcgId);
    const from = it.pick;
    it.pick = at >= 0 ? at : it.cards.push(nc) - 1;
    if (on) it.shFrom = from; else it.shFrom = null;
    // keep the printing: "Unlimited Holofoil" is just "Holofoil" on the Shadowless product
    const pr = String(it.print || "").replace(/^Unlimited /, ""), list = it.cards[it.pick].prints || [];
    it.print = list.includes(pr) ? pr : list[0] || pr;
  } catch (e) { it.shErr = e.message; }
  it.shBusy = false; sqSave(); sqRow(it, true);
}

// --- recent TCGplayer sales for a scanned card: a fold-out list, loaded only when opened ---
const sqSalesData = new Map(), sqSalesJob = new Map(); // TCGplayer product id -> { sold, at } or { error }
async function sqSalesLoad(it) {
  const c = it.pick >= 0 ? it.cards[it.pick] : null; if (!c) return;
  if (!c.tcgId) { try { const j = await getJSON("/api/cardimg?" + new URLSearchParams({ name: c.name, set: c.set || "", num: sqNum(c), cat: "Pokemon" })); if (j.tcgId) c.tcgId = j.tcgId; } catch {} }
  const id = c.tcgId;
  if (!id) { sqSalesData.set("none:" + c.id, { error: "couldn't find this card on TCGplayer" }); return sqSalesPaint(it); }
  const have = sqSalesData.get(id); if (have && !have.error && Date.now() - have.at < 30 * 60e3) return sqSalesPaint(it);
  if (!sqSalesJob.has(id)) sqSalesJob.set(id, getJSON("/api/tcgplayer?id=" + encodeURIComponent(id))
    .then((j) => sqSalesData.set(id, { sold: j.sold || [], at: Date.now() }), (e) => sqSalesData.set(id, { error: e.message }))
    .finally(() => sqSalesJob.delete(id)));
  await sqSalesJob.get(id);
  for (const x of scanQ) if (x.lsOpen && x.pick >= 0 && x.cards[x.pick] && x.cards[x.pick].tcgId === id) sqSalesPaint(x);
}
// redraw only the sales fold-out, so tapping it (which focuses the row) still shows the list right away
function sqSalesPaint(it) {
  const el = document.querySelector(`#ppscan [data-qls="${it.id}"]`), c = it.pick >= 0 ? it.cards[it.pick] : null;
  if (el && c) el.outerHTML = sqSalesHTML(it, c);
}
function sqSalesHTML(it, c) {
  if (!c || !(it.px > 0) || it.pxK !== sqPxKey(it)) return "";
  const d = sqSalesData.get(c.tcgId || "") || sqSalesData.get("none:" + c.id);
  let body = `<div class="mu">Loading sales…</div>`;
  if (d && d.error) body = `<div class="mu">Sales unavailable (${esc(d.error)})</div>`;
  else if (d) {
    // the card's own condition and printing, in English unless it's a Japanese card
    const want = it.cond || "Near Mint", pr = String(it.print || "").toLowerCase(), jp = sqJp(it, c);
    const langOk = (x) => !x.lang || (jp ? /japan/i.test(x.lang) : /english/i.test(x.lang));
    const sorted = d.sold.filter(langOk).slice().sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const samePr = sorted.filter((x) => !pr || String(x.print || "").toLowerCase() === pr);
    // only the card's selected condition
    const list = samePr.filter((x) => tcCond(x.cond) === want).slice(0, 10), note = "";
    const day = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(Date.now() - Date.parse(t) > 300 * 864e5 ? { year: "numeric" } : {}) });
    body = list.length ? `${note ? `<div class="mu sq-lsn">${esc(note)}</div>` : ""}<ul class="sq-ls">${list.map((x) => `<li><span>${day(x.date)}</span><span class="mu">${esc(COND_CODE[tcCond(x.cond)] || tcCond(x.cond) || "")}${x.qty > 1 ? " ×" + x.qty : ""}</span><b>${money(x.price)}</b></li>`).join("")}</ul>`
      : `<div class="mu">No recent ${esc(COND_CODE[want] || want)} sales on TCGplayer for this printing.</div>`;
  }
  return `<details class="sq-lsd" data-qls="${it.id}"${it.lsOpen ? " open" : ""}><summary>Last sold<i class="sq-chev" aria-hidden="true"></i></summary>${it.lsOpen ? body : ""}</details>`;
}

// --- offer: a percentage of the TCGplayer market price, per card, or a dollar amount you type ---
const SQ_PRESETS = [60, 70, 75, 80, 85];
const sqPctOf = (it) => { const v = it.pct ?? sqDefaults.pct ?? 70; return Number.isFinite(+v) ? Math.min(200, Math.max(0, +v)) : 70; };
const sqPctTxt = (v) => String(Math.round(v * 10) / 10);
// a typed dollar offer is kept exactly (its % is worked out from it) until the % is changed or the market price changes
const sqTyped = (it) => it.offAmt != null && it.offK === sqPxKey(it);
const sqOffer = (it) => (!(it.px > 0) ? 0 : sqTyped(it) ? it.offAmt : Math.round(it.px * sqPctOf(it)) / 100); // each, to the cent
const sqOfferVal = (it) => sqOffer(it) * Math.max(1, Math.round(+it.qty || 1));
const sqOffTxt = (v) => (Math.round(v * 100) / 100).toFixed(2);
// the folded line: offer each, its %, and the total when there's more than one copy
function sqOfferSum(it) {
  const q = Math.max(1, Math.round(+it.qty || 1));
  return `<span class="sq-osl">Offer</span> <span class="sq-pv">${money(sqOffer(it))}</span> <span class="mu">· ${sqPctTxt(sqPctOf(it))}%${q > 1 ? ` · ${money(sqOfferVal(it))} for ${q}` : ""}</span><i class="sq-chev" aria-hidden="true"></i>`;
}
function sqOfferHTML(it, c) {
  if (!c || !(it.px > 0) || it.pxK !== sqPxKey(it)) return "";
  if (it.pct == null) it.pct = sqPctOf(it); // each card keeps its own %; the last one used is only where new cards start
  const v = sqPctOf(it);
  // folded into an "Offer" line so the list stays tidy; tap it to open the controls (stays open while you scan)
  return `<details class="sq-o" data-qo2="${it.id}"${it.offOpen ? " open" : ""}>
    <summary class="sq-os">${sqOfferSum(it)}</summary>
    <div class="sq-oc"><div class="sq-or"><div class="sq-ot"><label class="sq-od">Each $<input type="number" data-qoff="${it.id}" min="0" step="0.01" inputmode="decimal" value="${sqOffTxt(sqOffer(it))}" aria-label="Offer price each, in dollars"></label></div>
      <label class="sq-pn"><input type="number" data-qpct="${it.id}" min="0" max="200" step="0.5" inputmode="decimal" value="${sqPctTxt(v)}" aria-label="Offer percent of TCGplayer market">%</label></div>
    <input type="range" class="sq-rg" data-qpct="${it.id}" min="0" max="100" step="1" value="${Math.min(100, Math.round(v))}" aria-label="Offer percent of TCGplayer market">
    <div class="sq-pp">${SQ_PRESETS.map((x) => `<button type="button" class="sq-pb" data-qpp="${x}" data-qid="${it.id}" aria-pressed="${!sqTyped(it) && v === x}">${x}%</button>`).join("")}</div>
  </div></details>`;
}
// redraw the offer box in place (not the whole row), skipping the box being typed or dragged in
function sqOfferSync(it, from) {
  const box = document.querySelector(`#ppscan [data-qo2="${it.id}"]`);
  if (box) {
    const v = sqPctOf(it), n = box.querySelector("input[data-qpct][type=number]"), r = box.querySelector("input[type=range]"), o = box.querySelector("input[data-qoff]");
    box.querySelector(".sq-os").innerHTML = sqOfferSum(it);
    if (n && n !== from) n.value = sqPctTxt(v);
    if (r && r !== from) r.value = Math.min(100, Math.round(v));
    if (o && o !== from) o.value = sqOffTxt(sqOffer(it));
    box.querySelectorAll("[data-qpp]").forEach((b) => b.setAttribute("aria-pressed", String(!sqTyped(it) && +b.dataset.qpp === v)));
  }
  sqBar();
}
// --- offer for the whole list: the same controls as one card, acting on every priced card at once ---
let sqGoOpen = false;
const sqPriced = () => scanQ.filter((it) => it.pick >= 0 && it.px > 0 && it.pxK === sqPxKey(it));
function sqGroupStats() {
  const L = sqPriced(), market = L.reduce((a, it) => a + it.px * Math.max(1, Math.round(+it.qty || 1)), 0), offer = L.reduce((a, it) => a + sqOfferVal(it), 0);
  const pcts = new Set(L.map((it) => (sqTyped(it) ? "t" : sqPctOf(it))));
  // one shared % (when every card uses the same one), otherwise the overall % of market
  const same = pcts.size === 1 && !pcts.has("t") ? sqPctOf(L[0]) : null;
  return { L, market, offer, pct: same ?? (market ? Math.round((offer / market) * 1000) / 10 : sqDefaults.pct ?? 70), same, cards: L.reduce((a, it) => a + Math.max(1, Math.round(+it.qty || 1)), 0) };
}
function sqGroupSum(g) {
  return `<span class="sq-osl">Offer for all</span> <span class="sq-pv">${money(g.offer)}</span> <span class="mu">· ${sqPctTxt(g.pct)}%${g.same == null ? " overall" : ""} · ${g.cards} card${g.cards === 1 ? "" : "s"}</span><i class="sq-chev" aria-hidden="true"></i>`;
}
function sqGroupHTML() {
  const g = sqGroupStats();
  return `<details class="sq-o sq-go" id="sq-go"${sqGoOpen ? " open" : ""}${g.L.length ? "" : " hidden"}>
    <summary class="sq-os">${sqGroupSum(g)}</summary>
    <div class="sq-oc"><div class="sq-or"><div class="sq-ot"><label class="sq-od">Total $<input type="number" data-qgoff="1" min="0" step="0.01" inputmode="decimal" value="${sqOffTxt(g.offer)}" aria-label="Offer total for the whole list, in dollars"></label></div>
      <label class="sq-pn"><input type="number" data-qgpct="1" min="0" max="200" step="0.5" inputmode="decimal" value="${sqPctTxt(g.pct)}" aria-label="Offer percent of TCGplayer market for every card">%</label></div>
    <input type="range" class="sq-rg" data-qgpct="1" min="0" max="100" step="1" value="${Math.min(100, Math.round(g.pct))}" aria-label="Offer percent of TCGplayer market for every card">
    <div class="sq-pp">${SQ_PRESETS.map((x) => `<button type="button" class="sq-pb" data-qgpp="${x}" aria-pressed="${g.same === x}">${x}%</button>`).join("")}</div>
    <div class="mu sq-gn">Sets every priced card; you can still change any card on its own.</div></div>
  </details>`;
}
// update the list-wide box in place, leaving alone whatever is being typed in or dragged
function sqGroupSync() {
  const box = $("sq-go"); if (!box) return;
  const g = sqGroupStats(), act = document.activeElement;
  box.hidden = !g.L.length;
  box.querySelector(".sq-os").innerHTML = sqGroupSum(g);
  const o = box.querySelector("input[data-qgoff]"), n = box.querySelector("input[data-qgpct][type=number]"), r = box.querySelector("input[type=range]");
  if (o && o !== act) o.value = sqOffTxt(g.offer);
  if (n && n !== act) n.value = sqPctTxt(g.pct);
  if (r && r !== act) r.value = Math.min(100, Math.round(g.pct));
  box.querySelectorAll("[data-qgpp]").forEach((b) => b.setAttribute("aria-pressed", String(g.same === +b.dataset.qgpp)));
}
function sqGroupSetPct(v) {
  v = Math.min(200, Math.max(0, Math.round(+v * 10) / 10)); if (!Number.isFinite(v)) return;
  sqDefaults.pct = v;
  for (const it of sqPriced()) { it.pct = v; it.offAmt = null; sqOfferSync(it); }
  sqGroupSync();
}
// a typed total is shared out in proportion to each card's market price, to the cent, adding up exactly
function sqGroupSetTotal(amt) {
  const L = sqPriced(); if (!L.length) return;
  const q = (it) => Math.max(1, Math.round(+it.qty || 1)), market = L.reduce((a, it) => a + it.px * q(it), 0); if (!(market > 0)) return;
  amt = Math.min(Math.max(0, Math.round(+amt * 100) / 100), Math.round(market * 200) / 100); if (!Number.isFinite(amt)) return;
  const ratio = amt / market;
  for (const it of L) { it.offAmt = Math.round(it.px * ratio * 100) / 100; it.offK = sqPxKey(it); }
  // put the leftover cents on a single-copy card (or the largest one) so the total is exact
  let diff = Math.round((amt - L.reduce((a, it) => a + it.offAmt * q(it), 0)) * 100) / 100;
  if (diff) { const one = L.filter((it) => q(it) === 1).sort((a, b) => b.px - a.px)[0]; if (one) one.offAmt = Math.max(0, Math.round((one.offAmt + diff) * 100) / 100); }
  for (const it of L) { it.pct = Math.round((it.offAmt / it.px) * 1000) / 10; sqOfferSync(it); }
  sqGroupSync();
}
function sqSetPct(it, v, from) {
  v = Math.min(200, Math.max(0, Math.round(+v * 10) / 10)); if (!Number.isFinite(v)) return;
  it.pct = v; it.offAmt = null; sqDefaults.pct = v; // the next cards you scan start at the % you used last
  sqOfferSync(it, from);
}
function sqSetOffer(it, amt, from) {
  amt = Math.round(Math.max(0, +amt) * 100) / 100; if (!Number.isFinite(amt) || !(it.px > 0)) return;
  amt = Math.min(amt, Math.round(it.px * 200) / 100); // no more than 200% of market, like the % box
  it.offAmt = amt; it.offK = sqPxKey(it); it.pct = Math.round((amt / it.px) * 1000) / 10;
  sqOfferSync(it, from);
}

// --- the list window ---
function sqOpen() { sqView = null; sqRender(); }
// scanning your own cards for a trade: the scan finds the card, your portfolio says which copy (condition, grade, printing, value)
function sqMine(it, c) {
  const n = mName(c.name), k = mNum(sqNum(c));
  return owned(P.items).filter((x) => x.qty > 0 && mName(x.name) === n && mNum(x.num) === k && (!x.tcgId || !c.tcgId || String(x.tcgId) === String(c.tcgId)))
    .sort((a, b) => b.qty - a.qty);
}
function sqMinePick(it, mine) {
  if (it.pid && mine.some((x) => x.id === it.pid)) return it.pid;
  const g = (it.grade || "").trim(), x = (g ? mine.find((y) => isGraded(y) && shortGrade(y.grade) === shortGrade(g)) : mine.find((y) => !isGraded(y) && (y.cond || "Near Mint") === (it.cond || "Near Mint"))) || mine[0];
  return (it.pid = x ? x.id : null);
}
// in the trade's "your cards" scanner only cards you own are offered: the scan's matches are narrowed to your portfolio,
// and copies in your portfolio that fit what was read (name and number) are added as matches if the search missed them
function sqOwnFix(it) {
  if (!it.cards || it.st !== "ready") return [];
  const own = () => it.cards.map((c, i) => (sqMine(it, c).length ? i : -1)).filter((i) => i >= 0);
  const add = (x) => { if (it.cards.some((c) => c.id === "pf-" + x.id) || it.cards.some((y) => sqMine(it, y).some((m) => m.id === x.id))) return;
    it.cards.push({ id: "pf-" + x.id, tcgId: x.tcgId || null, name: x.name, number: String(x.num || "").split("/")[0], printedTotal: String(x.num || "").split("/")[1] || "", set: x.set || "", image: x.img || "", big: x.big || "", prints: x.var ? [x.var] : [], fromPf: true }); };
  // the number printed on the card (as read) decides between cards with the same name
  const r = it.read || {}, a = it.ai || {}, rn = new Set([r.n, a.number].filter(Boolean).map((n) => mNum(String(n).split("/")[0])).filter(Boolean));
  const rnm = new Set([r.name, a.name_english].filter(Boolean).map(mName).filter(Boolean));
  // how well a match fits what was read: the number counts most, then the name
  const fit = (i) => (rn.size && rn.has(mNum(it.cards[i].number)) ? 2 : 0) + (rnm.size && rnm.has(mName(it.cards[i].name)) ? 1 : 0);
  const full = (rn.size ? 2 : 0) + (rnm.size ? 1 : 0), agree = (i) => fit(i) === full;
  let o = own();
  // nothing the scan matched is in your portfolio, or only cards with a different number: search your portfolio
  // with what was read (name and/or number)
  if (!o.length || !o.some(agree)) for (const x of sqPfSearch(it)) add(x);
  o = own();
  const best = o.reduce((b, i) => (b == null || fit(i) > fit(b) ? i : b), null);
  it.notMine = !o.length;
  if (o.length && (!o.includes(it.pick) || (!it.manual && fit(best) > fit(it.pick)))) { it.pick = best; it.pxK = null; it.err = ""; it.unsure = false; it.sel = true; it.pid = null; it.okPf = false; }
  if (it.notMine) it.sel = false;
  return o;
}
// your portfolio searched with what the scan read (and the scan's own matches): name and number together first,
// then name with a partial number or the set size, then the name alone, then the number with the set size, then the number alone
const SQ_TOK_SKIP = new Set(["ex", "gx", "v", "vmax", "vstar", "the", "of", "and", "lv", "x", "star", "prime", "break", "tag", "team"]);
const sqToks = (s) => mName(s).split(" ").filter((w) => w.length > 2 && !SQ_TOK_SKIP.has(w));
function sqPfSearch(it) {
  const r = it.read || {}, a = it.ai || {};
  // what was read off the card comes first; the scan's own matches are only used for what wasn't read
  // (they can be a different card with the same name, like Pikachu 025/165 for a Pikachu Libre 14/30)
  const scan = it.cards.filter((c) => !c.fromPf), readAny = !!(r.name || a.name_english || a.name || r.n || a.number);
  const names = readAny ? [r.name, a.name_english, a.name].filter(Boolean) : scan.map((c) => c.name);
  const nums = (readAny ? [r.n, a.number].filter(Boolean) : scan.map((c) => c.number)).map((n) => mNum(String(n).split("/")[0])).filter(Boolean);
  const tots = (readAny ? [r.d, a.set_total].filter(Boolean) : scan.map((c) => c.printedTotal).filter(Boolean)).map((n) => mNum(String(n)));
  const nm = new Set(names.map(mName).filter(Boolean)), tk = new Set(names.flatMap(sqToks));
  if (!nm.size && !nums.length) return [];
  const scored = owned(P.items).filter((x) => x.qty > 0).map((x) => {
    const xn = mName(x.name), parts = String(x.num || "").split("/"), xk = mNum(parts[0]), xd = parts[1] ? mNum(parts[1]) : "";
    const exact = nm.has(xn), tok = !exact && sqToks(x.name).some((w) => tk.has(w)), num = !!xk && nums.includes(xk), tot = !!xd && tots.includes(xd);
    const sc = num && exact ? 10 : num && tok ? 8 : exact && tot ? 6 : exact ? 5 : num && tot ? 4 : tok && tot ? 3 : num ? 2 : 0;
    return { x, sc };
  }).filter((y) => y.sc > 0);
  if (!scored.length) return [];
  const top = Math.max(...scored.map((y) => y.sc));
  return scored.filter((y) => y.sc === top).sort((p, q) => q.x.qty - p.x.qty).slice(0, 8).map((y) => y.x);
}
function sqMineHTML(it, c) {
  const mine = sqMine(it, c);
  if (!mine.length) { it.pid = null; return `<div class="sq-mine"><span class="sq-st warn">Not in your portfolio</span><span class="mu">None of the matches for this photo are cards you own. Tap Change to search, or remove it.</span></div>`; }
  const pid = sqMinePick(it, mine);
  const one = new Set(mine.map((x) => x.pf)).size < 2, cp = mine.find((x) => x.id === pid), cpc = sqCopyCond(cp), cur = it.mcond || cpc;
  const csel = `<select class="sq-mcd" data-qf="mcond" data-qid="${it.id}" aria-label="Condition for the trade">${[...CONDS, ...TR_GRADES].map((o) => `<option value="${o}" ${o === cur ? "selected" : ""}>${COND_CODE[o] || o}</option>`).join("")}</select>`;
  return `<div class="sq-mine">${c.fromPf && !it.okPf ? `<span class="sq-st warn sq-chk">Found by searching your portfolio for what was read. Check it's the right card${it.cards.filter((y) => y.fromPf).length > 1 ? " (Change shows the others)" : ""}. <button type="button" class="sq-ok" data-qok="${it.id}">Yes, that's it</button></span>` : ""}<span class="mu">Your copy${mine.length > 1 ? " (tap one)" : ""}:</span>${mine.map((x) => `<button type="button" class="sq-mc" data-qown="${x.id}" data-qid="${it.id}" aria-pressed="${x.id === pid}">${esc(isGraded(x) ? shortGrade(x.grade) : COND_CODE[x.cond] || x.cond || "NM")}${x.var ? " · " + esc(x.var) : ""}${x.pf && !one ? " · " + esc(x.pf) : ""} · ×${x.qty}${x.mkt != null || x.ovr > 0 ? " · " + money(unit(x)) : ""}</button>`).join("")}${sqTarget === "select" ? `<span class="sq-mrow">${csel}</span>` : `<span class="sq-mrow">${csel}<label class="sq-mq">Qty <input data-qf="qty" data-qid="${it.id}" type="number" min="1" step="1" inputmode="numeric" value="${it.qty || 1}" aria-label="Quantity"></label></span>`}</div>`;
}
// the TCGplayer price shown for one of your cards follows the copy you're trading: its condition (or the one
// picked in the dropdown) and its printing
function sqMineSync(it) {
  const c = it.pick >= 0 ? it.cards[it.pick] : null; if (!c) return;
  const mine = sqMine(it, c); if (!mine.length) return;
  const cp = mine.find((x) => x.id === sqMinePick(it, mine)); if (!cp) return;
  const eff = it.mcond || sqCopyCond(cp);
  if (CONDS.includes(eff) && it.cond !== eff) it.cond = eff;
  if (cp.var && it.print !== cp.var) it.print = cp.var;
}
const sqCopyCond = (x) => (!x ? "Near Mint" : isGraded(x) ? shortGrade(x.grade) : x.cond || "Near Mint");
function sqPfs() { return [...new Set(P.items.filter((x) => x.qty > 0 && x.pf).map((x) => x.pf))].sort(); }
function sqRowHTML(it) {
  if (sqOwnMode()) { sqOwnFix(it); sqMineSync(it); }
  const c = it.pick >= 0 ? it.cards[it.pick] : null, a = it.ai;
  const status = it.st === "wait" ? "Waiting…" : it.st === "reading" ? (it.note || "Reading the card…") : it.st === "error" ? it.err : it.err ? it.err : it.unsure ? "Check this match" : "";
  const prints = sqPrints(it, c);
  if (c && !it.print) it.print = prints[0];
  const busy = it.st === "wait" || it.st === "reading";
  return `<div class="sq-r${busy ? " busy" : ""}${it.st === "error" || (it.st === "ready" && !c) ? " bad" : ""}" id="sq-${it.id}">
    <label class="sq-ck"><input type="checkbox" data-qk="${it.id}" ${it.sel ? "checked" : ""} ${c && !(sqOwnMode() && it.notMine) ? "" : "disabled"} aria-label="Select this card"></label>
    <button type="button" class="sq-pics" data-qo="${it.id}" aria-label="Fix or change the match">${it.thumb ? `<img src="${it.thumb}" alt="">` : `<span class="sq-ph"></span>`}${c ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : busy ? `<span class="sq-spin" aria-hidden="true"></span>` : ""}</button>
    <div class="sq-t">
      ${c ? `<b>${esc(c.name)}</b><div class="mu">${esc(c.set || "")} · ${esc(sqNum(c))}${a && a.language && a.language !== "English" ? " · " + esc(a.language) : ""}</div>` : `<b>${busy ? "Scanning…" : "No match yet"}</b>`}
      ${status ? `<div class="sq-st${it.st === "error" || it.err || it.unsure ? " warn" : ""}">${esc(status)}</div>` : ""}
      ${c && it.grade ? `<div class="mu sq-g">Graded: ${esc(it.grade)}</div>` : ""}
      ${sqPriceHTML(it, c)}
      ${sqSalesHTML(it, c)}
    </div>
    <div class="sq-a">${busy ? "" : `<button type="button" class="sq-b" data-qo="${it.id}">${c ? "Change" : "Fix"}</button>`}${c && !busy ? `<button type="button" class="sq-b" data-qc="${it.id}">Comp</button>` : ""}<button type="button" class="sq-x" data-qx="${it.id}" aria-label="Remove from list">✕</button></div>
      ${c && sqOwnMode() ? sqMineHTML(it, c) : c ? `<div class="sq-f">
        <select data-qf="print" data-qid="${it.id}" aria-label="Printing">${prints.map((x) => `<option ${x === it.print ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
        <select data-qf="cond" data-qid="${it.id}" aria-label="Condition">${CONDS.map((x) => `<option value="${x}" ${x === it.cond ? "selected" : ""}>${{ "Near Mint": "NM", "Lightly Played": "LP", "Moderately Played": "MP", "Heavily Played": "HP", Damaged: "DMG" }[x] || x}</option>`).join("")}</select>
        <input data-qf="qty" data-qid="${it.id}" type="number" min="1" step="1" inputmode="numeric" value="${it.qty || 1}" aria-label="Quantity">
      </div>` : ""}
      ${busy || sqOwnMode() ? "" : sqShadowHTML(it, c)}
      ${sqTarget ? "" : sqOfferHTML(it, c)}
  </div>`;
}
// replace just one row, so typing in another box isn't interrupted
// force: redraw even though something in the row has focus (a tapped checkbox), then put focus back on it
function sqRow(it, force) {
  const el = $("sq-" + it.id); if (!el || sqView) return;
  const f = document.activeElement, fsel = force && el.contains(f) && f.dataset && f.dataset.qsh ? `[data-qsh="${it.id}"]` : null;
  if (!force && el.contains(f)) { el.dataset.stale = "1"; return; }
  el.outerHTML = sqRowHTML(it); sqBar();
  if (fsel) { const n = document.querySelector("#ppscan " + fsel); if (n) n.focus({ preventScroll: true }); }
  if (it.pick >= 0 && it.pxK !== sqPxKey(it)) setTimeout(() => sqPrice(it), 0);
}
function sqCount() { const n = scanQ.filter((x) => x.st === "wait" || x.st === "reading").length, el = $("sq-n"); if (el) el.textContent = n ? `${n} still reading` : ""; }
function sqBar() {
  const el = $("sq-bar"); if (!el) return;
  const ready = scanQ.filter((x) => x.pick >= 0), sel = ready.filter((x) => x.sel);
  const selV = sel.reduce((a, x) => a + sqVal(x), 0);
  const selPay = sel.reduce((a, x) => a + (x.pxK === sqPxKey(x) ? sqOfferVal(x) : 0), 0);
  if (sqTarget) { el.querySelector("[data-qa=add]").textContent = sqTarget === "select" ? (sel.length ? `Select ${sel.length} in your portfolio` : "Select in your portfolio") : sqTarget === "tradeGive" ? (sel.length ? `Add ${sel.length} of your cards` : "Add your cards") : sel.length ? `Add ${sel.length} of their cards` : "Add their cards"; const pg = el.querySelector(".pg"); if (pg) pg.style.display = "none"; }
  else el.querySelector("[data-qa=add]").textContent = sel.length ? `Add ${sel.length} card${sel.length === 1 ? "" : "s"} to portfolio${selPay ? " · paying " + money(selPay) : selV ? " · " + money(selV) : ""}` : "Add to portfolio";
  // the whole list's TCGplayer market value, counting quantities
  const tv = $("sq-v");
  if (tv) {
    const total = ready.reduce((a, x) => a + sqVal(x), 0), cards = ready.reduce((a, x) => a + Math.max(1, Math.round(+x.qty || 1)), 0);
    const wait = ready.filter((x) => x.pxK !== sqPxKey(x) || x.px === undefined).length, none = ready.filter((x) => x.pxK === sqPxKey(x) && x.px !== undefined && !(x.px > 0)).length;
    tv.innerHTML = ready.length ? `<span class="mu">${ready.some((x) => x.pxSrc === "own" || x.pxSrc === "collectr") ? "Value" : "TCGplayer market value"}</span> <b>${money(total)}</b> <span class="mu">for ${cards} card${cards === 1 ? "" : "s"}${sel.length && sel.length < ready.length ? ` · selected ${money(selV)}` : ""}${wait ? ` · ${wait} still pricing` : ""}${none ? ` · ${none} without a price` : ""}</span>`
      : "";
  }
  el.querySelector("[data-qa=add]").disabled = !sel.length;
  const ap = el.querySelector("[data-qa=apply]"); if (ap) { const n = sqEdits().length; ap.disabled = !n; ap.textContent = n ? `Apply changes (${n})` : "Apply changes"; }
  sqGroupSync();
  const all = el.querySelector("[data-qa=all]"); if (all) all.textContent = ready.length && sel.length === ready.length ? "Select none" : "Select all";
  const rm = document.querySelector("#ppscan [data-qa=rmsel]"); if (rm) rm.textContent = sel.length ? `Remove ${sel.length} from list` : "Remove from list", rm.disabled = !sel.length;
  sqCount();
}
function sqRender() {
  let ov = $("ppscan"); if (!ov) { ov = document.createElement("div"); ov.id = "ppscan"; ov.className = "ppm-ov"; document.body.appendChild(ov); }
  if (sqView) return sqDetail(ov);
  const pfs = sqPfs(), has = scanQ.length;
  ov.innerHTML = `<div class="ppm sqm" role="dialog" aria-modal="true" aria-labelledby="sc-t">
    <div class="sq-h"><h3 id="sc-t">${sqTarget === "select" ? "Find your cards" : sqTarget === "tradeGive" ? "Scan your cards" : sqTarget === "trade" ? "Scan their cards" : "Scan cards"}</h3><button type="button" class="ppm-x plain sq-close" data-qa="close">Close</button></div>
    <div class="sq-go"><button type="button" class="ppm-x primary" data-qa="cam">📷 Take photos</button><button type="button" class="ppm-x" data-qa="lib">🖼 Choose photos</button></div>
    ${has ? `<div class="sq-top"><span class="mu">${scanQ.length} card${scanQ.length === 1 ? "" : "s"}</span> <span class="mu" id="sq-n"></span><span style="flex:1"></span><button type="button" class="cs-back" data-qa="all">Select all</button></div>
      <div class="sq-top sq-top2"><button type="button" class="cs-back" data-qa="rmsel">Remove from list</button><span style="flex:1"></span><button type="button" class="cs-back sq-dl" data-qa="clear">Clear list</button></div>
      <div class="sq-v" id="sq-v"></div>
      ${sqTarget ? "" : sqGroupHTML()}
      <div class="sq-list">${scanQ.map(sqRowHTML).join("")}</div>
      <form id="sq-bar" class="sq-bar"><div class="pg">${pfField(sqDefaults.pf && (pfs.includes(sqDefaults.pf) || !pfs.length) ? sqDefaults.pf : pfs[0] || "", pfs)}
        <label>Condition for selected<select data-qa="cond"><option value="">Keep each</option>${CONDS.map((x) => `<option>${x}</option>`).join("")}</select></label></div>
        ${sqTarget === "select" ? `<button type="button" class="ppm-x sq-add sq-apply" data-qa="apply" disabled>Apply changes</button>` : ""}<button type="submit" class="ppm-x primary sq-add" data-qa="add">Add to portfolio</button></form>`
    : `<p class="mu" style="margin:10px 0 4px">Take a photo of each card, one after another. You don't have to wait: each card is read while you take the next, and they all collect here for you to check and add together.</p>
      <p class="mu" style="margin:0">Or choose photos you've already taken. You can pick several at once.</p>`}
  </div>`;
  sqBar(); sqPriceAll();
}
function sqDetail(ov) {
  const it = sqItem(sqView); if (!it) { sqView = null; return sqRender(); }
  const own = sqOwnMode() ? sqOwnFix(it) : null;
  const r = it.read || {}, a = it.ai, c = it.pick >= 0 ? it.cards[it.pick] : null;
  const saw = a && a.found !== false ? [a.name_english && a.name && a.name_english !== a.name ? `${a.name} (${a.name_english})` : a.name || a.name_english, a.number && (a.number + (a.set_total ? "/" + a.set_total : "")), a.set_name, a.language && a.language !== "English" ? a.language : "", a.edition && a.edition !== "Unlimited" ? a.edition : "", a.finish && a.finish !== "unknown" ? a.finish : "", a.stamp, it.grade].filter(Boolean).map(esc).join(" · ") : "";
  ov.innerHTML = `<div class="ppm sqm" role="dialog" aria-modal="true" aria-labelledby="sc-t">
    <div class="sq-h"><button type="button" class="cs-back" data-qa="list">‹ Back to list</button></div>
    ${it.thumb ? `<img class="sc-photo" src="${it.thumb}" alt="Your photo">` : ""}
    ${saw ? `<p class="sc-saw"><span class="mu">Read:</span> ${saw}${a._by ? ` <span class="mu">(${esc(String(a._by).split(" ")[0])}${a._secs ? ", " + (+a._secs).toFixed(1) + "s" : ""})</span>` : ""}</p>` : it.aiErr ? `<p class="sc-saw" style="color:var(--dn)">${esc(it.aiErr)}. Used basic text reading instead, which can't tell printings apart.</p>` : ""}
    ${c ? `<div class="ppm-b" style="margin:0 0 12px"><button type="button" class="ppm-x" data-qc="${it.id}">See comps for ${esc(c.name)}</button></div>` : ""}
    ${sqOwnMode() && !own.length ? `<p><b>None of the matches are cards in your portfolio.</b> <span class="mu">Search again below${sqTarget === "tradeGive" ? ", or use “Add from your portfolio” in the trade" : ""}.</span></p>`
      : it.cards.length ? `<p class="mu">${sqOwnMode() ? "Tap your card (only cards in your portfolio):" : "Tap your card:"}</p><div class="sc-grid">${it.cards.map((x, i) => sqOwnMode() && !own.includes(i) ? "" : `<button type="button" data-qp="${i}"${i === it.pick ? ' class="best"' : ""}>${i === it.pick ? `<i class="sc-best">${a && i === 0 ? "Best match" : "Chosen"}</i>` : ""}<img src="${esc(x.image)}" alt="" loading="lazy"><b>${esc(x.name)}</b><span>${esc(x.set || "")} · ${esc(sqNum(x))}</span></button>`).join("")}</div>`
      : `<p><b>${esc(it.err || "No matching cards found.")}</b></p>`}
    <form id="sq-search" class="cimp-c" style="margin-top:12px"><input name="q" value="${esc([r.name, r.n && (r.n + (r.d ? "/" + r.d : ""))].filter(Boolean).join(" "))}" placeholder="Name and number, e.g. Charizard 4/102" aria-label="Card name and number" style="letter-spacing:0;text-transform:none"><button type="submit" class="ppm-x">Search</button></form>
    <div class="ppm-b"><button type="button" class="ppm-x plain" data-qa="list">Back to list</button></div>
  </div>`;
}
function sqToItem(it, pf) {
  const c = it.cards[it.pick];
  return { id: uid(), pf, cat: "Pokemon", set: c.set || "", name: c.name, num: /^\d+$/.test(c.number) && c.printedTotal ? `${c.number}/${c.printedTotal}` : c.number, rarity: c.rarity || "",
    var: it.print || "", grade: (it.grade || "").trim() || "Ungraded", cond: it.cond || "Near Mint", qty: Math.max(1, Math.round(+it.qty || 1)), cost: it.pxK === sqPxKey(it) ? sqOffer(it) : 0, mkt: null, ovr: 0, watch: false, added: today(), notes: "",
    img: c.image, big: c.big, imgT: Date.now(), tcgId: c.tcgId || undefined,
    // the TCGplayer price already looked up while scanning, so the portfolio shows it right away
    ...(!it.grade && c.tcgId && it.pxK === sqPxKey(it) && it.px > 0 ? { mkt: it.px, mktEst: !!it.pxEst, mktV: 2, pT: Date.now() } : {}) };
}
let sqTarget = null; // "trade" / "tradeGive" when the scanner was opened from the trade analyzer (their cards / your cards); "select" to select cards in the portfolio
// condition changes made while finding your cards, saved to those copies in the portfolio
function sqEdits() { return scanQ.filter((it) => it.pick >= 0 && it.pid && it.mcond && P.items.some((x) => x.id === it.pid && sqCopyCond(x) !== it.mcond)); }
function sqApplyEdits() {
  const list = sqEdits(); if (!list.length) return;
  selBackup("bulk edit");
  for (const it of list) { const x = P.items.find((y) => y.id === it.pid); if (!x) continue;
    if (TR_GRADES.includes(it.mcond)) x.grade = it.mcond; else { x.cond = it.mcond; x.grade = "Ungraded"; }
    delete x.mktLive; delete x.pWhy; delete x.pTry;
    if (!isGraded(x) && it.pxK === sqPxKey(it) && it.px > 0 && !(x.ovr > 0)) { x.mkt = it.px; x.mktEst = !!it.pxEst; x.mktV = 2; x.pT = Date.now(); } else { delete x.pT; if (!isGraded(x)) x.mktV = 1; }
    it.mcond = null; it.pxK = null; }
  store(); snap(); render(); fillPrices(); sqRender();
  toast(`Saved the condition of ${list.length} card${list.length === 1 ? "" : "s"}`, { label: "Undo", run: () => { undoImport(); if ($("ppscan")) sqRender(); } });
}
function sqOwnMode() { return sqTarget === "tradeGive" || sqTarget === "select"; }
function sqAddSelected(fm) {
  if (sqTarget === "select") {
    const pick = scanQ.filter((x) => x.sel && x.pick >= 0 && sqMine(x, x.cards[x.pick]).length); if (!pick.length) return;
    for (const it of pick) { const mine = sqMine(it, it.cards[it.pick]), id = sqMinePick(it, mine); if (id) selIds.add(id); }
    scanQ = scanQ.filter((x) => !pick.includes(x)); sqSave(); sqTarget = null;
    const ov = $("ppscan"); if (ov) ov.remove(); tradeOpen = false; detail = null; selMode = false; selStart(); toast(`Selected ${pick.length} card${pick.length === 1 ? "" : "s"}`); return;
  }
  if (sqTarget === "tradeGive") {
    const pick = scanQ.filter((x) => x.sel && x.pick >= 0 && sqMine(x, x.cards[x.pick]).length); if (!pick.length) return;
    let short = 0;
    for (const it of pick) { const c = it.cards[it.pick], want = Math.max(1, Math.round(+it.qty || 1)), mine = sqMine(it, c), x = mine.length ? P.items.find((y) => y.id === sqMinePick(it, mine)) : null;
      if (x) { const mc = it.mcond && it.mcond !== sqCopyCond(x) ? it.mcond : null, gr = mc ? (TR_GRADES.includes(mc) ? mc : "") : isGraded(x) ? x.grade : "", cd = mc && !gr ? mc : x.cond;
        const have = TRD.give.find((t) => t.pid === x.id && (t.grade ? shortGrade(t.grade) : t.cond) === (gr ? shortGrade(gr) : cd)), now = have ? have.qty : 0, q = Math.min(x.qty, now + want); if (now + want > x.qty) short++;
        if (have) have.qty = q; else TRD.give.push(trCard({ ...x, pid: x.id, qty: q, max: x.qty, grade: gr, cond: cd }, "give")); }
    }
    scanQ = scanQ.filter((x) => !pick.includes(x)); sqSave(); trSave(); sqTarget = null;
    const ov = $("ppscan"); if (ov) ov.remove(); tradeOpen = true; render();
    toast(`Added ${pick.length} of your card${pick.length === 1 ? "" : "s"} to the trade${short ? ` (${short} capped at what you own)` : ""}`); return;
  }
  if (sqTarget === "trade") {
    const pick = scanQ.filter((x) => x.sel && x.pick >= 0); if (!pick.length) return;
    for (const it of pick) { const c = it.cards[it.pick], priced = it.pxK === sqPxKey(it) && it.px > 0 && !it.grade;
      TRD.get.push(trCard({ name: c.name, set: c.set, num: sqNum(c), var: it.print || "", cond: it.cond || "Near Mint", grade: it.grade || "", img: c.image, tcgId: c.tcgId, qty: Math.max(1, Math.round(+it.qty || 1)), px: priced ? it.px : null }, "get")); }
    scanQ = scanQ.filter((x) => !pick.includes(x)); sqSave(); trSave(); sqTarget = null;
    const ov = $("ppscan"); if (ov) ov.remove(); tradeOpen = true; render(); toast(`Added ${pick.length} card${pick.length === 1 ? "" : "s"} to the trade`); return;
  }
  const d = Object.fromEntries(new FormData(fm));
  if (d.pf === "__new") { d.pf = String(d.pfNew || "").trim(); if (!d.pf) { toast("Type a name for the new portfolio"); const i = fm.querySelector('[name="pfNew"]'); if (i) i.focus(); return; } }
  const pf = String(d.pf || "").trim(), pick = scanQ.filter((x) => x.sel && x.pick >= 0); if (!pick.length) return;
  let cards = 0;
  let paid = 0;
  for (const it of pick) {
    const x = sqToItem(it, pf); paid += x.cost * x.qty; cards += x.qty;
    // the offer is what you paid each: copies already in the portfolio average with it by quantity. If those copies have
    // no cost recorded (or these have none), they stay separate entries so neither gets a cost it didn't have.
    const same = P.items.find((y) => y.qty > 0 && keyOf(y) === keyOf(x) && (y.cost > 0) === (x.cost > 0));
    if (same) { if (x.cost > 0) same.cost = Math.round(((same.cost * same.qty + x.cost * x.qty) / (same.qty + x.qty)) * 100) / 100; same.qty += x.qty; }
    else P.items.push(x);
  }
  scanQ = scanQ.filter((x) => !pick.includes(x)); sqDefaults.pf = pf; sqSave(); store(); snap(); render(); fillPrices();
  toast(`Added ${cards} card${cards === 1 ? "" : "s"} to ${pf || "your portfolio"}${paid > 0 ? `, ${money(paid)} paid` : ""}`); sqRender();
}

// --- live camera: keeps the camera open so you can shoot card after card ---
let sqStream = null;
async function sqCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return sqPicker(true);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
  catch (e) { if (e && e.name === "NotAllowedError") toast("Camera access was blocked, so the regular camera opens instead. Allow camera access for this site in Settings to shoot cards back to back."); return sqPicker(true); }
  sqStream = stream;
  const cv = document.createElement("div"); cv.id = "ppcam"; cv.className = "sq-cam";
  cv.innerHTML = `<video playsinline muted autoplay></video><div class="sq-guide" aria-hidden="true"></div><div class="sq-flash"></div>
    <div class="sq-camtop"><span id="sq-camn">Line up a card and tap the button</span></div>
    <div class="sq-cambar"><button type="button" class="sq-camdone" data-qc="done">Done</button><button type="button" class="sq-shut" data-qc="shot" aria-label="Take photo"></button><button type="button" class="sq-camlast" data-qc="done" aria-label="See list"><img alt=""><i></i></button></div>`;
  document.body.appendChild(cv);
  const v = cv.querySelector("video"); v.srcObject = stream; v.play().catch(() => {});
  sqCamInfo();
}
function sqCamInfo() {
  const cv = $("ppcam"); if (!cv) return;
  const n = scanQ.filter((x) => x.st === "wait" || x.st === "reading").length, last = scanQ[scanQ.length - 1];
  cv.querySelector("#sq-camn").textContent = scanQ.length ? `${scanQ.length} in list${n ? ` · ${n} reading` : ""}` : "Line up a card and tap the button";
  const b = cv.querySelector(".sq-camlast"); if (last && last.thumb) { b.querySelector("img").src = last.thumb; b.querySelector("i").textContent = scanQ.length; b.classList.add("on"); }
}
function sqShot() {
  const cv = $("ppcam"), v = cv && cv.querySelector("video"); if (!v || !v.videoWidth) return;
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
  const fl = cv.querySelector(".sq-flash"); fl.classList.remove("go"); void fl.offsetWidth; fl.classList.add("go");
  if (navigator.vibrate) navigator.vibrate(30);
  c.toBlob((b) => { if (b) sqAdd([b]).then(sqCamInfo); }, "image/jpeg", 0.92);
}
function sqCamClose() { if (sqStream) { sqStream.getTracks().forEach((t) => t.stop()); sqStream = null; } const cv = $("ppcam"); if (cv) cv.remove(); sqRender(); }
// the phone's own camera or photo library (several photos at once)
function sqPicker(camera) {
  const id = camera ? "pfcam" : "pflib"; let i = $(id);
  if (!i) { i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.id = id; i.hidden = true; if (camera) i.setAttribute("capture", "environment"); else i.multiple = true; document.body.appendChild(i);
    i.addEventListener("change", () => { const f = [...i.files]; i.value = ""; if (f.length) { sqAdd(f); if (camera) setTimeout(() => toast("Tap Take photos again for the next card"), 400); } }); }
  i.click();
}

document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("#camb")) { sqTarget = null; sqOpen(); return; }
  const cam = $("ppcam");
  if (cam && cam.contains(e.target)) { const q = e.target.closest("[data-qc]")?.dataset.qc; if (q === "shot") sqShot(); else if (q === "done") sqCamClose(); return; }
  const ov = $("ppscan"); if (!ov || !ov.contains(e.target)) return;
  if (e.target === ov) { ov.remove(); return; }
  const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
  if (d.qa === "close") ov.remove();
  else if (d.qa === "apply") sqApplyEdits();
  else if (d.qa === "cam") sqCamera();
  else if (d.qa === "lib") sqPicker(false);
  else if (d.qa === "list") { sqView = null; sqRender(); }
  else if (d.qa === "all") { const ready = scanQ.filter((x) => x.pick >= 0 && !(sqOwnMode() && x.notMine)), on = !(ready.length && ready.every((x) => x.sel)); ready.forEach((x) => (x.sel = on)); ov.querySelectorAll("[data-qk]").forEach((k) => { if (!k.disabled) k.checked = on; }); sqSave(); sqBar(); }
  else if (d.qa === "rmsel") { const n = scanQ.filter((x) => x.sel && x.pick >= 0).length; if (!n) return;
    modal({ title: `Remove ${n} card${n === 1 ? "" : "s"} from the list?`, text: "They won't be added to your portfolio.", buttons: [{ label: "Remove", kind: "danger", value: 1 }, { label: "Cancel", kind: "plain" }] })
      .then((v) => { if (v) { scanQ = scanQ.filter((x) => !(x.sel && x.pick >= 0)); sqSave(); sqRender(); } }); }
  else if (d.qa === "clear") modal({ title: "Clear the whole list?", text: "Cards you haven't added to your portfolio will be removed from this list.", buttons: [{ label: "Clear list", kind: "danger", value: 1 }, { label: "Cancel", kind: "plain" }] })
    .then((v) => { if (v) { scanQ = scanQ.filter((x) => x.st === "wait" || x.st === "reading"); sqSave(); sqRender(); } });
  else if (d.qo) { sqView = d.qo; sqRender(); ov.querySelector(".ppm").scrollTop = 0; }
  else if (d.qc) sqComp(d.qc);
  else if (d.qok) { const it = sqItem(d.qok); if (it) { it.okPf = true; sqSave(); const n = ov.querySelector(`#sq-${it.id} .sq-chk`); if (n) n.remove(); } }
  else if (d.qown) { const it = sqItem(d.qid); if (it) { it.pid = d.qown; it.mcond = null; it.okPf = true; sqSave(); sqRow(it, true); ov.querySelectorAll(`[data-qown][data-qid="${it.id}"]`).forEach((m) => m.setAttribute("aria-pressed", String(m.dataset.qown === d.qown))); } }
  else if (d.qgpp) { sqGroupSetPct(+d.qgpp); sqSave(); }
  else if (d.qpp) { const it = sqItem(d.qid); if (it) { sqSetPct(it, +d.qpp); sqSave(); } }
  else if (d.qx) { scanQ = scanQ.filter((x) => x.id !== d.qx); sqPhotos.delete(d.qx); sqSave(); const el = $("sq-" + d.qx); if (el) el.remove(); if (!scanQ.length) sqRender(); else sqBar(); }
  else if (d.qp != null) { const it = sqItem(sqView); if (it) { it.pick = +d.qp; it.manual = true; it.okPf = true; it.pid = null; it.unsure = false; it.err = ""; it.sel = true; sqSave(); } sqView = null; sqRender(); }
  else if (d.qa === "comps") { const it = sqItem(sqView), c = it && it.cards[it.pick]; if (!c) return; ov.remove(); syncScrollLock();
    $("q").value = `${c.name} ${/^\d+$/.test(c.number) && c.printedTotal ? c.number + "/" + c.printedTotal : c.number}`;
    const t = $("tb").querySelector('[data-t="ebay"]'); if (t && tab !== "ebay") t.click(); tcgQ = ""; load(); scrollTo({ top: 0, behavior: "smooth" }); }
});
document.addEventListener("change", (e) => {
  const t = e.target; if (!t.closest || !t.closest("#ppscan")) return;
  if (t.dataset.qk) { const it = sqItem(t.dataset.qk); if (it) it.sel = t.checked; sqSave(); sqBar(); }
  else if (t.dataset.qf === "mcond") { const it = sqItem(t.dataset.qid); if (!it) return; const c = it.cards[it.pick], mine = c ? sqMine(it, c) : [];
    // the selected copy stays selected (a 1st Edition card doesn't turn into your Unlimited one): only another copy of
    // the same printing that's already in that condition is used instead; otherwise your copy is priced in that condition
    const cur = mine.find((x) => x.id === it.pid), m = cur && mine.find((x) => sqCopyCond(x) === t.value && mVar(x.var) === mVar(cur.var) && String(x.tcgId || "") === String(cur.tcgId || ""));
    if (sqTarget === "select") it.mcond = cur && sqCopyCond(cur) === t.value ? null : t.value; // editing this copy: no switching
    else if (m) { it.pid = m.id; it.mcond = null; } else it.mcond = t.value;
    it.okPf = true; sqSave(); sqRow(it, true); }
  else if (t.dataset.qf) { const it = sqItem(t.dataset.qid); if (!it) return; if (t.dataset.qf === "qty") it.qty = Math.max(1, Math.round(+t.value || 1)); else it[t.dataset.qf] = t.value; sqSave();
    if (t.dataset.qf !== "qty") sqPrice(it); sqRow(it); }
  else if (t.dataset.qa === "cond" && t.value) { for (const it of scanQ) if (it.sel && it.pick >= 0) it.cond = t.value; sqSave();
    document.querySelectorAll("#ppscan select[data-qf=cond]").forEach((s) => { const it = sqItem(s.dataset.qid); if (it && it.sel) s.value = it.cond; }); toast(`Set ${t.value} for the selected cards`); t.value = ""; sqPriceAll(); for (const it of scanQ) if (it.sel && it.pick >= 0) sqRow(it); sqBar(); }
});
// a row that changed while you were typing in it is redrawn once you leave it
document.addEventListener("focusout", (e) => { const r = e.target.closest && e.target.closest(".sq-r[data-stale]"); if (r) setTimeout(() => { if (!r.contains(document.activeElement)) { const it = sqItem(r.id.slice(3)); if (it) { delete r.dataset.stale; sqRow(it); } } }, 0); });
document.addEventListener("submit", (e) => {
  if (e.target.id === "sq-search") { e.preventDefault(); const it = sqItem(sqView); if (!it) return;
    const q = new FormData(e.target).get("q") || "", r = parseCardText(q);
    if (!r.n) { const m = /\b([A-Z]{0,4}\d{1,3}[a-z]?)\b\s*$/.exec(q.trim()); if (m) r.n = m[1]; }
    r.name = q.replace(/\b[A-Z]{0,4}\d{1,3}[a-z]?\s*\/\s*[A-Z]{0,4}\d{1,3}\b/, "").replace(/\b[A-Z]{0,4}\d{1,3}[a-z]?\b\s*$/, "").trim() || r.name;
    const btn = e.target.querySelector("button"); btn.textContent = "Searching…"; btn.disabled = true;
    it.ai = it.ai ? { ...it.ai, _by: "" } : null;
    sqFind(it, r).then(() => { it.unsure = false; sqSave(); if (sqView === it.id) sqRender(); }); }
  else if (e.target.id === "sq-bar") { e.preventDefault(); sqAddSelected(e.target); }
});

/* ---------- actions ---------- */
function exportCSV() {
  const c = (v) => { v = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const rows = [["Portfolio Name", "Category", "Set", "Product Name", "Card Number", "Rarity", "Variance", "Grade", "Card Condition", "Average Cost Paid", "Quantity", `Market Price (As of ${P.asOf || today()})`, "Price Override", "Watchlist", "Date Added", "Notes"]];
  for (const x of P.items) rows.push([x.pf, x.cat, x.set, x.name, x.num, x.rarity, x.var, x.grade, x.cond, x.qty ? x.cost : "", x.qty || "", x.mkt ?? "", x.ovr || 0, x.watch, x.added, x.notes]);
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(c).join(",")).join("\n")], { type: "text/csv" }));
  a.download = "price-plot-portfolio-" + today() + ".csv"; document.body.appendChild(a); a.click(); a.remove();
}
// The Comp button: TCGplayer is the market standard, so raw cards open the TCGplayer tab on their condition and printing
// (the eBay search waits until the eBay tab is opened). Graded cards open eBay on their grade, since TCGplayer has no graded sales.
function comp(x) {
  const name = ebName(x.name), num = ebNum(x.num), gi = gradeOf(x);
  if (gi) {
    $("q").value = [name, num, shortGrade(x.grade)].filter(Boolean).join(" "); ppEbayFilter(shortGrade(x.grade)); tcgQ = "";
    const b = $("tb").querySelector('[data-t="ebay"]'); if (b && tab !== "ebay") b.click(); else load(); // opening the tab runs the search
  } else {
    $("q").value = [name, num].filter(Boolean).join(" "); ppTcgFilter(x.cond || "Near Mint", x.var, x.tcgId, x.set); tcgQ = "";
    const b = $("tb").querySelector('[data-t="tcg"]'); if (b && tab !== "tcg") b.click(); else loadTcg();
  }
  scrollTo({ top: 0, behavior: "smooth" });
}
function saveForm(fm) {
  const d = Object.fromEntries(new FormData(fm)), id = fm.dataset.fid, old = P.items.find((x) => x.id === id);
  if (d.pf === "__new") { d.pf = String(d.pfNew || "").trim(); if (!d.pf) { toast("Type a name for the new portfolio"); const i = fm.querySelector('[name="pfNew"]'); if (i) i.focus(); return; } } delete d.pfNew;
  const x = { ...(old || { id: uid(), cat: "Pokemon", rarity: "", mkt: null, watch: false, added: today() }),
    name: d.name.trim(), set: d.set.trim(), num: d.num.trim(), var: d.var.trim(), cond: d.cond, grade: d.grade.trim() || "Ungraded",
    qty: Math.max(0, Math.round(num(d.qty) ?? 1)), cost: num(d.cost) || 0, ovr: num(d.ovr) || 0, pf: d.pf.trim(), notes: d.notes.trim() };
  if (!x.name) return;
  if (old && (old.name !== x.name || old.set !== x.set || old.num !== x.num)) { x.img = undefined; x.imgT = 0; delete x.tcgId; x.mktV = 0; x.pTry = 0; }
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
/* ---------- selecting several cards: press and hold a card, then tap others; edit or remove them together ---------- */
function selBarHTML() {
  const n = selIds.size, shownN = filtered().length, cards = P.items.filter((x) => selIds.has(x.id)).reduce((a, x) => a + (x.qty || 0), 0);
  return `<div class="pfsel-t"><b>${n} selected</b>${n ? ` <span class="mu">${cards} card${cards === 1 ? "" : "s"}</span>` : ""}<span style="flex:1"></span>
    <button type="button" class="cs-back" data-ps="all">${shownN && filtered().every((x) => selIds.has(x.id)) ? "Select none" : `Select all ${shownN.toLocaleString()}`}</button><button type="button" class="cs-back" data-ps="done">Done</button></div>
    <div class="pfsel-b"><button class="pill" type="button" data-ps="scan">📷 Scan</button><button class="pill on" type="button" data-ps="edit" ${n ? "" : "disabled"}>Edit ${n || ""}</button><button class="pill dl" type="button" data-ps="rm" ${n ? "" : "disabled"}>Remove</button></div>`;
}
// update the checkmarks and the bar without redrawing the page
function selSync() {
  document.querySelectorAll("#pf .pr[data-id]").forEach((r) => { const on = selIds.has(r.dataset.id); r.classList.toggle("sel", selMode && on); const k = r.querySelector(".pr-ck"); if (k) k.setAttribute("aria-checked", String(on)); });
  const b = $("pfsel"); if (b) b.innerHTML = selBarHTML();
}
// redraw the portfolio while keeping a card at the same spot on screen (the one under your finger), so the page doesn't jump
function pfKeep(id, draw) {
  const at = (k) => k && document.querySelector(`#pf .pr[data-id="${CSS.escape(k)}"]`);
  let r = at(id);
  if (!r) r = [...document.querySelectorAll("#pf .pr[data-id]")].find((x) => x.getBoundingClientRect().bottom > 0);
  const k = r && r.dataset.id, y0 = r ? r.getBoundingClientRect().top : null;
  draw();
  const r2 = at(k); if (r2 && y0 != null) { const dy = r2.getBoundingClientRect().top - y0; if (Math.abs(dy) > 0.5) scrollBy(0, dy); }
}
function selStart(id) { const was = selMode; selMode = true; if (id) selIds.add(id); editing = null; closeSwipes(); if (!was) pfKeep(id, render); else selSync(); }
function selEnd() { selMode = false; selIds.clear(); pfKeep(null, render); }
function selToggle(id) { if (selIds.has(id)) selIds.delete(id); else selIds.add(id); selSync(); }
// press and hold
let lp = null;
document.addEventListener("pointerdown", (e) => {
  const c = e.target.closest && e.target.closest("#pf .prc"); if (!c || e.button > 0 || e.target.closest("button,a,input,select,label")) return;
  const row = c.closest(".pr[data-id]"); if (!row || editing === row.dataset.id) return;
  clearTimeout(lp && lp.t);
  lp = { id: e.pointerId, x: e.clientX, y: e.clientY, row, t: setTimeout(() => {
    if (!lp || swFingers.size > 1 || (sw && sw.on)) return; const id = lp.row.dataset.id; lp = null; sw = null;
    selJust = Date.now(); selJustId = id; try { navigator.vibrate && navigator.vibrate(15); } catch {}
    if (selMode) selToggle(id); else selStart(id);
  }, 450) };
});
const lpOff = (e) => { if (lp && (!e || e.pointerId === lp.id)) { clearTimeout(lp.t); lp = null; } };
document.addEventListener("pointermove", (e) => { if (lp && e.pointerId === lp.id && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) lpOff(e); });
document.addEventListener("pointerup", lpOff); document.addEventListener("pointercancel", lpOff);
document.addEventListener("contextmenu", (e) => { if (e.target.closest && e.target.closest("#pf .prc")) e.preventDefault(); });
// a copy of the portfolio from just before a change made to many cards at once, for Undo
function selBackup(what) { try { localStorage.setItem(UNDO_KEY, JSON.stringify({ at: Date.now(), source: what, P })); } catch {} }
async function selRemove() {
  const pick = P.items.filter((x) => selIds.has(x.id)); if (!pick.length) return;
  const ok = await modal({ title: `Remove ${pick.length} item${pick.length === 1 ? "" : "s"} from your portfolio?`, text: esc(pick.slice(0, 5).map((x) => x.name).join(", ") + (pick.length > 5 ? ` and ${pick.length - 5} more` : "")), buttons: [{ label: "Remove", value: true, kind: "danger" }, { label: "Keep", value: false, kind: "primary" }] });
  if (!ok) return;
  selBackup("bulk remove"); P.items = P.items.filter((x) => !selIds.has(x.id)); store(); snap(); selMode = false; selIds.clear(); render();
  toast(`Removed ${pick.length} item${pick.length === 1 ? "" : "s"}`, { label: "Undo", run: undoImport });
}
/* ---------- the edit window for the selected cards: each card edited on its own as you scroll, with the total value
   kept up to date, and an optional "Set the same for all". Nothing is saved until Apply changes. ---------- */
let ED = null; // { ids, d: Map(id -> draft fields), px: Map(key -> price | null | undefined) }
const edGr = (d) => (d.grade && !/^ungraded$/i.test(d.grade) ? shortGrade(d.grade) : "");
const edKey = (x, d) => [x.tcgId || "", d.cond || "Near Mint", d.var || "", edGr(d)].join("|");
const edChanged = (x, d) => ["cond", "var", "pf", "notes"].some((k) => (d[k] || "") !== (x[k] || "")) || edGr(d) !== (isGraded(x) ? shortGrade(x.grade) : "") || +d.qty !== +x.qty || +(d.cost || 0) !== +(x.cost || 0);
// the price each for a card as edited: its own price while condition, printing and grade are unchanged
function edPrice(x, d) {
  if (x.ovr > 0) return x.ovr;
  const same = (d.cond || "") === (x.cond || "") && (d.var || "") === (x.var || "") && edGr(d) === (isGraded(x) ? shortGrade(x.grade) : "");
  if (same) return x.mkt != null ? x.mkt : null;
  if (edGr(d)) return P.items.find((y) => y !== x && y.mkt != null && isGraded(y) && shortGrade(y.grade) === edGr(d) && mName(y.name) === mName(x.name) && mNum(y.num) === mNum(x.num))?.mkt ?? null;
  return ED.px.get(edKey(x, d));
}
async function edLookup(x, d) {
  const k = edKey(x, d); if (edGr(d) || !x.tcgId || ED.px.has(k)) return;
  ED.px.set(k, undefined);
  try { const j = await getJSON("/api/tcgprice?" + new URLSearchParams({ id: x.tcgId, cond: d.cond || "Near Mint", print: d.var || "", jp: isJp(x) ? "1" : "" })); ED.px.set(k, j.market > 0 ? j.market : null); }
  catch { ED.px.set(k, null); }
  if (ED) { for (const id of ED.ids) { const y = P.items.find((z) => z.id === id), e = ED.d.get(id); if (y && e && edKey(y, e) === k) edRowPrice(y); } edTotal(); }
}
function edPriceHTML(x, d) {
  const px = edPrice(x, d), q = Math.max(0, Math.round(+d.qty || 0)), changed = px !== undefined && !((d.cond || "") === (x.cond || "") && (d.var || "") === (x.var || "") && edGr(d) === (isGraded(x) ? shortGrade(x.grade) : ""));
  if (px === undefined) return `<span class="mu">Looking up the price…</span>`;
  if (px == null) return `<span class="mu">${edGr(d) ? "No price for that grade yet (Collectr's is used once saved, if you have it)" : "No price yet"}</span>`;
  return `<span class="mu">${x.ovr > 0 ? "Your price" : edGr(d) ? "Collectr" : "TCGplayer"}</span> <b>${money(px)}</b>${q !== 1 ? ` <span class="mu">× ${q} = ${money(px * q)}</span>` : ""}${changed ? ` <span class="ed-new">new</span>` : ""}`;
}
function edRowHTML(x) {
  const d = ED.d.get(x.id), g = edGr(d), cur = g || d.cond || "Near Mint", mk = edPrice(x, d);
  const conds = [...CONDS, ...(d.cond === "Sealed" ? ["Sealed"] : []), ...TR_GRADES, ...(g && !TR_GRADES.includes(g) ? [g] : [])];
  const prints = printsCache.get(String(x.tcgId)) || (x.tcgId ? (d.var ? [d.var] : []) : PRINTS_ANY);
  const pfs = [...new Set(P.items.map((y) => y.pf).filter(Boolean))].sort();
  const pc = mk > 0 && d.cost > 0 ? String(Math.round((d.cost / mk) * 1000) / 10) : "";
  return `<div class="ed-r${edChanged(x, d) ? " chg" : ""}" id="ed-${x.id}">
    <button type="button" class="ed-pic" data-ezm="${x.id}" aria-label="Enlarge picture" ${x.img ? "" : "disabled"}>${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy">` : ""}</button>
    <div class="ed-t"><b>${esc(x.name)}</b><div class="mu">${esc([x.set, x.num].filter(Boolean).join(" · "))}</div><div class="ed-p" data-epx="${x.id}">${edPriceHTML(x, d)}</div></div>
    <button type="button" class="sq-x" data-edrop="${x.id}" aria-label="Take off this list">✕</button>
    <div class="ed-f">
      <label><span>Condition</span><select data-ef="cond" data-eid="${x.id}">${conds.map((o) => `<option value="${esc(o)}" ${o === cur ? "selected" : ""}>${esc(COND_CODE[o] || o)}</option>`).join("")}</select></label>
      <label><span>Printing</span><select data-ef="var" data-eid="${x.id}">${printOpts(prints, d.var || "")}</select></label>
      <label><span>Qty</span><input data-ef="qty" data-eid="${x.id}" type="number" min="0" step="1" inputmode="numeric" value="${esc(d.qty)}"></label>
      <label class="ed-cost"><span>Paid each $</span><input data-ef="cost" data-eid="${x.id}" type="number" min="0" step="any" inputmode="decimal" value="${d.cost > 0 ? d.cost : ""}"></label>
      <label class="ed-pc"><span>%</span><input data-ef="pct" data-eid="${x.id}" type="number" min="0" step="any" inputmode="decimal" value="${pc}" ${mk > 0 ? "" : "disabled placeholder=\"–\""}></label>
      <label class="ed-pf"><span>Portfolio</span><select data-ef="pf" data-eid="${x.id}">${[...new Set([...pfs, d.pf].filter(Boolean))].map((p) => `<option ${p === d.pf ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
    </div></div>`;
}
function edRowPrice(x) {
  const el = document.querySelector(`#pfed [data-epx="${x.id}"]`), d = ED.d.get(x.id); if (!el || !d) return;
  el.innerHTML = edPriceHTML(x, d);
  const mk = edPrice(x, d), pc = document.querySelector(`#pfed [data-ef="pct"][data-eid="${x.id}"]`);
  if (pc && document.activeElement !== pc) { pc.disabled = !(mk > 0); pc.placeholder = mk > 0 ? "" : "–"; pc.value = mk > 0 && d.cost > 0 ? String(Math.round((d.cost / mk) * 1000) / 10) : ""; }
  const r = $("ed-" + x.id); if (r) r.classList.toggle("chg", edChanged(x, d));
}
function edTotal() {
  if (!ED) return; const el = $("ed-v"); if (!el) return;
  let v = 0, cards = 0, none = 0, wait = 0, chg = 0;
  for (const id of ED.ids) { const x = P.items.find((y) => y.id === id), d = ED.d.get(id); if (!x || !d) continue;
    const q = Math.max(0, Math.round(+d.qty || 0)), px = edPrice(x, d); cards += q; if (px === undefined) wait++; else if (px == null) none++; else v += px * q; if (edChanged(x, d)) chg++; }
  el.innerHTML = `<span class="mu">Market value</span> <b>${money(v)}</b> <span class="mu">for ${cards} card${cards === 1 ? "" : "s"}${wait ? ` · ${wait} pricing` : ""}${none ? ` · ${none} without a price` : ""}</span>`;
  const b = document.querySelector("#pfed [data-ea=apply]"); if (b) { b.disabled = !chg; b.textContent = chg ? `Apply changes (${chg} card${chg === 1 ? "" : "s"})` : "Apply changes"; }
}
function edOpen() {
  const ids = P.items.filter((x) => selIds.has(x.id)).map((x) => x.id); if (!ids.length) return;
  ED = { ids, d: new Map(), px: new Map() };
  for (const id of ids) { const x = P.items.find((y) => y.id === id); ED.d.set(id, { cond: x.cond || "Near Mint", var: x.var || "", grade: isGraded(x) ? x.grade : "", qty: x.qty, cost: x.cost || 0, pf: x.pf || "", notes: x.notes || "" }); }
  edRender();
  // the printings each card comes in, two at a time
  const todo = ids.map((id) => P.items.find((y) => y.id === id)).filter((x) => x && x.tcgId && !printsCache.get(String(x.tcgId))); let i = 0;
  const next = async () => { const x = todo[i++]; if (!x || !ED) return;
    try { if (!printsCache.get(String(x.tcgId))) printsCache.set(String(x.tcgId), (await getJSON("/api/tcgprints?id=" + encodeURIComponent(x.tcgId))).prints || []); } catch {}
    const list = printsCache.get(String(x.tcgId)); const sel = document.querySelector(`#pfed [data-ef="var"][data-eid="${x.id}"]`);
    if (sel && list && list.length && ED) sel.innerHTML = printOpts(list, ED.d.get(x.id).var || ""); next(); };
  next(); next();
}
function edRender() {
  let ov = $("pfed"); if (!ov) { ov = document.createElement("div"); ov.id = "pfed"; ov.className = "ppm-ov"; document.body.appendChild(ov); }
  const items = ED.ids.map((id) => P.items.find((y) => y.id === id)).filter(Boolean), pfs = [...new Set(P.items.map((y) => y.pf).filter(Boolean))].sort();
  const keep = `<option value="">Keep each</option>`, opt = (v, l) => `<option value="${esc(v)}">${esc(l ?? v)}</option>`;
  ov.innerHTML = `<div class="ppm sqm" role="dialog" aria-modal="true" aria-labelledby="ed-h">
    <div class="sq-h"><h3 id="ed-h">Edit ${items.length} card${items.length === 1 ? "" : "s"}</h3><button type="button" class="ppm-x plain sq-close" data-ea="close">Close</button></div>
    <div class="sq-v" id="ed-v"></div>
    <details class="sq-o ed-all"${ED.allOpen ? " open" : ""}><summary class="sq-os"><b>Set the same for all</b> <span class="mu">optional</span></summary>
      <div class="ed-af">
        <label><span>Condition</span><select data-ea2="cond">${keep}${[...CONDS, ...TR_GRADES].map((c) => opt(c, COND_CODE[c] ? c : c)).join("")}</select></label>
        <label><span>Printing</span><select data-ea2="var">${keep}${PRINTS_ANY.map((c) => opt(c)).join("")}</select></label>
        <label><span>Portfolio</span><select data-ea2="pf">${keep}${pfs.map((c) => opt(c)).join("")}<option value="__new">+ New portfolio…</option></select></label>
        <label data-ea2for="pf" hidden><span>New portfolio name</span><input data-ea2="pfNew" autocomplete="off" placeholder="e.g. Binder 2"></label>
        <label><span>Paid each</span><select data-ea2="costHow">${keep}${opt("amt", "Set $ each")}${opt("pct", "Set % of market")}${opt("clear", "Clear")}</select></label>
        <label data-ea2for="costHow" hidden><span>Amount</span><input data-ea2="costV" type="number" min="0" step="any" inputmode="decimal"></label>
        <label><span>Quantity</span><select data-ea2="qtyHow">${keep}${opt("set", "Set each to")}</select></label>
        <label data-ea2for="qtyHow" hidden><span>Quantity each</span><input data-ea2="qtyV" type="number" min="0" step="1" inputmode="numeric"></label>
      </div>
      <button type="button" class="pill" data-ea="setall">Set for all ${items.length}</button> <span class="mu ed-hint">Fills these in on every card below; you can still change any card after.</span>
    </details>
    <div class="sq-list">${items.map(edRowHTML).join("")}</div>
    <div class="sq-bar ed-bar"><button type="button" class="ppm-x primary sq-add" data-ea="apply" disabled>Apply changes</button></div>
  </div>`;
  edTotal();
  for (const x of items) { const d = ED.d.get(x.id); if (edPrice(x, d) === undefined || (!ED.px.has(edKey(x, d)) && !edGr(d) && edPrice(x, d) == null)) edLookup(x, d); }
}
async function edClose(force) {
  if (!ED) return;
  const chg = ED.ids.filter((id) => { const x = P.items.find((y) => y.id === id); return x && edChanged(x, ED.d.get(id)); }).length;
  if (!force && chg && !(await modal({ title: `Discard changes to ${chg} card${chg === 1 ? "" : "s"}?`, text: "", buttons: [{ label: "Discard", value: true, kind: "danger" }, { label: "Keep editing", value: false, kind: "primary" }] }))) return;
  ED = null; const ov = $("pfed"); if (ov) ov.remove();
}
function edApply() {
  if (!ED) return;
  const chg = ED.ids.map((id) => P.items.find((y) => y.id === id)).filter((x) => x && edChanged(x, ED.d.get(x.id))); if (!chg.length) return;
  selBackup("bulk edit");
  for (const x of chg) {
    const d = ED.d.get(x.id), was = [x.cond, x.var, isGraded(x) ? shortGrade(x.grade) : ""].join("|"), px = edPrice(x, d);
    x.cond = d.cond; x.var = d.var; x.grade = edGr(d) ? d.grade : "Ungraded"; x.qty = Math.max(0, Math.round(+d.qty || 0)); x.cost = Math.round((+d.cost || 0) * 100) / 100; x.pf = d.pf;
    if ([x.cond, x.var, isGraded(x) ? shortGrade(x.grade) : ""].join("|") !== was) {
      delete x.mktLive; delete x.pWhy; delete x.pTry;
      if (px > 0 && !(x.ovr > 0)) { x.mkt = px; x.mktEst = false; x.mktV = isGraded(x) ? x.mktV : 2; x.pT = Date.now(); } else { delete x.pT; if (!isGraded(x)) x.mktV = 1; }
    }
  }
  store(); snap(); ED = null; const ov = $("pfed"); if (ov) ov.remove(); selMode = false; selIds.clear(); render(); fillPrices();
  toast(`Saved changes to ${chg.length} card${chg.length === 1 ? "" : "s"}`, { label: "Undo", run: undoImport });
}
function edSet(id, f, v) {
  const x = P.items.find((y) => y.id === id), d = ED && ED.d.get(id); if (!x || !d) return;
  if (f === "cond") { if (TR_GRADES.includes(v) || (!CONDS.includes(v) && v !== "Sealed" && v)) { d.grade = v; } else { d.cond = v; d.grade = ""; } }
  else if (f === "var") d.var = v; else if (f === "pf") d.pf = v;
  else if (f === "qty") d.qty = Math.max(0, Math.round(+v || 0));
  else if (f === "cost") { d.cost = +v > 0 ? Math.round(+v * 100) / 100 : 0; }
  else if (f === "pct") { const mk = edPrice(x, d); if (mk > 0) { d.cost = v === "" ? 0 : Math.round(mk * +v) / 100; const c = document.querySelector(`#pfed [data-ef="cost"][data-eid="${id}"]`); if (c) c.value = d.cost > 0 ? d.cost.toFixed(2) : ""; } }
  if (f === "cond" || f === "var") edLookup(x, d);
  edRowPrice(x); edTotal();
}
document.addEventListener("input", (e) => { const t = e.target; if (!ED || !t.closest || !t.closest("#pfed") || !t.dataset.ef) return; if (t.tagName !== "SELECT") edSet(t.dataset.eid, t.dataset.ef, t.value); });
document.addEventListener("change", (e) => { const t = e.target; if (!ED || !t.closest || !t.closest("#pfed")) return;
  if (t.dataset.ef) { if (t.tagName === "SELECT") edSet(t.dataset.eid, t.dataset.ef, t.value); return; }
  if (t.dataset.ea2) { const f = document.querySelector(`#pfed [data-ea2for="${t.dataset.ea2}"]`); if (f) { f.hidden = !t.value || t.value === "clear" || (t.dataset.ea2 === "pf" && t.value !== "__new"); if (!f.hidden) { const sp = f.querySelector("span"); if (t.dataset.ea2 === "costHow") sp.textContent = t.value === "pct" ? "Percent of market (%)" : "Amount ($ each)"; f.querySelector("input").focus(); } } }
});
document.addEventListener("click", async (e) => {
  const ov = $("pfed"); if (!ov || !ED || !ov.contains(e.target)) return;
  if (e.target === ov) return edClose();
  const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
  if (d.ea === "close") edClose();
  else if (d.ea === "apply") edApply();
  else if (d.ezm) { const x = P.items.find((y) => y.id === d.ezm); if (x) ppZoom([x.tcgId ? `https://tcgplayer-cdn.tcgplayer.com/product/${x.tcgId}_in_1000x1000.jpg` : "", x.big, x.img], x.name); }
  else if (d.edrop) { ED.ids = ED.ids.filter((id) => id !== d.edrop); ED.d.delete(d.edrop); selIds.delete(d.edrop); selSync(); const r = $("ed-" + d.edrop); if (r) r.remove(); if (!ED.ids.length) return edClose(true); const h = $("ed-h"); if (h) h.textContent = `Edit ${ED.ids.length} card${ED.ids.length === 1 ? "" : "s"}`; edTotal(); }
  else if (d.ea === "setall") {
    const g = (k) => { const el = ov.querySelector(`[data-ea2="${k}"]`); return el ? el.value : ""; };
    let pf = g("pf"); if (pf === "__new") { pf = g("pfNew").trim(); if (!pf) { toast("Type a name for the new portfolio"); return; } }
    const cond = g("cond"), pr = g("var"), costHow = g("costHow"), costV = g("costV"), qtyHow = g("qtyHow"), qtyV = g("qtyV");
    if ((costHow === "amt" || costHow === "pct") && !(costV !== "" && +costV >= 0)) { toast("Type the amount"); return; }
    if (qtyHow && !(qtyV !== "" && +qtyV >= 0)) { toast("Type the quantity"); return; }
    if (!(cond || pr || pf || costHow || qtyHow)) { toast("Pick something to set for all"); return; }
    for (const id of ED.ids) { const x = P.items.find((y) => y.id === id), dd = ED.d.get(id); if (!x || !dd) continue;
      if (cond) { if (TR_GRADES.includes(cond)) dd.grade = cond; else { dd.cond = cond; dd.grade = ""; } }
      if (pr) dd.var = pr; if (pf) dd.pf = pf; if (qtyHow) dd.qty = Math.max(0, Math.round(+qtyV));
      if (costHow === "clear") dd.cost = 0; else if (costHow === "amt") dd.cost = Math.round(+costV * 100) / 100; }
    ED.allOpen = false; edRender();
    // a % of market waits for the new prices, then is worked out per card
    if (costHow === "pct") { const setPct = () => { for (const id of ED ? ED.ids : []) { const x = P.items.find((y) => y.id === id), dd = ED.d.get(id), mk = x && edPrice(x, dd); if (mk > 0) dd.cost = Math.round(mk * +costV) / 100; }
        if (ED) { edRender(); } };
      const wait = () => { if (!ED) return; if (ED.ids.some((id) => { const x = P.items.find((y) => y.id === id); return x && edPrice(x, ED.d.get(id)) === undefined; })) setTimeout(wait, 300); else setPct(); }; wait(); }
    toast(`Set for all ${ED.ids.length}. Check them, then Apply changes.`);
  }
});
document.addEventListener("toggle", (e) => { if (e.target.classList && e.target.classList.contains("ed-all") && ED) ED.allOpen = e.target.open; }, true);
function impMenu(open) { impOpen = !!open; const m = $("impm"), b = document.querySelector('[data-pa="imp"]'); if (!m) return; m.hidden = !open; if (b) b.setAttribute("aria-expanded", open ? "true" : "false"); }
document.addEventListener("click", (e) => { const m = $("impm"); if (!m || m.hidden) return;
  if (e.target.closest('[data-pa="imp"]')) return; if (!m.contains(e.target) || e.target.closest(".imp-i")) impMenu(false); }, true);
document.addEventListener("click", (e) => {
  const box = $("pf"); if (!box || !box.contains(e.target)) return;
  const dot = e.target.closest && e.target.closest("[data-u]"); if (dot) { if (dot.dataset.u) openLink(dot.dataset.u); return; }
  if (Date.now() - swJust < 400) return;
  const btn = e.target.closest("button");
  const openRow = document.querySelector("#pf .pr.open"); if (openRow && !(btn && btn.dataset.trash)) { closeSwipes(); return; }
  { const r = e.target.closest(".pr[data-id]"); if (r && r.dataset.id === selJustId && Date.now() - selJust < 1500) { selJustId = ""; return; } } // the release after a press and hold
  if (!btn) { const row = !e.target.closest("a,input,select,label,form") && e.target.closest(".pr[data-id]"); if (row && selMode) selToggle(row.dataset.id); else if (row && editing !== row.dataset.id) openDetail(row.dataset.id); return; }
  const d = btn.dataset;
  if (d.pffo) { pffOpen = !pffOpen; render(); return; }
  if (d.pffc) { PFF = {}; try { localStorage.removeItem("pp_pffilter"); } catch {} shown = PAGE; render(); return; }
  if (d.pffx) { pffSet(d.pffx, ""); return; }
  if (d.ps) { if (d.ps === "done") selEnd(); else if (d.ps === "all") { const l = filtered(), all = l.length && l.every((x) => selIds.has(x.id)); l.forEach((x) => (all ? selIds.delete(x.id) : selIds.add(x.id))); selSync(); }
    else if (d.ps === "edit") edOpen(); else if (d.ps === "rm") selRemove(); else if (d.ps === "scan") { sqTarget = "select"; sqOpen(); } return; }
  if (d.czr) { cSet({ x0: -Infinity, x1: Infinity, y0: -Infinity, y1: Infinity }); return; }
  if (d.dr) { drng = d.dr; cview = null; render(); return; }
  if (d.dc) { dsel = d.dc; cview = null; render(); return; }
  if (d.dx) { const x = detailItem();
    if (d.dx === "back") closeDetail();
    else if (x && d.dx === "ebay") { const q = queryFor(x, dsel), sel = dsel; closeDetail(false, true); ppEbayFilter(sel); $("q").value = q; const b = $("tb").querySelector('[data-t="ebay"]'); if (b) b.click(); tcgQ = ""; load(); scrollTo({ top: 0, behavior: "smooth" }); }
    else if (x && d.dx === "tcg") { const sel = dsel; closeDetail(false, true); ppTcgFilter(selGrade(sel) ? x.cond : sel, x.var, x.tcgId, x.set); $("q").value = queryFor(x, dsel); tcgQ = ""; const b = $("tb").querySelector('[data-t="tcg"]'); if (b) b.click(); scrollTo({ top: 0, behavior: "smooth" }); }
    return; }
  if (d.ed && detail) { detail = null; }
  if (d.pv != null) { view = d.pv; shown = PAGE; editing = null; render(); }
  else if (d.cmp) openDetail(d.cmp); // the card's comps page, the same one Comp opens from the scan list
  else if (d.ed) { editing = d.ed; render(); const x = P.items.find((y) => y.id === d.ed); if (x) loadPrints(x); }
  else if (d.zm) { const x = P.items.find((y) => y.id === d.zm); if (x) ppZoom([x.tcgId ? `https://tcgplayer-cdn.tcgplayer.com/product/${x.tcgId}_in_1000x1000.jpg` : "", x.big, x.img], x.name); }
  else if (d.cx) { editing = null; render(); }
  else if (d.del) askRemove(d.del);
  else if (d.trash) askRemove(d.trash);
  else if (d.pa === "merge" || d.pa === "replace") applyImport(d.pa);
  else if (d.pa === "cancel") { pending = null; $("pfi").hidden = true; }
  else if (d.pa === "imp") { const m = $("impm"); impMenu(m && m.hidden); }
  else if (d.pa === "clink") cimpSetup();
  else if (d.cx2) cimpAction(d.cx2);
  else if (d.pa === "add") { editing = "new"; render(); }
  else if (d.pa === "trade") { tradeOpen = true; editing = null; render(); scrollTo(0, 0); }
  else if (d.pa === "more") { shown += PAGE; render(); }
  else if (d.pa === "export") exportCSV();
  else if (d.pa === "undo") { modal({ title: "Undo the last import?", text: "Your portfolio goes back to how it was just before it. Changes you've made since then are undone too.", buttons: [{ label: "Undo", value: true, kind: "danger" }, { label: "Keep", value: false, kind: "primary" }] }).then((v) => { if (v) undoImport(); }); }
  else if (d.pa === "clear") { if (confirm("Remove every card from your portfolio on this device? Export a CSV first if you want a backup.")) { P = { items: [], asOf: null }; store(); try { localStorage.removeItem(HKEY); } catch {} render(); } }
});
document.addEventListener("change", (e) => {
  if ((e.target.id === "pff" || e.target.id === "pff2") && e.target.files[0]) { onFile(e.target.files[0]); e.target.value = ""; }
  else if (e.target.id === "pfo") { sortBy = e.target.value; shown = PAGE; render(); }
});
document.addEventListener("input", (e) => {
  const t = e.target; if (!t.dataset || !t.dataset.qoff || !t.closest("#ppscan")) return;
  const it = sqItem(t.dataset.qoff); if (!it || t.value === "") return;
  sqSetOffer(it, t.value, t);
});
document.addEventListener("change", (e) => {
  const t = e.target; if (!t.dataset || !t.dataset.qsh || !t.closest("#ppscan")) return;
  const it = sqItem(t.dataset.qsh); if (it) sqShadow(it, t.checked);
});
document.addEventListener("input", (e) => {
  const t = e.target; if (!t.dataset || !t.closest || !t.closest("#sq-go") || t.value === "") return;
  if (t.dataset.qgpct) sqGroupSetPct(t.value); else if (t.dataset.qgoff) sqGroupSetTotal(t.value);
});
document.addEventListener("change", (e) => {
  const t = e.target; if (!t.dataset || !t.closest || !t.closest("#sq-go")) return;
  if (t.value !== "" && Number.isFinite(+t.value)) { if (t.dataset.qgpct) sqGroupSetPct(t.value); else if (t.dataset.qgoff) sqGroupSetTotal(t.value); }
  sqSave(); sqGroupSync();
  // tidy the box that was just finished (sqGroupSync leaves the focused one alone)
  const g = sqGroupStats(); if (t.dataset.qgoff) t.value = sqOffTxt(g.offer); else if (t.type === "range") t.value = Math.min(100, Math.round(g.pct)); else t.value = sqPctTxt(g.pct);
});
document.addEventListener("toggle", (e) => {
  const t = e.target; if (t && t.id === "sq-go") { sqGoOpen = t.open; return; }
  if (!t.dataset) return;
  if (t.dataset.qo2) { const it = sqItem(t.dataset.qo2); if (it) it.offOpen = t.open; }
  else if (t.dataset.qls) { const it = sqItem(t.dataset.qls); if (!it || it.lsOpen === t.open) return; it.lsOpen = t.open; if (t.open) { sqSalesPaint(it); sqSalesLoad(it); } }
}, true);
document.addEventListener("change", (e) => {
  const t = e.target; if (!t.dataset || !t.dataset.qoff || !t.closest("#ppscan")) return;
  const it = sqItem(t.dataset.qoff); if (!it) return;
  if (t.value !== "" && Number.isFinite(+t.value)) sqSetOffer(it, t.value);
  t.value = sqOffTxt(sqOffer(it)); sqSave();
});
document.addEventListener("input", (e) => {
  const t = e.target; if (!t.dataset || !t.dataset.qpct || !t.closest("#ppscan")) return;
  const it = sqItem(t.dataset.qpct); if (!it || t.value === "") return;
  sqSetPct(it, t.value, t);
});
document.addEventListener("change", (e) => {
  const t = e.target; if (!t.dataset || !t.dataset.qpct || !t.closest("#ppscan")) return;
  const it = sqItem(t.dataset.qpct); if (!it) return;
  if (t.value === "" || !Number.isFinite(+t.value)) t.value = sqPctTxt(sqPctOf(it)); else sqSetPct(it, t.value);
  t.value = t.type === "range" ? Math.min(100, Math.round(sqPctOf(it))) : sqPctTxt(sqPctOf(it)); sqSave();
});
let qt; document.addEventListener("input", (e) => { if (e.target.id !== "pfq") return; clearTimeout(qt);
  qt = setTimeout(() => { const prev = findTxt.trim(); findTxt = e.target.value;
    if (findTxt.trim() === prev) return; // only spaces changed: nothing to filter
    shown = PAGE; renderList(); }, 200); });
// while the search box is in use, the list keeps at least a screen of height, so fewer matches don't shrink the page under it
document.addEventListener("focusin", (e) => { if (e.target.id === "pfq") { const b = $("pflist"); if (b) b.style.minHeight = innerHeight + "px"; } });
document.addEventListener("focusout", (e) => { if (e.target.id === "pfq") { const b = $("pflist"); if (b) b.style.minHeight = ""; } });
document.addEventListener("change", (e) => { const k = e.target.dataset && e.target.dataset.pff; if (!k || !e.target.closest("#pf")) return; const v = e.target.value.trim(); pffSet(k, (k === "vmin" || k === "vmax") && v !== "" ? String(Math.max(0, +v)) : v); });
document.addEventListener("keydown", (e) => { const k = e.target.dataset && e.target.dataset.pff; if (k && e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
document.addEventListener("submit", (e) => { if (e.target.classList?.contains("pe") && e.target.id !== "be-f") { e.preventDefault(); saveForm(e.target); } });
render();
setTimeout(fillPrices, 1500);
})();

// Portfolio picker for the add/edit forms: a list of existing portfolios plus "New portfolio…", which shows a name box
function pfField(cur, pfs) {
  const list = [...new Set([...(pfs || []), ...(cur ? [cur] : [])])].filter(Boolean), isNew = !list.length;
  return `<label>Portfolio<select name="pf" data-pfsel>${list.map((p) => `<option value="${esc(p)}" ${p === cur ? "selected" : ""}>${esc(p)}</option>`).join("")}<option value="__new" ${isNew ? "selected" : ""}>+ New portfolio…</option></select></label>
  <label class="pfnew" ${isNew ? "" : "hidden"}>New portfolio name<input name="pfNew" placeholder="e.g. Binder 2" autocomplete="off"></label>`;
}
document.addEventListener("change", (e) => {
  const sel = e.target.closest && e.target.closest("select[data-pfsel]"); if (!sel) return;
  const box = sel.closest("label").nextElementSibling; if (!box || !box.classList.contains("pfnew")) return;
  box.hidden = sel.value !== "__new"; if (!box.hidden) box.querySelector("input").focus();
});

/* While a pop-up window (scan list, camera, a question) is open, the page behind it stays put. On iPhone a swipe on a
   window that can't scroll any further otherwise scrolls the page underneath. The page is pinned where it was and
   put back at the same spot when the last window closes. */
let lockY = null;
function syncScrollLock() {
  const open = !!document.querySelector("body > .ppm-ov, body > .sq-cam"), b = document.body.style;
  if (open && lockY == null) { lockY = scrollY; Object.assign(b, { position: "fixed", top: -lockY + "px", left: "0", right: "0", width: "100%", overflow: "hidden" }); }
  else if (!open && lockY != null) { const y = lockY; lockY = null; Object.assign(b, { position: "", top: "", left: "", right: "", width: "", overflow: "" }); scrollTo(0, y); }
}
new MutationObserver(syncScrollLock).observe(document.body, { childList: true });
syncScrollLock();

// once, after the "nearest condition" estimate was added: cards still on Collectr's price try TCGplayer again now
// (and again once TCGplayer's listed price per condition was used): cards on Collectr's price or an estimate look again now
try { if (!localStorage.getItem("pp_price_retry2")) { let n = 0; for (const x of P.items) if (!isGraded(x) && (x.mktV !== 2 || x.mktEst)) { x.pTry = 0; if (x.mktEst) x.mktV = 0; n++; } localStorage.setItem("pp_price_retry2", "1"); if (n) { store(); fillPrices(); } } } catch {}
// Price Plot opens on the Portfolio tab (the first one)
{ const b = $("tb").querySelector('[data-t="pf"]'); if (b && tab !== "pf") b.click(); }
