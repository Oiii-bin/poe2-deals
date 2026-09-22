// PoE2 即時折扣站 — 零依賴 Node 代理 + 靜態伺服器
// 啟動: node server.js   (預設 http://localhost:8787)
// 資料源可一行切換: 改 DATA_SOURCE_URL 即可接你自己的爬蟲

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || "0.0.0.0";

// ===== 設定區 =====
// 抓取策略（2026-09-17 改版）：**官方優先、社群補漏、兩者聯集**
//   1. 官方 PoE2 商城 API   pathofexile2.com/api/shop-microtransactions?game=poe2
//      → 公開、免登入、644 件、支援 If-Modified-Since/304，且帶 special:{start,end}
//        （本輪特價的精確結束時間，讓前端倒計時不必再用「每日固定時間」硬估）
//   2. 官方 PoE1 特價頁     pathofexile.com/shop/category/specials（SSR，內嵌 items JSON）
//      → 補上 API 沒有的 PoE1 專屬外觀
//   3. 社群源 usaginest     → 補官方漏掉的「組合包內容物拆件」，也是官方全掛時的保底
// 任一源失敗都不影響其他源；全部失敗才退回記憶體快取 / 倉庫內 fallback.json。
const DATA_SOURCES = [
  process.env.DATA_SOURCE_URL || "https://poe.usaginest.com/poe2_special.json",
  // 自建鏡像（需先把本倉庫 push 到 GitHub 並啟用 Action 每日刷新 fallback.json）：
  process.env.MIRROR_URL || "https://cdn.jsdelivr.net/gh/Oiii-bin/poe2-deals@main/fallback.json",
].filter((v, i, a) => v && a.indexOf(v) === i);
const DATA_SOURCE_URL = DATA_SOURCES[0]; // 對外顯示用（社群備援源）
// 官方商城爬蟲（同目錄、零依賴）：直接打 GGG 公開端點，免登入、可 304 快取
const officialScraper = require("./scrape_official.js");
const CACHE_TTL_SEC = 5 * 60;          // 上游 JSON 快取
const MT_TIMEOUT_MS = 3500;            // 單次翻譯超時（避免卡死）
const MT_CONCURRENCY = 6;              // 翻譯並發數
// ===================

const PUBLIC_DIR = __dirname;
const FALLBACK_FILE = path.join(PUBLIC_DIR, "fallback.json"); // 倉庫內備用快照：主源掛掉且無記憶體快取時回退
let cache = { ts: 0, data: null, err: null };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

// ===== POE 專用詞庫（名稱精確對照，優先於機翻）=====
const ZH_OVERRIDE = {
  "Silver Timekeeper's Map Device": "銀製計時者地圖裝置",
  "Bronze Timekeeper's Map Device": "青銅製計時者地圖裝置",
  "Gold Timekeeper's Map Device": "黃金製計時者地圖裝置",
  "Celestial Emperor Wings": "天界帝王之翼",
  "Sunprism Cloak": "日光稜披風",
  "Sunprism Wings": "日光稜之翼",
  "Seraph Banner Back Attachment": "熾天旗幟背飾",
  "Exile's Pilfering Ring": "流亡者偷竊戒指",
  "Exile's Pedometer Ring": "流亡者計步戒指",
  "Mana Tank Back Attachment": "魔力坦克背飾",
  "Divine Artillery Strike Rare Finisher Effect": "神聖炮擊·稀有終結技特效",
  "Plummeting Chaos Rare Finisher Effect": "墜落混沌·稀有終結技特效",
  "Plummeting Exalted Rare Finisher Effect": "墜落崇高·稀有終結技特效",
  "Zenith Portal Effect": "天頂傳送門特效",
  "Radiant Footprints Effect": "璀璨足跡特效",
  "Tumbling Exalted Orb Pet": "翻滾崇高石寵物",
  "Tumbling Chaos Orb Pet": "翻滾混沌石寵物",
  "Sunprism Cat Pet": "日光稜貓咪寵物",
  "Witchhunter Armour Pack": "獵巫者護甲包",
  "Ghoulhunter Armour Pack": "獵墓者護甲包",
  "Gilded Explosion Level-up Extra Effect": "鍍金爆炸升級額外特效",
  "Witchhunter Back Attachment": "獵巫者背飾",
  "Ghoulhunter Back Attachment": "獵墓者背飾",
  "Witchhunter Crossbow Skin": "獵巫者十字弩皮膚",
  "Ghoulhunter Crossbow Skin": "獵墓者十字弩皮膚",
  "Radiant Tornado Effect": "璀璨龍捲風特效",
  "Radiant Thunderstorm Effect": "璀璨雷暴特效",
  "Radiant Lightning Bolt Effect": "璀璨閃電特效",
  "Radiant Volcano Effect": "璀璨火山特效",
  "Valkyrie Thunderous Leap Effect": "女武神雷鳴躍擊特效",
  "Valkyrie Primal Strikes Effect": "女武神原始打擊特效",
  "Valkyrie Herald of Thunder Effect": "女武神雷鳴先驅特效",
  "Valkyrie Storm Lance Effect": "女武神風暴之槍特效",
  "Valkyrie Lightning Spear Effect": "女武神閃電之槍特效",
  "Wings of the Valkyrie Level-up Extra Effect": "女武神之翼升級額外特效",
  "Gold Fluttering Scarab Shield": "黃金振翅聖甲蟲盾牌",
  "Marble Gargoyle Portal Effect": "大理石石像鬼傳送門特效",
  "Exalted Peddler's Rain Hideout Decoration": "崇高小販之雨藏身處裝飾",
  "Suspicious Gold Rock Pet": "可疑黃金岩石寵物",
  "Solar Paladin Portal Effect": "太陽聖騎傳送門特效",
  "Gold-plated Dovecaller Wings": "鍍金鴿語者之翼",
  "Silver-plated Dovecaller Wings": "鍍銀鴿語者之翼",
  "Bronze-plated Dovecaller Wings": "鍍青銅鴿語者之翼",
  "Divine Tinker's Waypoint Decoration": "神聖工匠傳送點裝飾",
  "Pure Mana Tank Back Attachment": "純淨魔力坦克背飾",
  "Yellow Warp Rune Hideout Decoration": "黃色曲躍符文藏身處裝飾",
  "White Warp Rune Hideout Decoration": "白色曲躍符文藏身處裝飾",
};

