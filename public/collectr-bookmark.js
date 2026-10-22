/* Price Plot: "Send to Price Plot" bookmark for a Collectr showcase.
   Runs in the person's own browser, on a Collectr showcase page they opened themselves. It re-reads the
   card list the page itself already loaded from Collectr (same requests, same browser), then hands the
   cards to Price Plot in a new tab. Nothing is sent anywhere else.
   The setup screen in Price Plot turns this file into the bookmark. Use only block comments in here,
   because the bookmark is this file squeezed onto one line. */
(() => {
  const PP = "https://price-plot.onrender.com";
  if (!/(^|\.)getcollectr\.com$/.test(location.hostname)) { alert("Open your Collectr showcase link in Safari first, then tap this bookmark."); return; }
  const win = window.open(PP + "/#collectr-import", "_blank");
  if (!win) { alert("Your browser blocked the new tab. Allow pop-ups for app.getcollectr.com, then tap the bookmark again."); return; }
  const log = [];
  const findArr = (j) => {
    let best = null; const seen = new Set(), q = [j];
    while (q.length) { const v = q.shift(); if (!v || typeof v !== "object" || seen.has(v)) continue; seen.add(v);
      if (Array.isArray(v)) { if (v.length && typeof v[0] === "object" && (!best || v.length > best.length)) best = v; v.slice(0, 3).forEach((x) => q.push(x)); }
      else Object.values(v).forEach((x) => q.push(x)); }
    return best;
  };
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
            got.push(...arr); off += arr.length; if (!paged || arr.length < 100) break;
          }
          if (got.length) { items = got; used = u0 + (withHeader ? " (with name)" : ""); break; }
        } catch (e) { log.push("error " + e.message + " " + u0); }
      }
      if (items.length) break;
    }
    return { type: "collectr-import", v: 1, page: location.href, used, count: items.length, items, log, sample };
  };
  const result = run();
  let sent = false;
  const onMsg = async (e) => {
    if (e.origin !== PP || !e.data || e.data.type !== "pp-ready" || sent) return;
    sent = true; removeEventListener("message", onMsg);
    try { win.postMessage(await result, PP); } catch (err) { alert("Couldn't hand the cards to Price Plot: " + err.message); }
  };
  addEventListener("message", onMsg);
  setTimeout(() => { if (!sent) alert("Price Plot didn't open in time. Check that the new tab loaded, then tap the bookmark again."); }, 45000);
})();
