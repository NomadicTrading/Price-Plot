/* Price Plot: "Send to Price Plot" for a Collectr showcase. Used as an iPhone Shortcut ("Run JavaScript on Web
   Page", started from Safari's Share button) and, where a browser allows it, as a bookmark.
   Runs in the person's own browser, on a Collectr showcase page they opened themselves. It re-reads the
   card list the page itself already loaded from Collectr (same requests, same browser), then carries the
   cards over to Price Plot in the same tab with an ordinary form submit. Nothing is sent anywhere else.
   The setup screen in Price Plot turns this file into the bookmark. Use only block comments in here,
   because the bookmark is this file squeezed onto one line. */
(() => {
  const PP = "https://price-plot.onrender.com";
  const done = (msg) => { try { if (typeof completion === "function") completion(msg); } catch (e) {} };
  if (!/(^|\.)getcollectr\.com$/.test(location.hostname)) { alert("Open your Collectr showcase link in Safari first, then use Send to Price Plot from the Share button."); done("not a Collectr page"); return; }
  if (window.__ppBusy) { done("already running"); return; } window.__ppBusy = true;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:12px;right:12px;bottom:90px;z-index:2147483647;background:#0f2747;color:#fff;font:600 15px/1.4 -apple-system,Helvetica,Arial,sans-serif;padding:14px 16px;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  const say = (t) => { box.textContent = "Price Plot: " + t; };
  say("reading your cards…"); document.body.appendChild(box);
  const log = [];
  const findArr = (j) => {
    let best = null; const seen = new Set(), q = [j];
    while (q.length) { const v = q.shift(); if (!v || typeof v !== "object" || seen.has(v)) continue; seen.add(v);
      if (Array.isArray(v)) { if (v.length && typeof v[0] === "object" && (!best || v.length > best.length)) best = v; v.slice(0, 3).forEach((x) => q.push(x)); }
      else Object.values(v).forEach((x) => q.push(x)); }
    return best;
  };
  /* keeps plain values two levels deep and drops long text, so thousands of cards stay a manageable size */
  const slim = (o, d) => { const r = {}; for (const k in o) { const v = o[k];
    if (v == null || typeof v === "number" || typeof v === "boolean") r[k] = v;
    else if (typeof v === "string") { if (v.length <= 300) r[k] = v; }
    else if (typeof v === "object" && !Array.isArray(v) && d < 2) r[k] = slim(v, d + 1); } return r; };
  const F0 = window.fetch.bind(window), wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const cookie = (n) => { const c = document.cookie.split("; ").find((x) => x.startsWith(n + "=")); if (!c) return null; const v = decodeURIComponent(c.slice(n.length + 1)); try { return JSON.parse(v); } catch (e) { return v; } };
  /* The showcase page sends a few headers with its own card requests. Rather than guess them, watch the page make
     its next request (scrolling down makes it load more cards) and reuse exactly what it sent. */
  const learn = async () => {
    let got = null; const XP = XMLHttpRequest.prototype, o = XP.open, sh = XP.setRequestHeader, se = XP.send, wf = window.fetch;
    XP.open = function (m, u) { this.__ppU = String(u); this.__ppH = {}; return o.apply(this, arguments); };
    XP.setRequestHeader = function (k, v) { if (this.__ppH) this.__ppH[k] = v; return sh.apply(this, arguments); };
    XP.send = function () { if (!got && /\/data\/showcase\//.test(this.__ppU || "")) got = { url: this.__ppU, h: this.__ppH }; return se.apply(this, arguments); };
    window.fetch = function (i, op) { try { const u = String((i && i.url) || i); if (!got && /\/data\/showcase\//.test(u)) { const h = {}; new Headers((op && op.headers) || (i && i.headers) || {}).forEach((v, k) => (h[k] = v)); got = { url: u, h }; } } catch (e) {} return wf.apply(this, arguments); };
    for (let k = 0; k < 24 && !got; k++) { window.scrollTo(0, document.documentElement.scrollHeight); await wait(500); }
    XP.open = o; XP.setRequestHeader = sh; XP.send = se; window.fetch = wf; window.scrollTo(0, 0);
    return got;
  };
  /* Reads one list (one portfolio, one sort order) page by page. Collectr stops answering after about 500 entries,
     so a long list is read again in other sort orders and the results are merged. */
  const readAll = async (base, h, extra, maxPages) => {
    const U = new URL(base), lim = +(U.searchParams.get("limit") || 30), got = []; let off = 0, first = null;
    for (const k in extra || {}) U.searchParams.set(k, extra[k]);
    for (let page = 0; page < (maxPages || 200); page++) {
      U.searchParams.set("offset", String(off)); U.searchParams.set("limit", String(lim));
      const r = await F0(U.toString(), { credentials: "include", headers: h });
      if (!r.ok) { if (!got.length) return { status: r.status }; log.push("stopped at " + off + ": status " + r.status); break; }
      const j = await r.json(); if (!first) first = j;
      const arr = (j && Array.isArray(j.products)) ? j.products : findArr(j); if (!arr || !arr.length) break;
      got.push(...arr); off += arr.length; if (arr.length < lim) break;
    }
    return { items: got, first };
  };
  const keyOf = (x) => [x.product_id, x.card_condition, x.grade_company, x.grade_id, x.product_sub_type].join("|");
  const qtyOf = (a) => a.reduce((n, x) => n + (+x.quantity || 1), 0);
  const readCollection = async (base, h, c, sorts, note) => {
    const extra = c ? { collectionId: c.id } : {}, seen = new Map();
    const add = (arr) => { for (const x of arr) { const k = keyOf(x); if (!seen.has(k)) seen.set(k, c ? { ...x, __pf: c.name } : x); } };
    const r = await readAll(base, h, extra); if (!r.items) return { status: r.status };
    add(r.items); note();
    const f = r.first || {}, target = (+f.total_cards || 0) + (+f.total_sealed || 0);
    log.push((c ? c.name : "default") + ": " + r.items.length + " entries, " + qtyOf([...seen.values()]) + " of " + (target || "?") + " cards");
    if (r.items.length >= 450) for (const so of sorts) {
      if (target && qtyOf([...seen.values()]) >= target) break;
      const r2 = await readAll(base, h, { ...extra, ...so }); if (r2.items) { add(r2.items); note(); }
      log.push("  sort " + JSON.stringify(so) + ": now " + seen.size + " entries, " + qtyOf([...seen.values()]) + " cards");
    }
    return { items: [...seen.values()], first: r.first, target };
  };
  const run = async () => {
    const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => /api-v2\.getcollectr\.com/.test(u));
    log.push("requests seen: " + urls.length);
    const show = urls.filter((u) => /\/data\/showcase\//.test(u));
    let base = show[show.length - 1] || null, items = [], used = null, sample = null;
    if (!base) { const m = /\/showcase\/profile\/([^/?#]+)/.exec(location.pathname); if (m) base = "https://api-v2.getcollectr.com/data/showcase/" + m[1] + "?offset=0&limit=30&filters=&unstackedView=true"; }
    if (!base) return { type: "collectr-import", v: 4, page: location.href, used, count: 0, items: [], log: log.concat(["no showcase request found"]), sample };
    { const U = new URL(base); U.searchParams.delete("collectionId"); base = U.toString(); }
    log.push("showcase: " + base.replace(/[?].*/, ""));
    /* the headers the page's code uses (signed-in name and token if any, otherwise the guest id) */
    const tok = cookie("collectrToken"), user = new URL(base).searchParams.get("username");
    let h = { Accept: "application/json, text/plain, */*", "x-collectr-username": (tok && tok.username) || user || "00000000-0000-0000-0000-000000000000" };
    if (tok && tok.token) h.Authorization = tok.token;
    try { if (window.AwsWafIntegration && AwsWafIntegration.getToken) h["x-aws-waf-token"] = await AwsWafIntegration.getToken(); } catch (e) {}
    let probe = await readAll(base, h, {}, 1); log.push("headers " + Object.keys(h).join(", ") + ": " + (probe.items ? "ok" : "status " + probe.status));
    if (!probe.items || !probe.items.length) {
      say("reading your cards… (learning how this page asks)");
      const L = await learn();
      if (L) { h = { ...L.h }; log.push("learned headers: " + Object.keys(h).join(", ")); probe = await readAll(base, h, {}, 1); log.push("learned: " + (probe.items ? "ok" : "status " + probe.status)); }
      else log.push("the page made no new request to learn from");
    }
    if (!probe.items || !probe.items.length) return { type: "collectr-import", v: 4, page: location.href, used, count: 0, items: [], log, sample };
    sample = JSON.stringify(probe.first).slice(0, 2500);
    /* sort orders Collectr offers, used to reach past its 500-entry limit */
    let sorts = [];
    try { const r = await F0("https://api-v2.getcollectr.com/data/sort-filters", { credentials: "include", headers: h }); if (r.ok) { const j = await r.json(), arr = findArr(j) || [];
      log.push("sorts: " + JSON.stringify(arr).slice(0, 300));
      sorts = arr.map((o) => { const p = {}; for (const k in o) if (/^sort/i.test(k) && o[k] != null && typeof o[k] !== "object") p[k] = String(o[k]); return p; }).filter((p) => Object.keys(p).length); } } catch (e) {}
    if (!sorts.length) sorts = [{ sortType: "price", sortOrder: "desc" }, { sortType: "price", sortOrder: "asc" }, { sortType: "name", sortOrder: "desc" }, { sortType: "name", sortOrder: "asc" }];
    /* grade names, so a graded card comes in as e.g. "PSA 10" */
    let grades = {};
    try { const r = await F0("https://api-v2.getcollectr.com/data/grading-scales", { credentials: "include", headers: h }); if (r.ok) { const q = [await r.json()], seen = new Set();
      while (q.length) { const v = q.shift(); if (!v || typeof v !== "object" || seen.has(v)) continue; seen.add(v); if (!Array.isArray(v) && v.id != null && (v.name || v.grade || v.label)) grades[String(v.id)] = String(v.name || v.grade || v.label); Object.values(v).forEach((x) => q.push(x)); } } } catch (e) {}
    /* every portfolio on the showcase, not just the one it opens on */
    const cols = (probe.first && Array.isArray(probe.first.collections) && probe.first.collections.length) ? probe.first.collections : [null];
    const all = [];
    for (const c of cols) {
      const note = () => say("reading " + (c ? c.name : "your cards") + "…");
      say("reading " + (c ? c.name : "your cards") + "…");
      const r = await readCollection(base, h, c, sorts, note);
      if (r.items) all.push(...r.items); else log.push((c ? c.name : "default") + ": status " + r.status);
    }
    for (const x of all) if (x.grade_company && x.grade_id != null) x.grade_label = grades[String(x.grade_id)] || null;
    items = all; used = base.replace(/[?].*/, "");
    return { type: "collectr-import", v: 4, page: location.href, used, count: items.length, items: items.map((x) => slim(x, 0)), log, sample };
  };
  run().then((data) => {
    say(data.count ? "found " + data.count + " entries, opening Price Plot…" : "couldn't find the cards, opening Price Plot with details…");
    const f = document.createElement("form"); f.method = "POST"; f.action = PP + "/api/collectr-handoff"; f.acceptCharset = "UTF-8"; f.style.display = "none";
    const t = document.createElement("textarea"); t.name = "data"; t.value = JSON.stringify(data); f.appendChild(t);
    document.body.appendChild(f); f.submit(); done(data.count ? "Sent " + data.count + " entries to Price Plot" : "No cards found");
    setTimeout(() => { say("Price Plot didn't open. Run Send to Price Plot again, or send Claude a screenshot of this."); window.__ppBusy = false; }, 15000);
  }).catch((e) => { say("something went wrong: " + e.message); window.__ppBusy = false; done("error: " + e.message); });
})();