// ===== POE 專用詞庫（說明文字精確對照，優先於機翻）=====
const ZH_DESC = {
  "Adds a Silver Timekeeper's Map Device decoration to your personal Hideout. This map device tracks how long you've been in an area.":
    "在你的個人藏身處加入一座銀製計時者地圖裝置裝飾。此地圖裝置會記錄你在某區域停留的時間。",
  "Adds a Bronze Timekeeper's Map Device decoration to your personal Hideout. This map device tracks how long you've been in an area.":
    "在你的個人藏身處加入一座青銅製計時者地圖裝置裝飾。此地圖裝置會記錄你在某區域停留的時間。",
  "Adds a Gold Timekeeper's Map Device decoration to your personal Hideout. This map device tracks how long you've been in an area.":
    "在你的個人藏身處加入一座黃金製計時者地圖裝置裝飾。此地圖裝置會記錄你在某區域停留的時間。",
  "The Exile's Pilfering Ring tracks amount of currency your character has picked up off of the floor.":
    "流亡者偷竊戒指會記錄你的角色從地上拾取的通貨數量。",
  "The Exile's Pedometer Ring tracks the number of steps your character has taken.":
    "流亡者計步戒指會記錄你的角色行走的步數。",
  "Adds the Mana Tank Back Attachment to your body armour. Its effect scales with your percentage of current mana.":
    "為你的身體護甲加入魔力坦克背飾。其效果會隨你當前魔力的百分比而增強。",
  "Imbues a weapon with the Divine Artillery Strike Rare Finisher Effect. It amplifies the deaths of Rare Monsters you kill.":
    "為武器注入神聖炮擊·稀有終結技特效。它會放大你所擊殺的稀有怪物的死亡效果。",
  "Imbues a weapon with the Plummeting Chaos Rare Finisher Effect. It amplifies the deaths of Rare Monsters you kill.":
    "為武器注入墜落混沌·稀有終結技特效。它會放大你所擊殺的稀有怪物的死亡效果。",
  "Imbues a weapon with the Plummeting Exalted Rare Finisher Effect. It amplifies the deaths of Rare Monsters you kill.":
    "為武器注入墜落崇高·稀有終結技特效。它會放大你所擊殺的稀有怪物的死亡效果。",
  "The Tumbling Exalted Orb Pet glows when there is currency of a matching type on the ground, letting out a shockwave when that currency is picked up.":
    "當地上出現相同類型的通貨時，翻滾崇高石寵物會發光，並在該通貨被拾取時釋出衝擊波。",
  "The Tumbling Chaos Orb Pet glows when there is currency of a matching type on the ground, letting out a shockwave when that currency is picked up.":
    "當地上出現相同類型的通貨時，翻滾混沌石寵物會發光，並在該通貨被拾取時釋出衝擊波。",
  "Contains the Witchhunter Helmet, Boots, Gloves and Body Armour (at a discounted price).":
    "包含獵巫者頭盔、靴子、手套與身體護甲（以折扣價格）。",
  "Contains the Ghoulhunter Helmet, Boots, Gloves and Body Armour (at a discounted price).":
    "包含獵墓者頭盔、靴子、手套與身體護甲（以折扣價格）。",
  "Adds a gilded explosion effect when you level up.":
    "在升級時加入鍍金爆炸特效。",
  "Adds the Witchhunter Back Attachment to your character.":
    "為你的角色加入獵巫者背飾。",
  "Adds the Ghoulhunter Back Attachment to your character.":
    "為你的角色加入獵墓者背飾。",
  "Replaces the appearance of a crossbow with the Witchhunter Crossbow.":
    "將十字弩的外觀替換為獵巫者十字弩。",
  "Replaces the appearance of a crossbow with the Ghoulhunter Crossbow.":
    "將十字弩的外觀替換為獵墓者十字弩。",
  "Replaces the standard effect on a Tornado gem with a radiant version.":
    "將龍捲風技能的標準特效替換為璀璨版本。",
  "Replaces the standard effect on a Thunderstorm gem with a radiant version.":
    "將雷暴技能的標準特效替換為璀璨版本。",
  "Replaces the standard effect on a Lighting Bolt gem with a radiant version.":
    "將閃電技能的標準特效替換為璀璨版本。",
  "Replaces the standard effect on a Volcano gem with a radiant version.":
    "將火山技能的標準特效替換為璀璨版本。",
  "Replaces the standard effect on a Thunderous Leap gem with a valkyrie version.":
    "將雷鳴躍擊技能的標準特效替換為女武神版本。",
  "Replaces the standard effect on a Primal Strikes gem with a valkyrie version.":
    "將原始打擊技能的標準特效替換為女武神版本。",
  "Replaces the standard effect on a Herald of Thunder gem with a valkyrie version.":
    "將雷鳴先驅技能的標準特效替換為女武神版本。",
  "Replaces the standard effect on a Storm Lance gem with a valkyrie version.":
    "將風暴之槍技能的標準特效替換為女武神版本。",
  "Replaces the standard effect on a Lightning Spear gem with a valkyrie version.":
    "將閃電之槍技能的標準特效替換為女武神版本。",
  "Adds a wings of the valkyrie effect when you level up.":
    "在升級時加入女武神之翼特效。",
  "Replaces the appearance of a shield with the Gold Fluttering Scarab Shield. A swarm of scarabs circle around you whenever you block.":
    "將盾牌的外觀替換為黃金振翅聖甲蟲盾牌。每當你格擋時，一群聖甲蟲會環繞你飛舞。",
  "Replaces the standard effect on portals you create with the Marble Gargoyle Portal Effect.":
    "將你創建的傳送門標準特效替換為大理石石像鬼傳送門特效。",
  "Adds an Exalted Peddler's Rain decoration to your personal Hideout. Completing a trade causes currency to rain from above.":
    "在你的個人藏身處加入崇高小販之雨裝飾。完成交易時，通貨會從上方如雨落下。",
  "The Suspicious Gold Rock Pet is totally a rock and not at all an imp in a disguise. Rumours that this pet throws pebbles at others are unsubstantiated.":
    "可疑黃金岩石寵物絕對只是一塊石頭，絕對不是偽裝的小惡魔。關於這隻寵物向他人丟擲小石子的傳言並無實證。",
  "The Solar Paladin Portal Effect calls forth a holy warrior who summons a portal from their sword as you approach. When their services are not required, they spend their time practising their swordplay.":
    "太陽聖騎傳送門特效會召喚一名神聖戰士，當你靠近時，他會從劍中召出傳送門。當無需其協助時，他便靜心練劍。",
  "Adds the Gold-plated Dovecaller Wings to any equipped body armour, causing you to discover gold doves inside chest and barrels.":
    "為任何已裝備的身體護甲加入鍍金鴿語者之翼，讓你在寶箱與木桶中發現金色鴿子。",
  "Adds the Silver-plated Dovecaller Wings to any equipped body armour, causing you to discover silver doves inside chest and barrels.":
    "為任何已裝備的身體護甲加入鍍銀鴿語者之翼，讓你在寶箱與木桶中發現銀色鴿子。",
  "Adds the Bronze-plated Dovecaller Wings to any equipped body armour, causing you to discover bronze doves inside chest and barrels.":
    "為任何已裝備的身體護甲加入鍍青銅鴿語者之翼，讓你在寶箱與木桶中發現青銅色鴿子。",
  "Adds a Divine Tinker's Waypoint decoration to your personal Hideout. The waypoint whirs into action whenever a player uses it.":
    "在你的個人藏身處加入神聖工匠傳送點裝飾。每當玩家使用傳送點時，它便會嗡鳴啟動。",
  "Adds the Pure Mana Tank Back Attachment to your body armour. Its effect scales with your percentage of current mana.":
    "為你的身體護甲加入純淨魔力坦克背飾。其效果會隨你當前魔力的百分比而增強。",
  "Adds a Yellow Warp Rune Hideout Decoration to your personal Hideout, allowing you to warp to a destination in your hideout that you can place separately.":
    "在你的個人藏身處加入黃色曲躍符文藏身處裝飾，讓你可以傳送到藏身處中由你另行放置的目的地。",
  "Adds a White Warp Rune Hideout Decoration to your personal Hideout, allowing you to warp to a destination in your hideout that you can place separately.":
    "在你的個人藏身處加入白色曲躍符文藏身處裝飾，讓你可以傳送到藏身處中由你另行放置的目的地。",
};
// 機翻常見錯誤修正
const TERM_FIX = [
  ["銀牌", "銀"], ["金牌", "金"], ["銅牌", "銅"],
  ["地圖設備", "地圖裝置"], ["十字弓", "十字弩"],
  ["計時器地圖", "計時者地圖"],
  ["添加", "加入"], ["设备", "設備"], ["装饰", "裝飾"], ["个人", "個人"],
];

