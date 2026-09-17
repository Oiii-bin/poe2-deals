#!/usr/bin/env node
// =============================================================================
// scrape_official.js — 直接從 GGG 官方商城抓「特價中」的商品（零依賴）
//
// 兩個官方源（都免登入、公開）：
//   1. PoE2 商城 API  https://pathofexile2.com/api/shop-microtransactions?game=poe2
//      → 644 件，JSON，支援 If-Modified-Since / 304，欄位含 special:{start,end}
//   2. PoE1 商城 SSR  https://www.pathofexile.com/shop/category/specials
//      → 頁面內嵌 new Category({items:[...]})，補足 PoE1 專屬外觀（API 只有 poe2）
//
// 輸出格式與社群源 usaginest 相容（server.js 可直接吃），並額外帶 specialEnd：
//   { date, items:[ { english:{name,description}, image, link, source,
//                     price:{original,discount}, specialEnd } ] }
//
// 用法：
//   node scrape_official.js                # 印摘要
//   node scrape_official.js -o fallback.json
//   node scrape_official.js --poe2-only
// =============================================================================

const fs = require("fs");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const POE2_API = "https://pathofexile2.com/api/shop-microtransactions?game=poe2";
const POE1_SPECIALS = "https://www.pathofexile.com/shop/category/specials";

// ---------- HTTP ----------
// 用內建 fetch（Node 18+）：自動處理 gzip/br 解壓與 301/302 轉址，比自己收 chunk 省事又快。
// 另外帶 If-Modified-Since：官方 API 回 304 時直接沿用上一份，省下 1.6MB 流量也加快刷新。
const condCache = new Map(); // url -> { lastModified, body }
const REQ_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 30000);

async function request(url, extraHeaders) {
  const prev = condCache.get(url);
  const headers = Object.assign({ "User-Agent": UA, Accept: "*/*" }, extraHeaders || {});
  if (prev && prev.lastModified) headers["If-Modified-Since"] = prev.lastModified;

  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  if (res.status === 304 && prev) return { body: prev.body, headers: res.headers, fromCache: true };
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);

  const body = await res.text();
  const lastModified = res.headers.get("last-modified") || res.headers.get("etag") || null;
  if (lastModified) condCache.set(url, { lastModified, body });
  return { body, headers: res.headers };
}

// ---------- 官方 PoE1 頁面：從 new Category({...}) 抽出 items:[...] ----------
// 外層是 JS 字面量（key 沒引號），不能直接 JSON.parse，所以用括號配對只取 items 陣列
function extractItemsArray(html) {
  const k = html.indexOf("new Category(");
  if (k < 0) throw new Error("找不到 new Category(");
  const i = html.indexOf("items:", k);
  if (i < 0) throw new Error("找不到 items:");
  const start = html.indexOf("[", i);
  if (start < 0) throw new Error("找不到 items 陣列起點");
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return html.slice(start, p + 1); }
  }
  throw new Error("items 陣列括號未配對");
}

// ---------- slug ----------
const slugPoE1 = (n) => String(n).replace(/[^A-Za-z0-9]/g, "");
const slugPoE2 = (n) =>
  String(n)
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ---------- 折扣判定 ----------
const isDiscounted = (x, costKey, baseKey) =>
  x && typeof x[costKey] === "number" && typeof x[baseKey] === "number" && x[costKey] < x[baseKey];
const isSellable = (x) => x && x.forsale !== false && !x.visibleOnlyInPackage;

// ---------- PoE2 API ----------
function fromPoe2Api(json) {
  const out = [];
  const data = (json && json.data) || [];
  for (const it of data) {
    const end = it.special && it.special.end ? it.special.end : null;
    // 注意：變體的父層常是 forsale=false 的「分組容器」（例如 Toad King Portal Effect Variations），
    // 自己沒有價格，但底下的變體才是真正販售與打折的項目 → 父層不賣也要繼續展開變體。
    if (isSellable(it) && isDiscounted(it, "cost", "baseCost")) {
      out.push({
        name: it.name,
        description: it.description || "",
        image: it.largeImageUrl || it.imageUrl || "",
        link: "https://pathofexile2.com/shop/item/" + slugPoE2(it.name),
        source: "poe2_normal",
        original: it.baseCost,
        discount: it.cost,
        specialEnd: end,
        tags: it.tags || [],
      });
    }
    // 變體（同一商品的不同配色）各自有自己的價格與折扣
    for (const v of it.variants || []) {
      if (!isSellable(v)) continue;
      if (!isDiscounted(v, "cost", "baseCost")) continue;
      out.push({
        name: v.name || it.name,
        description: v.description || it.description || "",
        image: v.largeImageUrl || v.imageUrl || it.largeImageUrl || it.imageUrl || "",
        link: "https://pathofexile2.com/shop/item/" + slugPoE2(v.name || it.name),
        source: "poe2_variant",
        original: v.baseCost,
        discount: v.cost,
        specialEnd: (v.special && v.special.end) || end,
        tags: v.tags || it.tags || [],
      });
    }
  }
  return out;
}

