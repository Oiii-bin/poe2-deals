#!/usr/bin/env node
// build_fallback.js — 產生「完整」備援快照：官方 GGG 商城（帶臺服繁中）＋ 社群源補件（經 enName 補繁中）＋ 聯集。
//
// 用途：refresh-fallback.yml 調用它生成 fallback.json。與 server.js 的 fetchSource() 管線一致，
//       讓備援快照也帶滿繁中（而非只有官方件有 twName、社群補件是英文）。
//
// 容錯：官方爬蟲失敗 → 退社群源（無法補繁中，但仍是有效備援）；兩者皆空才拋錯。
const scraper = require("./scrape_official.js");
const fs = require("fs");

const COMMUNITY = process.env.COMMUNITY_URL || "https://poe.usaginest.com/poe2_special.json";
const OUT = process.argv[2] || "fallback.json";

(async () => {
  // 1) 官方 GGG 商城（含臺服繁中對照 twMap）
  let official = null, twMap = null;
  try {
    const res = await scraper.run({});
    official = res.out;
    twMap = res.twMap; // { id, enName }
  } catch (e) {
    console.log("⚠️ 官方爬蟲失敗：" + String((e && e.message) || e) + " → 後續改走社群源備援");
  }

  // 2) 社群源（補官方漏掉的組合包內容物）
  let socialItems = [];
  try {
    const r = await fetch(COMMUNITY);
    const u = await r.json();
    socialItems = u.items || [];
  } catch (e) {
    console.log("社群源略過：" + e.message);
  }

  // 3) 社群源補繁中（有 twMap 才補，否則留英文）
  const enriched = twMap ? scraper.enrichWithTw(socialItems, twMap) : socialItems;

  // 4) 聯集：官方為主，社群補官方沒有的（依 english.name 去重）
  const base = (official && official.items) || [];
  const seen = new Set(base.map((x) => x.english && x.english.name).filter(Boolean));
  const extra = enriched.filter((x) => x.english && x.english.name && !seen.has(x.english.name));
  const items = base.concat(extra);

  if (!items.length) throw new Error("官方與社群源都未取得任何商品");

  const out = {
    date: (official && official.date) || new Date().toISOString().replace("T", " ").slice(0, 19),
    items,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const zh = items.filter((x) => x.twName && /[一-鿿]/.test(x.twName)).length;
  console.log("聯集後 items=" + items.length + "（官方 " + base.length + " + 社群補 " + extra.length + "）| 帶繁中 " + zh + "/" + items.length);
})().catch((e) => { console.error("❌ " + e.message); process.exit(1); });