// ===== 0.5.5 新増：修正機翻錯誤 / 統一為臺服官方譯名 =====
// 順序有關：較長、較特定的詞組必須排在較短的通用詞前面
// 來源：pathofexile.tw 官方商城頁、臺服 static 資料、poedb.tw
const NEW_TERM_FIX = [
  // —— 武器 / 裝備類別 ——
  ["四分之一工作人員", "長棍"], ["四分之一職員", "長棍"], ["四分之一杖", "長棍"], ["四分衛", "長棍"], // Quarterstaff
  ["雙手棍棒", "雙手錘"], ["棍棒", "錘"],   // Mace
  ["魔杖", "法杖"],                          // Wand
  ["利爪", "爪"],                            // Claw
  ["員工", "長杖"],                          // Staff 被誤譯成「員工」
  // —— 終結技系列：與既有詞典「稀有終結技特效」一致 ——
  ["稀有分尾效果", "稀有終結技特效"], ["終結者效果", "終結技特效"],
  // —— 商城外觀用語（臺服：武器外觀 / 護盾外觀 / 裝備塑形）——
  ["皮膚轉移", "裝備塑形"], ["皮膚", "外觀"], ["項目", "道具"],
  // —— 專有名詞 ——
  ["查尤拉", "夏烏拉"],                      // Chayula
  ["考姆", "岡姆"],                          // Kaom
  ["薩卡瓦爾", "斯卡沃"],                    // Saqawal
  ["Xesht", "烈許"],                         // Xesht
  ["Verisium", "維里西姆"], ["威利西姆", "維里西姆"],
  ["多莉雅妮", "多里亞尼"], ["多利亞尼", "多里亞尼"], // Doryani
  ["破壞王", "裂痕領主"], ["破壞者", "裂痕領主"], ["突破者", "裂痕領主"], // Breachlord
  ["監獄長", "守望者"],                      // Warden
  ["榮譽護衛", "榮光守衛"], ["榮譽守衛", "榮光守衛"], // Honour Guard
  ["發起者", "開創者"], ["創始人", "開創者"], // Originator
];
TERM_FIX.push(...NEW_TERM_FIX);
function applyTermFix(s) { return TERM_FIX.reduce((a, [f, t]) => a.split(f).join(t), s); }

