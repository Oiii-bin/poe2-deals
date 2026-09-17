// 前端邏輯：抓 /api/items → 渲染卡片 → 過濾/排序/搜尋/翻譯/降價提醒 → 自動刷新
const grid = document.getElementById("grid");
const updatedEl = document.getElementById("updated");
const countEl = document.getElementById("count");
const searchEl = document.getElementById("search");
const refreshBtn = document.getElementById("refresh");
const alertsEl = document.getElementById("alerts");
const alertsBody = document.getElementById("alertsBody");
const alertCountEl = document.getElementById("alertCount");
const bellEl = document.getElementById("bell");
const bellCountEl = document.getElementById("bellCount");
const langToggle = document.getElementById("langToggle");
const gameToggle = document.getElementById("gameToggle");
const clearAlertsBtn = document.getElementById("clearAlerts");
const catsEl = document.getElementById("cats");
const favBell = document.getElementById("favBell");
const favBellCount = document.getElementById("favBellCount");
const favAlertsEl = document.getElementById("favAlerts");
const favAlertsBody = document.getElementById("favAlertsBody");
const favAlertCountEl = document.getElementById("favAlertCount");
const clearFavAlertsBtn = document.getElementById("clearFavAlerts");

let ALL = [];
let state = { game: "all", sort: "off", q: "", lang: "en", cat: "all" };
let currentDrops = new Set(); // 當前處於「降價」狀態的物品 link
let currentFavDrops = new Set(); // 當前「收藏且降價」的物品 link

// ===== 本地儲存 =====
const SEEN_KEY = "poe2_seen";   // 上次看到的價格基準
const ALERTS_KEY = "poe2_alerts"; // 未讀降價提醒
function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

// ===== 收藏（我的最愛）=====
const FAVS_KEY = "poe2_favs";            // link -> { name, discount, original, offPct, ts }（收藏時/上次看到的價格基準）
const FAVS_KEY_ALERTS = "poe2_fav_alerts"; // 未讀收藏折扣提醒
function loadFavs() { try { return JSON.parse(localStorage.getItem(FAVS_KEY)) || {}; } catch (e) { return {}; } }
function saveFavs(v) { try { localStorage.setItem(FAVS_KEY, JSON.stringify(v)); } catch (e) {} }
let FAVS = loadFavs();

// ===== 中文翻譯：已改由伺服器端處理（API 直接給 zhName / zhDesc）=====
// 以下詞庫僅作客戶端名稱兜底 + 搜尋比對用

// ===== POE 專用詞庫（精確對照，優先於機翻）=====
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
// 翻譯已移至 server.js（雲端伺服器翻好後由 API 以 zhName / zhDesc 提供）

