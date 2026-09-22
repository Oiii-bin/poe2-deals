#!/usr/bin/env node
// =============================================================================
// scrape_official.js — 直接從 GGG 官方商城抓「特價中」的商品（零依賴）
//
// 兩個官方源（都免登入、公開）：
//   1. PoE2 商城 API  https://pathofexile2.com/api/shop-microtransactions?game=poe2
//      → 約 686 件，JSON。⚠ 實測（2026-09-22）：GGG 已移除 special:{start,end} 欄位，
//        且所有 item 的 cost === baseCost（無任何折扣）。故 fromPoe2Api 現階段會產出 0 筆——
//        這是 GGG 端「PoE2 商城目前沒有特價」所致，非本站 bug；GGG 上架 PoE2 特價後會自動出現。
//   2. PoE1 商城 SSR  https://www.pathofexile.com/shop/category/specials
//      → 頁面內嵌 new Category({items:[...]})，補足 PoE1 專屬外觀（API 只有 poe2）；
//        此頁才有 onSpecial===true + cost<originalCost 的真實折扣資料。
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
// 官方繁中對照源（GGG 臺服域，免登入）：
//   • pathofexile.tw/api/shop-microtransactions?game=poe2 → PoE2 全目錄（繁中，676 件）
//   • pathofexile.tw/shop/category/specials（SSR）        → PoE1 特價頁（繁中）
// 用官方譯名優先於機翻：品質好、且符合「翻譯必須有權威來源」原則。以 id 對應 EN/TW。
const TW_POE2_API = "https://pathofexile.tw/api/shop-microtransactions?game=poe2";
const TW_POE1_SPECIALS = "https://pathofexile.tw/shop/category/specials";

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

// ---------- 官方繁中對照表（臺服）：id → { name, description } ----------
// 兩個源並行抓、各自容錯；模組內快取 30 分鐘（譯名不常變，省 1.4MB 流量）。
// 失敗不影響英文主流程 —— 沒有對照表就退回原本的機翻路徑。
// 回傳 { id, name } 兩張表：
//   • id   ：以 GGG 商品 id 對照（官方源主流程用，精準）
//   • name ：以英文商品名小寫對照（社群源補漏用，因社群源商品多半沒有 id）
const TW_MAP_TTL_MS = Number(process.env.TW_MAP_TTL_MS || 30 * 60 * 1000);
let twMapCache = { ts: 0, map: null };
async function getTwMap(opts) {
  if (twMapCache.map && Date.now() - twMapCache.ts < TW_MAP_TTL_MS) return twMapCache.map;
  const byId = new Map();
  const put = (id, name, description) => {
    if (id && name && !byId.has(id)) byId.set(id, { name: String(name), description: String(description || "") });
  };
  const jobs = [
    request(TW_POE2_API).then((r) => {
      for (const it of (JSON.parse(r.body).data || [])) {
        put(it.id, it.name, it.description);
        for (const v of it.variants || []) put(v.id, v.name || it.name, v.description || it.description);
      }
    }),
  ];
  if (!opts.poe2Only) {
    jobs.push(request(TW_POE1_SPECIALS).then((r) => {
      for (const it of JSON.parse(extractItemsArray(r.body))) {
        put(it.id, it.name, it.description);
        for (const v of it.variants || []) put(v.id, v.name || it.name, v.description || it.description);
      }
    }));
  }
  const settled = await Promise.allSettled(jobs);
  if (!settled.some((s) => s.status === "fulfilled")) {
    throw new Error("TW 繁中源全部失敗：" + settled.map((s) => String((s.reason && s.reason.message) || s.reason)).join(" / "));
  }
  const map = { id: byId };
  twMapCache = { ts: Date.now(), map };
  return map;
}