// ===== 物品分類（上游 JSON 無 kind 欄位，依名稱規則推導）=====
// 順序有關：較特定的關鍵字放前面（如 Level-up / Shield 要先於 Effect）；
// 同理 Weapon Effect（武器視覺特效）必須在通用 Effect 之前，否則會被誤判成「技能特效」。
const CATEGORY_RULES = [
  ["Map Device", "地圖裝置"],
  ["Ring", "戒指"],
  ["Back Attachment", "背飾"],
  ["Finisher Effect", "終結技特效"],
  ["Pet", "寵物"],
  ["Armour Pack", "護甲包"],
  ["Crossbow Skin", "裝備外觀"],
  ["Shield", "裝備外觀"],
  ["Level-up", "升級特效"],
  ["Wings", "之翼"],
  ["Portal Effect", "傳送門特效"],
  ["Hideout Decoration", "藏身處裝飾"],
  ["Waypoint Decoration", "藏身處裝飾"],
  ["Weapon Effect", "裝備外觀"],   // 武器視覺特效（帳號綁定，跨代通用）—— 必須在 Effect 之前
  ["Effect", "技能特效"],           // 真正的寶石/技能圖示特效（遊戲綁定，跨代不可用）
];
function classify(name) {
  for (const [kw, zh] of CATEGORY_RULES) {
    if (name && name.includes(kw)) return zh;
  }
  return "其他";
}

