/* Price Plot: "Send to Price Plot" bookmark for a Collectr showcase.
   Runs in the person's own browser, on a Collectr showcase page they opened themselves. It re-reads the
   card list the page itself already loaded from Collectr (same requests, same browser), then carries the
   cards over to Price Plot in the same tab with an ordinary form submit. Nothing is sent anywhere else.
   The setup screen in Price Plot turns this file into the bookmark. Use only block comments in here,
   because the bookmark is this file squeezed onto one line. */
(() => {
  const PP = "https://price-plot.onrender.com";
  if (!/(^|\.)getcollectr\.com$/.test(location.hostname)) { alert("Open your Collectr showcase link in Safari first, then tap this bookmark."); return; }
  if (window.__ppBusy) return; window.__ppBusy = true;
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
  const run = async () => {
    const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => /api-v2\.getcollectr\.com/.test(u));
    log.push("requests seen: " + urls.length); urls.slice(-25).forEach((u) => log.push(u));
    const cands = [...new Set(urls.filter((u) => /products|showcase|collection/i.test(u) && !/\/catalog/.test(u)))].reverse();
    let items = [], used = null, sample = null;
    for (const u0 of cands) {
      const m = /\/(?:collections|accounts|showcase[s]?)\/([^/?]+)/.exec(u0), who = m ? decodeURIComponent(m[1]) : "";
      for (const withHeader of [false, true]) {
        try {
          const U = new URL(u0), got = []; let off = 0;
          const paged = U.searchParams.has("offset") || U.searchParams.has("limit");
          for (let page = 0; page < 300; page++) {
            if (paged) { U.searchParams.set("offset", String(off)); U.searchParams.set("limit", "100"); }
            const h = { Accept: "application/json" }; if (withHeader && who) h["x-collectr-username"] = who;
            const r = await fetch(U.toString(), { credentials: "include", headers: h });
            if (!r.ok) { log.push("status " + r.status + (withHeader ? " (with name)" : "") + " " + U.pathname); break; }
            const j = await r.json(); if (page === 0 && !sample) sample = JSON.stringify(j).slice(0, 4000);
            const arr = findArr(j); if (!arr || !arr.length) break;
            got.push(...arr); off += arr.length; say("reading your cards… " + got.length + " so far");
            if (!paged || arr.length < 100) break;
          }
          if (got.length) { items = got; used = u0 + (withHeader ? " (with name)" : ""); break; }
        } catch (e) { log.push("error " + e.message + " " + u0); }
      }
      if (items.length) break;
    }
    return { type: "collectr-import", v: 2, page: location.href, used, count: items.length, items: items.map((x) => slim(x, 0)), log, sample };
  };
  run().then((data) => {
    say(data.count ? "found " + data.count + " entries, opening Price Plot…" : "couldn't find the cards, opening Price Plot with details…");
    const f = document.createElement("form"); f.method = "POST"; f.action = PP + "/api/collectr-handoff"; f.acceptCharset = "UTF-8"; f.style.display = "none";
    const t = document.createElement("textarea"); t.name = "data"; t.value = JSON.stringify(data); f.appendChild(t);
    document.body.appendChild(f); f.submit();
    setTimeout(() => { say("Price Plot didn't open. Tap the bookmark again, or send Claude a screenshot of this."); window.__ppBusy = false; }, 15000);
  }).catch((e) => { say("something went wrong: " + e.message); window.__ppBusy = false; });
})();