// 社群源（usaginest 等）商品多半沒有 GGG id，只能拿英文商品名去「英文名→臺服譯名」對照表比對。
// 這張表由 run() 把官方 EN 目錄（含英文名）與臺服目錄（含中文名）以 id join 而成。
// 這裡吃一整批上游商品（{ english:{name,description}, ... }），回傳「補上 twName」的版本。
// 官方源本身已帶 twName，傳入會原樣返回（不覆蓋）。
function enrichWithTw(items, twMap) {
  if (!twMap || !twMap.enName || !items) return items;
  const en = twMap.enName;
  return items.map((it) => {
    if (it.twName) return it;
    const nm = it.english && it.english.name;
    const hit = nm && en.get(String(nm).toLowerCase());
    return hit ? Object.assign({}, it, { twName: hit }) : it;
  });
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
// 收錄規則（2026-09-16 擴充）：PoE2 商品「沒折扣也收錄」的判定
//   • 折扣中（cost < baseCost）→ kind:"discount"
//   • 帶 NewItems 標籤（GGG 新上架）→ kind:"new"，讓 PoE2 商城在站點上有內容
//     （GGG 目前 PoE2 商城 API 已無任何折扣資料，若只收折扣會讓 PoE2 整區空白）
const isNewItem = (it, v) => {
  const tags = (v && v.tags) || it.tags || [];
  return tags.includes("NewItems");
};

// ---------- PoE2 API ----------
function fromPoe2Api(json, twMap) {
  const out = [];
  const data = (json && json.data) || [];
  for (const it of data) {
    const end = it.special && it.special.end ? it.special.end : null;
    const tw = (twMap && twMap.id.get(it.id)) || null;
    // 注意：變體的父層常是 forsale=false 的「分組容器」（例如 Toad King Portal Effect Variations），
    // 自己沒有價格，但底下的變體才是真正販售與打折的項目 → 父層不賣也要繼續展開變體。
    // 收錄條件放寬：折扣中「或」帶 NewItems 標籤（新上架）都收；kind 標註類型供前端區分徽章。
    const parentDisc = isDiscounted(it, "cost", "baseCost");
    const parentNew = isNewItem(it);
    if (isSellable(it) && (parentDisc || parentNew)) {
      out.push({
        name: it.name,
        description: it.description || "",
        image: it.largeImageUrl || it.imageUrl || "",
        link: "https://pathofexile2.com/shop/item/" + slugPoE2(it.name),
        source: parentDisc ? "poe2_normal" : "poe2_new",
        original: it.baseCost,
        discount: it.cost,
        specialEnd: end,
        tags: it.tags || [],
        kind: parentDisc ? "discount" : "new",
        ...(tw ? { twName: tw.name, twDesc: tw.description } : {}),
      });
    }
    // 變體（同一商品的不同配色）各自有自己的價格與折扣
    for (const v of it.variants || []) {
      if (!isSellable(v)) continue;
      const vDisc = isDiscounted(v, "cost", "baseCost");
      const vNew = isNewItem(it, v);
      if (!vDisc && !vNew) continue;
      const tv = (twMap && (twMap.id.get(v.id) || twMap.id.get(it.id))) || null;
      out.push({
        name: v.name || it.name,
        description: v.description || it.description || "",
        image: v.largeImageUrl || v.imageUrl || it.largeImageUrl || it.imageUrl || "",
        link: "https://pathofexile2.com/shop/item/" + slugPoE2(v.name || it.name),
        source: vDisc ? "poe2_variant" : "poe2_new",
        original: v.baseCost,
        discount: v.cost,
        specialEnd: (v.special && v.special.end) || end,
        tags: v.tags || it.tags || [],
        kind: vDisc ? "discount" : "new",
        ...(tv ? { twName: tv.name, twDesc: tv.description } : {}),
      });
    }
  }
  return out;
}

// ---------- PoE1 SSR ----------
function fromPoe1Html(html, twMap) {
  const arr = JSON.parse(extractItemsArray(html));
  const out = [];
  for (const it of arr) {
    // 同上：父層可能是分組容器，仍要展開變體（PoE1 的 Defiled Revelation Blade 就是變體）
    const tw = (twMap && twMap.id.get(it.id)) || null;
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
        ...(tw ? { twName: tw.name, twDesc: tw.description } : {}),
      });
    }
    for (const v of it.variants || []) {
      if (!isSellable(v)) continue;
      if (v.onSpecial === true && isDiscounted(v, "cost", "originalCost")) {
        const tv = (twMap && (twMap.id.get(v.id) || twMap.id.get(it.id))) || null;
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
          ...(tv ? { twName: tv.name, twDesc: tv.description } : {}),
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
  for (const x of list2) {
    // 覆蓋時若新資料沒有繁中對照而舊資料有，保留舊的（不輕易丟掉官方譯名）
    const prev = byName.get(x.name);
    if (prev && !x.twName && prev.twName) { x.twName = prev.twName; x.twDesc = prev.twDesc; }
    byName.set(x.name, x);
  }
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
    kind: x.kind || "discount",
    price: { original: x.original, discount: x.discount },
    ...(x.specialEnd ? { specialEnd: x.specialEnd } : {}),
    ...(x.twName ? { twName: x.twName, twDesc: x.twDesc } : {}),
  }));
}

// ---------- main ----------
async function run(opts) {
  const errors = [];
  // 官方繁中對照表（臺服源）—— 與英文源並行抓，失敗只記錄、不影響英文主流程
  const twPromise = getTwMap(opts).catch((e) => {
    errors.push("TW 繁中: " + String((e && e.message) || e));
    return null;
  });
  // 兩個源同時打（PoE2 API 約 1.6MB、PoE1 頁面約 215KB），其中一個掛掉不影響另一個
  let enRaw = null;
  const jobs = [request(POE2_API).then(async (r) => { enRaw = JSON.parse(r.body); return { poe2: fromPoe2Api(enRaw, await twPromise) }; })];
  if (!opts.poe2Only) {
    jobs.push(request(POE1_SPECIALS).then(async (r) => ({ poe1: fromPoe1Html(r.body, await twPromise) })));
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
  const twCount = items.filter((x) => x.twName).length;
  const tw = await twPromise; // 社群源補譯要用（失敗時為 null）
  // 英文名 → 臺服譯名 對照表：用官方 EN 全目錄（含英文名 + id）join 臺服目錄（中文名 + id）。
  // 社群源商品沒 id，只能靠英文名比對這張表（PoE2 全目錄約 686 件，涵蓋絕大部分折扣/組合包內容物）。
  const enName = new Map();
  if (tw && enRaw) {
    for (const it of (enRaw.data || [])) {
      const zh = tw.id.get(it.id);
      if (zh && zh.name && !enName.has(String(it.name).toLowerCase())) enName.set(String(it.name).toLowerCase(), zh.name);
    }
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
  }
  return { out, poe2Count: poe2.length, poe1Count: poe1.length, errors, twCount, twMap: { id: tw ? tw.id : new Map(), enName } };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const oIdx = argv.indexOf("-o");
  const opts = {
    out: oIdx >= 0 ? argv[oIdx + 1] : null,
    poe2Only: argv.includes("--poe2-only"),
  };
  run(opts)
    .then(({ out, poe2Count, poe1Count, errors, twCount }) => {
      console.log("官方 PoE2 API 折扣:", poe2Count);
      console.log("官方 PoE1 SSR 折扣:", poe1Count);
      console.log("合併去重後        :", out.items.length);
      console.log("官方繁中對照覆蓋  :", twCount + "/" + out.items.length);
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

module.exports = { run, fromPoe2Api, fromPoe1Html, enrichWithTw, POE2_API, POE1_SPECIALS, TW_POE2_API, TW_POE1_SPECIALS };