// ---------- PoE1 SSR ----------
function fromPoe1Html(html) {
  const arr = JSON.parse(extractItemsArray(html));
  const out = [];
  for (const it of arr) {
    // 同上：父層可能是分組容器，仍要展開變體（PoE1 的 Defiled Revelation Blade 就是變體）
    if (isSellable(it) && it.onSpecial === true && isDiscounted(it, "cost", "originalCost")) {
      out.push({
        name: it.name,
        description: it.description || "",
        image: it.imageUrl || "",
        link: "https://www.pathofexile.com/shop/item/" + slugPoE1(it.name),
        source: "poe1",
        original: it.originalCost,
        discount: it.cost,
        specialEnd: null,
        tags: it.tags || [],
      });
    }
    for (const v of it.variants || []) {
      if (!isSellable(v)) continue;
      if (v.onSpecial === true && isDiscounted(v, "cost", "originalCost")) {
        out.push({
          name: v.name || it.name,
          description: v.description || it.description || "",
          image: v.imageUrl || it.imageUrl || "",
          link: "https://www.pathofexile.com/shop/item/" + slugPoE1(v.name || it.name),
          source: "poe1",
          original: v.originalCost,
          discount: v.cost,
          specialEnd: null,
          tags: v.tags || it.tags || [],
        });
      }
    }
  }
  return out;
}

// ---------- 合併 ----------
function merge(list2, list1) {
  const byName = new Map();
  // PoE1 先放，PoE2 後放 → 同名時 PoE2 覆蓋（PoE2 資料較新也較完整）
  for (const x of list1) byName.set(x.name, x);
  for (const x of list2) byName.set(x.name, x);
  const items = [...byName.values()].sort((a, b) => {
    const pa = a.original > 0 ? 1 - a.discount / a.original : 0;
    const pb = b.original > 0 ? 1 - b.discount / b.original : 0;
    return pb - pa || a.name.localeCompare(b.name);
  });
  return items.map((x) => ({
    english: { name: x.name, description: x.description },
    image: x.image,
    link: x.link,
    source: x.source,
    price: { original: x.original, discount: x.discount },
    ...(x.specialEnd ? { specialEnd: x.specialEnd } : {}),
  }));
}

// ---------- main ----------
async function run(opts) {
  const errors = [];
  // 兩個源同時打（PoE2 API 約 1.6MB、PoE1 頁面約 215KB），其中一個掛掉不影響另一個
  const jobs = [request(POE2_API).then((r) => ({ poe2: fromPoe2Api(JSON.parse(r.body)) }))];
  if (!opts.poe2Only) {
    jobs.push(request(POE1_SPECIALS).then((r) => ({ poe1: fromPoe1Html(r.body) })));
  }
  const settled = await Promise.allSettled(jobs);
  let poe2 = [], poe1 = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      if (s.value.poe2) poe2 = s.value.poe2;
      if (s.value.poe1) poe1 = s.value.poe1;
    } else {
      errors.push((i === 0 ? "PoE2 API: " : "PoE1 SSR: ") + String((s.reason && s.reason.message) || s.reason));
    }
  });

  const items = merge(poe2, poe1);
  if (!items.length) throw new Error("官方源沒有取得任何折扣資料：" + errors.join(" / "));

  const out = { date: new Date().toISOString().replace("T", " ").slice(0, 19), items };

  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
  }
  return { out, poe2Count: poe2.length, poe1Count: poe1.length, errors };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const oIdx = argv.indexOf("-o");
  const opts = {
    out: oIdx >= 0 ? argv[oIdx + 1] : null,
    poe2Only: argv.includes("--poe2-only"),
  };
  run(opts)
    .then(({ out, poe2Count, poe1Count, errors }) => {
      console.log("官方 PoE2 API 折扣:", poe2Count);
      console.log("官方 PoE1 SSR 折扣:", poe1Count);
      console.log("合併去重後        :", out.items.length);
      const ends = out.items.filter((x) => x.specialEnd).map((x) => x.specialEnd).sort();
      if (ends.length) console.log("本輪特價結束時間  :", ends[0], "（共 " + ends.length + " 件帶結束時間）");
      if (errors.length) console.log("（部分源失敗，已降級）", errors.join(" / "));
      if (opts.out) console.log("已寫出:", opts.out);
    })
    .catch((e) => {
      console.error("失敗:", e.message);
      process.exit(1);
    });
}

module.exports = { run, fromPoe2Api, fromPoe1Html, POE2_API, POE1_SPECIALS };