// 翻譯快取（寫入檔案，重啟/重新發布後仍可在本次運行內復用）
const TRANS_CACHE_FILE = path.join(PUBLIC_DIR, "translations.cache.json");
let transCache = {};
try { transCache = JSON.parse(fs.readFileSync(TRANS_CACHE_FILE, "utf8")); } catch (e) {}
function saveTransCache() {
  try { fs.writeFileSync(TRANS_CACHE_FILE, JSON.stringify(transCache)); } catch (e) {}
}
// 翻譯快取是在「機翻 + TERM_FIX」之後寫入的，事後新增修正規則不會自動生效。
// 故啟動時把 NEW_TERM_FIX 對既有快取補做一次（不必重新機翻，速度快且離線也有效）。
(function refreshTransCache() {
  let n = 0;
  for (const k of Object.keys(transCache)) {
    const v = transCache[k];
    if (typeof v !== "string") continue;
    const nv = NEW_TERM_FIX.reduce((a, [f, t]) => a.split(f).join(t), v);
    if (nv !== v) { transCache[k] = nv; n++; }
  }
  if (n) { saveTransCache(); console.log(`🔧 翻譯快取套用新譯名規則：更新 ${n} 筆`); }
})();

// 翻譯通道（依序嘗試，任一成功即採用）
async function mtTranslate(en, signal) {
  const r = await fetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(en) + "&langpair=en|zh-TW", { signal });
  const j = await r.json();
  const t = j && j.responseData && j.responseData.translatedText;
  if (!t) throw new Error("empty");
  return t;
}
async function gTranslate(en, signal) {
  const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=en&tl=zh-TW&q=" + encodeURIComponent(en), { signal });
  const j = await r.json();
  const t = (j[0] || []).map((seg) => seg[0]).join("");
  if (!t) throw new Error("empty");
  return t;
}
const PROVIDERS = [mtTranslate, gTranslate];

// 單條翻譯：詞庫優先 → 多通道（MyMemory → Google）→ 全部失敗才回英文（不快取，下次重試）
async function translate(en) {
  if (!en) return en;
  if (transCache[en]) return transCache[en];
  if (ZH_OVERRIDE[en]) { transCache[en] = ZH_OVERRIDE[en]; saveTransCache(); return transCache[en]; }
  if (ZH_DESC[en]) { transCache[en] = ZH_DESC[en]; saveTransCache(); return transCache[en]; }
  for (const p of PROVIDERS) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), MT_TIMEOUT_MS);
      const t = await p(en, ctrl.signal);
      clearTimeout(to);
      const tt = (t || "").trim();
      // 拒絕非中文回應（如 MyMemory 配額警示字串），避免誤當成功而快取
      if (tt && tt.toLowerCase() !== en.trim().toLowerCase() && /[\u4e00-\u9fff]/.test(tt)) {
        const fixed = applyTermFix(tt);
        transCache[en] = fixed; saveTransCache();
        return fixed;
      }
    } catch (e) { /* 該通道失敗，試下一個 */ }
  }
  return en;
}

// 批次翻譯（限制並發）
async function translateBatch(texts) {
  const out = {};
  let i = 0;
  async function worker() {
    while (i < texts.length) {
      const idx = i++;
      out[texts[idx]] = await translate(texts[idx]);
    }
  }
  await Promise.all(Array.from({ length: MT_CONCURRENCY }, worker));
  return out;
}

// 判定商品屬於哪一代商城：優先用上游 source 欄位（poe1 / poe2*），沒有才退回用連結網域判斷
function detectGame(it) {
  const s = String(it.source || "").toLowerCase();
  if (s.startsWith("poe1")) return "PoE1";
  if (s.startsWith("poe2")) return "PoE2";
  return (it.link || "").includes("pathofexile2.com") ? "PoE2" : "PoE1";
}

