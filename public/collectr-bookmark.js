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
  const readAll = async (base, h) => {
    const U = new URL(base), lim = +(U.searchParams.get("limit") || 30), got = []; let off = 0, sample = null;
    for (let page = 0; page < 500; page++) {
      U.searchParams.set("offset", String(off)); U.searchParams.set("limit", String(lim));
      const r = await F0(U.toString(), { credentials: "include", headers: h });
      if (!r.ok) { if (!got.length) return { status: r.status }; log.push("stopped at " + off + ": status " + r.status); break; }
      const j = await r.json(); if (!sample) sample = JSON.stringify(j).slice(0, 4000);
      const arr = findArr(j); if (!arr || !arr.length) break;
      got.push(...arr); off += arr.length; say("reading your cards… " + got.length + " so far");
      if (arr.length < lim) break;
    }
    return { items: got, sample };
  };
  const run = async () => {
    const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => /api-v2\.getcollectr\.com/.test(u));
    log.push("requests seen: " + urls.length);
    const show = urls.filter((u) => /\/data\/showcase\//.test(u));
    let base = show[show.length - 1] || null, items = [], used = null, sample = null;
    if (!base) { const m = /\/showcase\/profile\/([^/?#]+)/.exec(location.pathname); if (m) base = "https://api-v2.getcollectr.com/data/showcase/" + m[1] + "?offset=0&limit=30&filters=&unstackedView=true"; }
    if (!base) return { type: "collectr-import", v: 3, page: location.href, used, count: 0, items: [], log: log.concat(["no showcase request found"]), sample };
    log.push("showcase: " + base.replace(/[?].*/, ""));
    /* first try: the headers the page's code says it uses (signed-in name and token if any, otherwise the guest id) */
    const tok = cookie("collectrToken"), user = new URL(base).searchParams.get("username");
    const h1 = { Accept: "application/json, text/plain, */*", "x-collectr-username": (tok && tok.username) || user || "00000000-0000-0000-0000-000000000000" };
    if (tok && tok.token) h1.Authorization = tok.token;
    try { if (window.AwsWafIntegration && AwsWafIntegration.getToken) h1["x-aws-waf-token"] = await AwsWafIntegration.getToken(); } catch (e) {}
    let r = await readAll(base, h1); log.push("try 1 (" + Object.keys(h1).join(", ") + "): " + (r.items ? r.items.length + " cards" : "status " + r.status));
    if (!r.items || !r.items.length) {
      say("reading your cards… (learning how this page asks)");
      const L = await learn();
      if (L) { log.push("learned headers: " + Object.keys(L.h).join(", ")); const h2 = { ...L.h }; r = await readAll(base, h2); log.push("try 2: " + (r.items ? r.items.length + " cards" : "status " + r.status)); }
      else log.push("the page made no new request to learn from");
    }
    if (r.items && r.items.length) { items = r.items; sample = r.sample; used = base.replace(/[?].*/, ""); }
    return { type: "collectr-import", v: 3, page: location.href, used, count: items.length, items: items.map((x) => slim(x, 0)), log, sample };
  };
  run().then((data) => {
    say(data.count ? "found " + data.count + " entries, opening Price Plot…" : "couldn't find the cards, opening Price Plot with details…");
    const f = document.createElement("form"); f.method = "POST"; f.action = PP + "/api/collectr-handoff"; f.acceptCharset = "UTF-8"; f.style.display = "none";
    const t = document.createElement("textarea"); t.name = "data"; t.value = JSON.stringify(data); f.appendChild(t);
    document.body.appendChild(f); f.submit(); done(data.count ? "Sent " + data.count + " entries to Price Plot" : "No cards found");
    setTimeout(() => { say("Price Plot didn't open. Run Send to Price Plot again, or send Claude a screenshot of this."); window.__ppBusy = false; }, 15000);
  }).catch((e) => { say("something went wrong: " + e.message); window.__ppBusy = false; done("error: " + e.message); });
})();