// ===== 活動倒計時（想加/改就編輯這裡）=====
// time 用 ISO 8601，帶時區最準：北京時間尾綴 +08:00
const EVENTS = [
  { name: "0.5.5 禁忌儀式 活動聯盟", time: "2026-09-05T04:00:00+08:00", link: "https://www.pathofexile.com/forum" },
  { name: "ExileCon 2026", time: "2026-11-07T10:00:00+08:00", link: "https://www.pathofexile.com/" },
  { name: "流放之路2 1.0 正式版", time: "2026-12-11T00:00:00+08:00", link: "https://www.pathofexile2.com/" },
];
const cdName = document.getElementById("cdName");
const cdClock = document.getElementById("cdClock");
const cdList = document.getElementById("cdList");
const discountClockEl = document.getElementById("discountClock");
function fmtCountdown(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${d}天 ${p(h)}:${p(m)}:${p(sec)}`;
}
function tickCountdown() {
  const now = Date.now();
  const future = EVENTS.filter((e) => new Date(e.time).getTime() > now)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  const next = future[0];
  if (next) {
    const diff = new Date(next.time).getTime() - now;
    cdName.innerHTML = next.link
      ? `<a href="${next.link}" target="_blank" rel="noopener" style="color:inherit">${next.name}</a>`
      : next.name;
    cdClock.textContent = fmtCountdown(diff);
  } else {
    cdName.textContent = "近期無活動";
    cdClock.textContent = "已上線 🎉";
  }
  cdList.innerHTML = EVENTS.map((e) => {
    const t = new Date(e.time).getTime();
    const diff = t - now;
    const cls = diff <= 0 ? "past" : diff < 3 * 86400000 ? "soon" : "";
    const dTxt = diff <= 0 ? "已開始" : fmtCountdown(diff);
    return `<div class="cd-pill ${cls}"><span class="t">${e.name}</span><span class="d">${dTxt}</span></div>`;
  }).join("");
  // 折扣刷新倒計時（每日輪換）
  discountClockEl.textContent = fmtCountdown(nextDiscountRefresh().getTime() - now);
}

// ===== 折扣刷新倒計時 =====
// 官方商城 API 的 special:{start,end} 會給出「本輪特價的精確結束時間」；有就用它（最準）。
// 沒有（例如只剩社群源時）才退回估算：GGG 每日折扣約紐西蘭 16:00 輪換（北京 12:00 / 夏季 11:00）。
const DISCOUNT_REFRESH_UTC_HOUR = 4; // UTC 小時：4 = 北京 12:00
function nextDiscountRefresh() {
  const now = Date.now();
  // 1) 優先用官方給的精確結束時間：取「未來最近的那一筆」
  const ends = (window.__itemsCache || [])
    .map((it) => it.specialEnd && new Date(it.specialEnd).getTime())
    .filter((t) => t && t > now)
    .sort((a, b) => a - b);
  if (ends.length) return new Date(ends[0]);
  // 2) 退回每日固定時間估算
  const d = new Date();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DISCOUNT_REFRESH_UTC_HOUR, 0, 0, 0));
  if (target.getTime() <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

// ===== 降價提醒 =====
const MAX_ALERTS = 30; // 提醒筆數上限（避免 localStorage 無限增長）
function detectAlerts(items) {
  const seen = loadJSON(SEEN_KEY, {});
  const alerts = loadJSON(ALERTS_KEY, []);
  for (const it of items) {
    const k = it.link;
    const prev = seen[k];
    if (prev && it.price.discount < prev.discount) {
      const exists = alerts.find((a) => a.key === k && a.newDiscount === it.price.discount);
      if (!exists) {
        alerts.unshift({
          key: k, name: it.name, link: it.link,
          oldDiscount: prev.discount, newDiscount: it.price.discount,
          oldOff: prev.offPct, newOff: it.offPct, ts: Date.now(),
        });
      }
    }
    seen[k] = { discount: it.price.discount, offPct: it.offPct, original: it.price.original, name: it.name };
  }
  // 只保留目前還在架上的商品：每日折扣會輪換，不清理會讓 SEEN 無限膨脹
  const live = new Set(items.map((it) => it.link));
  for (const k of Object.keys(seen)) if (!live.has(k)) delete seen[k];
  saveJSON(SEEN_KEY, seen);
  const capped = alerts.slice(0, MAX_ALERTS);
  saveJSON(ALERTS_KEY, capped);
  return capped; // 回傳值須與寫入值一致，否則鈴鐺數字會比實際儲存的還多
}
function renderAlerts(alerts) {
  const keys = new Set(alerts.map((a) => a.key));
  bellCountEl.textContent = alerts.length;
  alertCountEl.textContent = alerts.length;
  if (!alerts.length) { alertsEl.classList.add("hidden"); return keys; }
  alertsEl.classList.remove("hidden");
  alertsBody.innerHTML = alerts.map((a) => `
    <div class="alert-item">
      <span class="ai-flame">🔥</span>
      <a class="ai-name" href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.name)}</a>
      <span class="ai-price">${a.oldDiscount} → <b>${a.newDiscount}</b> 點</span>
      <span class="ai-off">折扣 ${a.oldOff}% → ${a.newOff}%</span>
      <button class="ai-x" data-key="${esc(a.key)}" title="忽略">✕</button>
    </div>`).join("");
  return keys;
}

// ===== 收藏折扣提醒（只看收藏清單）=====
function detectFavAlerts(items) {
  const alerts = loadJSON(FAVS_KEY_ALERTS, []);
  for (const it of items) {
    const k = it.link;
    const fav = FAVS[k];
    if (!fav) continue; // 未收藏的不提醒
    if (it.price.discount < fav.discount) {
      const exists = alerts.find((a) => a.key === k && a.newDiscount === it.price.discount);
      if (!exists) {
        alerts.unshift({
          key: k, name: it.name, link: it.link,
          oldDiscount: fav.discount, newDiscount: it.price.discount,
          oldOff: fav.offPct, newOff: it.offPct, ts: Date.now(),
        });
      }
    }
    // 收藏基準更新為目前價格（下次更低才再提醒）
    FAVS[k] = { name: it.name, discount: it.price.discount, original: it.price.original, offPct: it.offPct, ts: Date.now() };
  }
  saveFavs(FAVS);
  const capped = alerts.slice(0, MAX_ALERTS);
  saveJSON(FAVS_KEY_ALERTS, capped);
  return capped;
}
function renderFavAlerts(alerts) {
  // 與 renderAlerts 一致：一律回傳 Set（呼叫端會把它指定給 currentFavDrops）
  const keys = new Set(alerts.map((a) => a.key));
  favAlertCountEl.textContent = alerts.length;
  if (!alerts.length) { favAlertsEl.classList.add("hidden"); return keys; }
  favAlertsEl.classList.remove("hidden");
  favAlertsBody.innerHTML = alerts.map((a) => `
    <div class="alert-item">
      <span class="ai-flame">⭐</span>
      <a class="ai-name" href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.name)}</a>
      <span class="ai-price">${a.oldDiscount} → <b>${a.newDiscount}</b> 點</span>
      <span class="ai-off">折扣 ${a.oldOff}% → ${a.newOff}%</span>
      <button class="ai-x" data-key="${esc(a.key)}" title="忽略">✕</button>
    </div>`).join("");
  return keys;
}

function fmtDate(s) {
  if (!s) return "未知";
  const d = new Date(s.replace(" ", "T"));
  if (isNaN(d)) return s;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function applyFilter() {
  let list = ALL.filter((it) => {
    if (state.game !== "all" && it.game !== state.game) return false;
    if (state.cat === "__fav" && !FAVS[it.link]) return false; // 只看收藏
    if (state.cat !== "all" && state.cat !== "__fav" && it.category !== state.cat) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      const hay = (it.name + " " + (it.zhName || "") + " " + (ZH_OVERRIDE[it.name] || "") + " " + (it.zhDesc || "") + " " + it.category).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (state.sort === "off") list.sort((a, b) => b.offPct - a.offPct);
  else if (state.sort === "price") list.sort((a, b) => a.price.discount - b.price.discount);
  else if (state.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

// 分類篩選標籤（依當前資料動態生成，帶數量）
function renderCats() {
  const inScopeList = ALL.filter((it) => state.game === "all" || it.game === state.game);
  const inScopeLinks = new Set(inScopeList.map((it) => it.link)); // Set 比對 O(n+m)，取代原本 O(n×m) 的 some()
  const counts = {};
  for (const it of inScopeList) counts[it.category] = (counts[it.category] || 0) + 1;
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  // 收藏數只算「目前商城範圍內」的，否則數字會比實際顯示的卡片還多
  const favCount = Object.keys(FAVS).filter((k) => inScopeLinks.has(k)).length;
  favBellCount.textContent = favCount;
  favBell.classList.toggle("active", state.cat === "__fav"); // 頂欄鈴鐺高亮 = 正在看收藏視圖
  const inScope = inScopeList.length;
  const chips = [
    `<button class="chip ${state.cat === "all" ? "active" : ""}" data-cat="all">全部 <span class="c">${inScope}</span></button>`,
    `<button class="chip ${state.cat === "__fav" ? "active" : ""}" data-cat="__fav">⭐ 收藏 <span class="c">${favCount}</span></button>`,
  ];
  for (const c of cats) {
    chips.push(`<button class="chip ${state.cat === c ? "active" : ""}" data-cat="${esc(c)}">${esc(c)} <span class="c">${counts[c]}</span></button>`);
  }
  catsEl.innerHTML = chips.join("");
}

function cardHTML(it) {
  const save = it.price.original - it.price.discount;
  const nameTxt = state.lang === "zh" ? (it.zhName || ZH_OVERRIDE[it.name] || it.name) : it.name;
  const descTxt = state.lang === "zh" ? (it.zhDesc || it.description) : it.description;
  const faved = !!FAVS[it.link];
  const favDropped = currentFavDrops.has(it.link);
  const dropped = currentDrops.has(it.link);
  const flame = favDropped ? `<span class="flame fav-flame">⭐ 降價</span>` : (dropped ? `<span class="flame">🔥 降價</span>` : "");
  const descLine = descTxt ? `<p class="desc">${esc(descTxt)}</p>` : "";
  // 同時顯示兩代商城時，卡片上標註屬於哪一代（只選一代時不必重複標）
  const gameTag = state.game === "all"
    ? `<span class="game-tag g${it.game}">${it.game === "PoE2" ? "POE 2" : "POE 1"}</span>`
    : "";
  // 跨代可用性 chip：依 server.js 的 crossCompat 規則（技能特效 = 該代限定；其他 = 跨代通用）
  const cc = it.crossCompat || { tag: "跨代通用", level: "both", tooltip: "" };
  const compatTag = `<span class="compat-tag c${cc.level}" title="${esc(cc.tooltip || "")}">${esc(cc.tag)}</span>`;
  return `
  <article class="card">
    <div class="thumb">
      <span class="badge">-${it.offPct}%</span>
      ${flame}
      <img loading="lazy" src="${esc(it.image)}" alt="${esc(nameTxt)}"
           onerror="this.classList.add('broken')">
    </div>
      <div class="body">
      <a class="name" href="${esc(it.link)}" target="_blank" rel="noopener">${esc(nameTxt)}</a>
      <div class="tags">
        <span class="cat-tag">${esc(it.category)}</span>
        ${compatTag}
        ${gameTag}
        ${faved ? `<span class="fav-tag">⭐ 已收藏</span>` : ""}
      </div>
      ${descLine}
      <div class="price-row">
        <div class="price">
          <span class="now">${it.price.discount}<small>點</small></span>
          <span class="was">${it.price.original} 點</span>
        </div>
        <button class="fav-btn ${faved ? "on" : ""}" data-link="${esc(it.link)}" data-name="${esc(it.name)}" title="${faved ? "取消收藏" : "收藏"}">${faved ? "★" : "☆"}</button>
      </div>
      <div class="save">省 ${save} 點</div>
      <div class="links">
        <a class="buy" href="${esc(it.link)}" target="_blank" rel="noopener">前往購買 →</a>
        <a class="wiki" href="https://www.poewiki.net/wiki/Special:Search?search=${encodeURIComponent(it.name)}" target="_blank" rel="noopener" title="在流放之路編年史 (PoE Wiki) 搜尋此物品">📖 編年史</a>
      </div>
    </div>
  </article>`;
}

// 兩個商城的區塊標題資訊
const GAME_META = {
  PoE2: { label: "流放之路 2 商城", icon: "⚔️", host: "pathofexile2.com" },
  PoE1: { label: "流放之路 1 商城", icon: "🗡️", host: "pathofexile.com" },
};

function render() {
  const list = applyFilter();
  countEl.textContent = `共 ${list.length} 項`;
  if (!list.length) {
    if (state.cat === "__fav") {
      grid.innerHTML = `<div class="empty">你還沒有收藏任何商品 🌟<br>點卡片價格區的 ☆ 即可收藏，收藏後會在這裡一次看齊</div>`;
    } else {
      grid.innerHTML = `<div class="empty">沒有符合條件的物品 🥲</div>`;
    }
    return;
  }
  // 「全部商城」時依代分區顯示（PoE2 在前、PoE1 在後），各區自帶標題列
  if (state.game === "all") {
    const parts = [];
    for (const g of ["PoE2", "PoE1"]) {
      const sub = list.filter((it) => it.game === g);
      if (!sub.length) continue;
      const m = GAME_META[g];
      parts.push(
        `<div class="board-head ${g.toLowerCase()}">` +
          `<span class="bh-title">${m.icon} ${m.label}</span>` +
          `<span class="bh-meta">${sub.length} 項 · ${m.host}</span>` +
        `</div>` + sub.map(cardHTML).join("")
      );
    }
    grid.innerHTML = parts.join("");
    return;
  }
  grid.innerHTML = list.map(cardHTML).join("");
}

async function load() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "↻ 刷新中…";
  try {
    const r = await fetch("/api/items", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    ALL = data.items || [];
    window.__itemsCache = ALL;          // 供倒計時取用官方的精確特價結束時間
    window.__sourceNote = data.sourceNote || "";
    // 來源完全掛掉且無任何資料：顯示友好提示
    if (data.error && !ALL.length) {
      updatedEl.textContent = "來源暫時無法連線，請稍後再試";
      grid.innerHTML = `<div class="empty">📡 來源暫時無法連線，請稍後再試</div>`;
      return;
    }
    const base = `更新於 ${fmtDate(data.date)}` + (ALL.length ? ` · ${ALL.length} 項` : "");
    if (data.stale) {
      // 上游掛掉但有舊快取 / 備用快照：照常顯示，並標註來源異常
      updatedEl.textContent = data.fromFallback
        ? `📦 主源離線，顯示倉庫內備用快照（${fmtDate(data.date)}）`
        : `⚠️ 來源暫時無法連線，顯示 ${fmtDate(data.date)} 的資料`;
      updatedEl.style.color = "var(--red)";
    } else {
      updatedEl.textContent = base;
      updatedEl.style.color = "";
    }
    const alerts = detectAlerts(ALL);
    currentDrops = renderAlerts(alerts);
    const favAlerts = detectFavAlerts(ALL);
    currentFavDrops = new Set(favAlerts.map((a) => a.key));
    renderFavAlerts(favAlerts);
    renderCats();
    render();
  } catch (e) {
    updatedEl.textContent = "來源暫時無法連線，請稍後再試";
    if (!ALL.length) grid.innerHTML = `<div class="empty">📡 暫時無法取得即時資料，請稍後再試。</div>`;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "↻ 刷新";
  }
}

// ===== 事件 =====
searchEl.addEventListener("input", (e) => { state.q = e.target.value.trim(); render(); });
document.getElementById("sortBy").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.sort = b.dataset.sort;
  [...e.currentTarget.children].forEach((x) => x.classList.toggle("active", x === b));
  render();
});
langToggle.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.lang = b.dataset.lang;
  [...langToggle.children].forEach((x) => x.classList.toggle("active", x === b));
  render();
});
gameToggle.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.game = b.dataset.game;
  [...gameToggle.children].forEach((x) => x.classList.toggle("active", x === b));
  // 若目前分類在新商城裡不存在，退回「全部」：否則會空結果、又沒有任何標籤亮起，看起來像壞掉
  if (state.cat !== "all" && state.cat !== "__fav") {
    const stillExists = ALL.some(
      (it) => (state.game === "all" || it.game === state.game) && it.category === state.cat
    );
    if (!stillExists) state.cat = "all";
  }
  renderCats(); // 分類數量要跟著商城重算
  render();
});
catsEl.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.cat = b.dataset.cat;
  [...catsEl.children].forEach((x) => x.classList.toggle("active", x === b));
  render();
});
bellEl.addEventListener("click", () => alertsEl.scrollIntoView({ behavior: "smooth" }));
clearAlertsBtn.addEventListener("click", () => {
  saveJSON(ALERTS_KEY, []);
  currentDrops = renderAlerts([]);
  render();
});
alertsBody.addEventListener("click", (e) => {
  const x = e.target.closest(".ai-x"); if (!x) return;
  const key = x.dataset.key;
  const alerts = loadJSON(ALERTS_KEY, []).filter((a) => a.key !== key);
  saveJSON(ALERTS_KEY, alerts);
  currentDrops = renderAlerts(alerts);
  render();
});

// ===== 收藏相關事件 =====
// 頂欄 ⭐ 鈴鐺 = 一鍵查看已收藏商品（在分類標籤「⭐ 收藏」之外，再多一個更顯眼的入口）
favBell.addEventListener("click", () => {
  state.cat = "__fav";
  renderCats();
  render();
  grid.scrollIntoView({ behavior: "smooth", block: "start" });
});
clearFavAlertsBtn.addEventListener("click", () => {
  saveJSON(FAVS_KEY_ALERTS, []);
  currentFavDrops = renderFavAlerts([]);
  render();
});
favAlertsBody.addEventListener("click", (e) => {
  const x = e.target.closest(".ai-x"); if (!x) return;
  const key = x.dataset.key;
  const alerts = loadJSON(FAVS_KEY_ALERTS, []).filter((a) => a.key !== key);
  saveJSON(FAVS_KEY_ALERTS, alerts);
  currentFavDrops = new Set(alerts.map((a) => a.key));
  renderFavAlerts(alerts);
  render();
});
grid.addEventListener("click", (e) => {
  const fb = e.target.closest(".fav-btn"); if (!fb) return;
  const link = fb.dataset.link;
  if (FAVS[link]) { delete FAVS[link]; }
  else { const it = ALL.find((x) => x.link === link); if (it) FAVS[link] = { name: it.name, discount: it.price.discount, original: it.price.original, offPct: it.offPct, ts: Date.now() }; }
  saveFavs(FAVS);
  // 取消收藏時，一併移除其收藏折扣提醒
  const fa = loadJSON(FAVS_KEY_ALERTS, []).filter((a) => a.key !== link);
  saveJSON(FAVS_KEY_ALERTS, fa);
  const on = !!FAVS[link];
  fb.classList.toggle("on", on);
  fb.textContent = on ? "★" : "☆";
  fb.title = on ? "取消收藏" : "收藏";
  const card = fb.closest(".card");
  if (card) {
    let tag = card.querySelector(".fav-tag");
    if (on && !tag) { const ct = card.querySelector(".cat-tag"); if (ct) { tag = document.createElement("span"); tag.className = "fav-tag"; tag.textContent = "⭐ 已收藏"; ct.insertAdjacentElement("afterend", tag); } }
    if (!on && tag) tag.remove();
  }
  currentFavDrops = new Set(fa.map((a) => a.key));
  renderFavAlerts(fa);
  renderCats();
  // 在「⭐ 收藏」視圖下取消收藏，卡片要立刻消失（否則會留著直到下次刷新）
  if (state.cat === "__fav") render();
});
refreshBtn.addEventListener("click", load);

// 每 5 分鐘自動刷新商品
setInterval(load, 5 * 60 * 1000);
// 倒計時每秒跳動
tickCountdown();
setInterval(tickCountdown, 1000);
load();