// 判定跨代可用性：
//   - 真正的「技能特效」（寶石/技能圖示特效）：依附在該代的寶石圖示上，換遊戲就失效 → 該代限定
//   - 其他 MTX（武器外觀、盾牌、裝備、終結技、傳送門、藏身處、寵物、背飾、之翼、戒指、護甲包）：帳號綁定 → 跨代通用
// 依官方公告（GGG 已確認大多數 PoE1 MTX 跟著帳號在 PoE2 可用；只有 skill-effect 類不能）
function crossCompat(category, game) {
  if (category === "技能特效") {
    return game === "PoE1"
      ? { tag: "PoE1 限定", level: "poe1-only", tooltip: "此為寶石/技能圖示特效，僅能在 PoE1 使用" }
      : { tag: "PoE2 限定", level: "poe2-only", tooltip: "此為寶石/技能圖示特效，僅能在 PoE2 使用" };
  }
  return { tag: "跨代通用", level: "both", tooltip: "帳號綁定，可在 PoE1 與 PoE2 互通使用" };
}

// 將上游原始 JSON 正規化為本站內部格式（分類、折扣百分比、跨代可用性；PoE1 / PoE2 都保留）
// ⚠️ 這裡刻意做成「同步、零網路呼叫」：翻譯只讀現有快取，缺的就先出英文。
//    舊版把翻譯（可長達數十秒）包在整體逾時裡，導致「上游有新資料、卻因為翻譯慢而整包被丟棄、
//    永遠退回備用快照」。現在改成：新資料立即回傳，翻譯由 kickTranslate() 在背景慢慢補。
//
// 翻譯優先順序（2026-09-21 修正「點中文沒翻譯」根因）：
//   官方臺服繁中 (twName/twDesc) ＞ 機翻快取 (transCache) ＞ 精確詞庫 (ZH_OVERRIDE/ZH_DESC) ＞ 原文。
//   官方繁中是 GGG 臺服域 pathofexile.tw 直接給的權威譯名（scrape_official.js 以 id 對照 EN 帶入），
//   品質遠勝機翻、且符合「絕不偽造翻譯」原則；機翻只作為官方源沒涵蓋時的備援。
function hasCJK(s) { return typeof s === "string" && /[一-鿿]/.test(s); }
function normalizeSync(json) {
  const zh = (t) => (t ? transCache[t] || ZH_OVERRIDE[t] || ZH_DESC[t] || t : t);
  const items = (json.items || []).map((it) => {
    const original = Number(it.price?.original) || 0;
    const discount = Number(it.price?.discount) || 0;
    const pct = original > 0 ? Math.round((1 - discount / original) * 100) : 0;
    const game = detectGame(it);
    const category = classify(it.english?.name || "");
    // 官方臺服繁中對照：只接受「真的含中文字」的值，避免空值/異常值蓋掉機翻
    const twName = hasCJK(it.twName) ? it.twName : null;
    const twDesc = hasCJK(it.twDesc) ? it.twDesc : null;
    return {
      name: it.english?.name || "未知物品",
      description: it.english?.description || "",
      link: it.link || "#",
      image: it.image || "",
      source: it.source || "",
      game,
      category,
      crossCompat: crossCompat(category, game),
      price: { discount, original },
      offPct: pct,
      // kind 由 scrape_official.js 標註：discount=特價中 / new=新上架（沒折扣也收錄，供 PoE2 商城有內容）
      kind: it.kind || (pct > 0 ? "discount" : "new"),
      // 官方 API 會帶 special:{start,end}（本輪特價的精確結束時間），前端用它做精確倒計時；
      // 社群源沒有這個欄位 → 為 null，前端退回「每日固定時間」估算。
      specialEnd: it.specialEnd || null,
      // 官方繁中 ＞ 機翻快取 ＞ 詞庫 ＞ 原文
      zhName: twName || zh(it.english?.name),
      zhDesc: twDesc || zh(it.english?.description),
    };
  }); // 不再過濾：PoE1 / PoE2 都保留，由前端分區顯示
  return { date: json.date || new Date().toISOString(), items };
}

// 背景補翻譯：不阻塞回應；完成後就地換上中文（不重打上游、不重置快取時效）
let translatingRaw = null;
function kickTranslate(raw) {
  if (!raw || translatingRaw === raw) return; // 同一份 raw 只跑一次，避免併發堆疊
  const texts = [...new Set((raw.items || []).flatMap((it) => [it.english?.name, it.english?.description]).filter(Boolean))];
  const missing = texts.filter((t) => !transCache[t]);
  if (!missing.length) return;
  translatingRaw = raw;
  translateBatch(missing)
    .then(() => {
      if (cache.raw !== raw) return;
      // 就地換上中文版本。⚠️ normalizeSync 只產出 {date,items}，
      // 來源標註（sourceUrl / sourceNote）要另外帶過來，否則背景翻譯一完成就會被沖掉。
      const fresh = normalizeSync(raw);
      if (cache.data) {
        for (const k of ["sourceUrl", "sourceNote", "stale", "fromFallback", "error"]) {
          if (cache.data[k] !== undefined) fresh[k] = cache.data[k];
        }
      }
      cache.data = fresh;
      console.log(`🌐 背景翻譯完成，補上 ${missing.length} 筆（快取共 ${Object.keys(transCache).length} 筆）`);
    })
    .catch(() => {})
    .finally(() => { if (translatingRaw === raw) translatingRaw = null; });
}

// 讀取倉庫內備用快照（原始上游格式）
function loadFallbackRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf8"));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch (e) {}
  return null;
}

// 拉上游 JSON（AbortSignal 同時涵蓋連線與讀取 body，上游掛住就中止）
// 逾時後落入下方 catch → 記憶體快取 / 備用快照，使用者最多看到「顯示備用快照」而非無回應
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 10000);
async function fetchJSONFrom(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; poe2-deals-viewer/1.0)" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const json = await r.json();
  if (!json || !Array.isArray(json.items)) throw new Error("資料格式異常");
  return json;
}
// 依序嘗試所有來源，回傳第一個成功的；全部失敗才拋錯（並附上每個來源的失敗原因）
async function fetchUpstreamJSON() {
  const failures = [];
  for (const url of DATA_SOURCES) {
    try {
      const json = await fetchJSONFrom(url);
      return { json, url, failures };
    } catch (e) {
      failures.push(url + " → " + String((e && e.message) || e));
    }
  }
  throw new Error(failures.join(" ｜ ") || "無可用來源");
}

// 官方源與社群源「聯集」：官方為主（較即時、且帶精確特價結束時間），
// 社群源只補官方漏掉的商品（例如它會把組合包內容物拆成單件列出）。任一方掛掉另一方仍能撐住。
function unionOfficialAndSocial(official, social) {
  if (!official) return social;
  if (!social) return official;
  const seen = new Set((official.items || []).map((x) => x.english && x.english.name));
  const extra = (social.items || []).filter((x) => {
    const n = x.english && x.english.name;
    return n && !seen.has(n);
  });
  return { date: official.date || social.date, items: [...(official.items || []), ...extra] };
}

async function fetchSource() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_SEC * 1000) return cache.data;

  // 1) 官方 GGG 商城（主要）
  let official = null, officialErr = null, twMap = null;
  try {
    const res = await officialScraper.run({});
    official = res.out;
    twMap = res.twMap; // 臺服繁中對照表（id + 英文名兩張），社群源補譯要用
  } catch (e) {
    officialErr = String((e && e.message) || e);
    console.warn("⚠️ 官方商城源失敗：" + officialErr);
  }
  // 2) 社群源（備援 + 補漏）
  let social = null, socialUrl = null, socialErr = null;
  try {
    const r = await fetchUpstreamJSON();
    social = r.json;
    socialUrl = r.url;
    // 社群源商品多半沒有 GGG id，用英文名去臺服目錄補上官方繁中（優於機翻）
    if (social && twMap) {
      social = Object.assign({}, social, { items: officialScraper.enrichWithTw(social.items || [], twMap) });
    }
  } catch (e) {
    socialErr = String((e && e.message) || e);
    if (officialErr) console.warn("⚠️ 社群源也失敗：" + socialErr);
  }

  const raw = unionOfficialAndSocial(official, social);
  if (raw && (raw.items || []).length) {
    const out = normalizeSync(raw); // 同步完成：不會再被翻譯拖垮
    out.sourceUrl = official && social
      ? "官方 GGG 商城 ＋ 社群源（已聯集）"
      : official ? "官方 GGG 商城（PoE2 API ＋ PoE1 特價頁）" : socialUrl;
    if (socialErr) out.sourceNote = "社群源本次無法連線，僅顯示官方資料";
    else if (officialErr) out.sourceNote = "官方源本次無法連線，僅顯示社群源資料";
    cache = { ts: now, data: out, raw, sourceUrl: out.sourceUrl, err: null };
    kickTranslate(raw); // 背景補翻譯，不阻塞本次回應
    return out;
  }

  // 兩個源都拿不到 → 容錯：記憶體舊快取 → 倉庫內備用快照 → 錯誤物件
  const msg = [officialErr, socialErr].filter(Boolean).join(" ｜ ") || "無可用來源";
  console.warn("⚠️ 所有上游來源皆失敗：" + msg);
  if (cache.data) return { ...cache.data, stale: true, error: msg };
  const fbRaw = loadFallbackRaw();
  if (fbRaw) {
    const out = normalizeSync(fbRaw);
    out.sourceUrl = "fallback.json（倉庫內快照）";
    kickTranslate(fbRaw);
    return { ...out, stale: true, fromFallback: true,
      error: "來源無法連線（" + msg + "），顯示倉庫內備用快照" };
  }
  return { date: null, items: [], stale: false, error: "來源暫時無法連線，請稍後再試" };
}

function send(res, code, body, type, headers) {
  res.writeHead(code, Object.assign(
    { "Content-Type": type || "application/json; charset=utf-8" },
    headers || {}
  ));
  res.end(body);
}
// 前端資源一律不快取：本站每次重新部署都會改 index.html / app.js / style.css，
// 若讓瀏覽器沿用舊檔，使用者會看不到新功能（例如商城切換鈕）或拿到舊譯名。
const NO_CACHE = { "Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0" };

// ===== 診斷端點 /api/diag =====
// 部署後開啟即可看到「部署環境」能連到哪些外部服務、各花多久。
// 用途：當站上顯示備用快照時，判斷是「上游掛了」還是「部署環境連不出去」。
async function diagOne(name, url, wantJson) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; poe2-deals-viewer/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let note = "";
    if (wantJson) {
      try {
        const j = JSON.parse(text);
        // 社群源用 items[]，官方 PoE2 API 用 data[]
        const n = Array.isArray(j.items) ? j.items.length : Array.isArray(j.data) ? j.data.length : "n/a";
        note = " items=" + n + " date=" + (j.date || "?");
      } catch (e) { note = " (回應非 JSON)"; }
    }
    return { name, url, ok: r.ok, status: r.status, ms: Date.now() - t0, bytes: text.length, note };
  } catch (e) {
    return { name, url, ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
  }
}
async function runDiag() {
  const targets = [
    ["官方 PoE2 商城 API", officialScraper.POE2_API, true],
    ["官方 PoE1 特價頁", officialScraper.POE1_SPECIALS, false],
    ...DATA_SOURCES.map((u, i) => ["社群源 #" + (i + 1) + (i === 0 ? "（主要）" : "（備援）"), u, true]),
    ["GitHub raw（備援載體）", "https://raw.githubusercontent.com/jquery/jquery/3.7.1/package.json", true],
    ["jsDelivr（備援載體）", "https://cdn.jsdelivr.net/gh/jquery/jquery@3.7.1/package.json", true],
    ["MyMemory 翻譯", "https://api.mymemory.translated.net/get?q=test&langpair=en|zh-TW", true],
    ["Google 翻譯", "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=en&tl=zh-TW&q=test", false],
  ];
  const results = [];
  for (const [name, url, wantJson] of targets) results.push(await diagOne(name, url, wantJson));
  return {
    ok: true,
    env: { node: process.version, host: HOST, port: PORT },
    dataSources: DATA_SOURCES,
    activeDataSource: (cache && cache.sourceUrl) || null,
    memoryCache: { hasData: !!cache.data, ageSec: cache.ts ? Math.round((Date.now() - cache.ts) / 1000) : null },
    translationCacheEntries: Object.keys(transCache).length,
    results,
  };
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/items" || url === "/api/items/") {
    fetchSource()
      .then((data) => send(res, 200, JSON.stringify(data), null, NO_CACHE))
      .catch((e) => send(res, 502, JSON.stringify({ error: String(e.message || e) }), null, NO_CACHE));
    return;
  }
  if (url === "/api/diag" || url === "/api/diag/") {
    runDiag()
      .then((d) => send(res, 200, JSON.stringify(d, null, 2), null, NO_CACHE))
      .catch((e) => send(res, 500, JSON.stringify({ error: String((e && e.message) || e) }), null, NO_CACHE));
    return;
  }
  // 只放行對外必要的靜態資源：阻擋上層目錄與 .git / .env 等隱藏檔
  if (url.includes("..") || /(^|\/)\./.test(url)) { send(res, 403, "forbidden"); return; }
  let filePath = path.join(PUBLIC_DIR, url === "/" ? "index.html" : url);
  if (!filePath.startsWith(PUBLIC_DIR)) { send(res, 403, "forbidden"); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { send(res, 404, "not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, buf, MIME[ext] || "application/octet-stream", NO_CACHE);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`✅ PoE2 折扣站已啟動 → http://${HOST}:${PORT}`);
  console.log(`   資料源: ${DATA_SOURCE_URL}`);
});
