# PoE2 商城折扣站

流亡黯道（Path of Exile 1 / 2）官方商城「特價中」商品的即時彙整站。

- **線上站點**：https://ce400e38d7244c9089e003969e927ddf.app.workbuddy.link
- 零依賴（純 Node 內建模組），`node server.js` 即可跑

## 資料來源

**官方優先、社群補漏、兩者聯集** —— 任何一源掛掉都不影響另一源。

| 來源 | 端點 | 說明 |
|---|---|---|
| 官方 PoE2 商城 API | `https://pathofexile2.com/api/shop-microtransactions?game=poe2` | 644 件、公開免登入、支援 `If-Modified-Since`/304，帶 `special:{start,end}` 精確起訖 |
| 官方 PoE1 特價頁 | `https://www.pathofexile.com/shop/category/specials` | SSR 頁面，內嵌 `new Category({items:[...]})`，補 PoE1 專屬外觀 |
| 社群源 | `https://poe.usaginest.com/poe2_special.json` | 補官方漏掉的「組合包內容物拆件」，也是官方全掛時的保底 |

實測：官方聯集 93 件，再加社群補漏共 **98 件**，對社群源的覆蓋率達 100%。
（`game=poe1` 的這個 API 會回 503，所以 PoE1 只能走 SSR 頁面。）

## 檔案結構

```
server.js            後端：抓源 → 正規化（分類/折扣/跨代可用性）→ /api/items、/api/diag
scrape_official.js   零依賴官方爬蟲，也可單獨跑：node scrape_official.js -o fallback.json
app.js               前端：卡片網格、遊戲過濾、搜尋、排序、倒計時、降價提醒
index.html / style.css
fallback.json        備用快照（Actions 自動刷新），主源全掛時回退
translations.cache.json  翻譯快取（不進版控）
.github/workflows/   refresh-fallback.yml（刷新快照） / health-check.yml（每日體檢）
scripts/publish_github.js  推上 GitHub（含 push 失敗改走 Contents API 的備援）
```

## 本機啟動

```bash
node server.js            # 預設 http://localhost:8787
PORT=3000 node server.js  # 換埠
```

- `/api/items` — 商品資料
- `/api/diag` — 診斷：列出各外部來源的連線結果與耗時（站上顯示備用快照時先看這個）

## 自動維護

推送到 GitHub 並啟用 Actions 後：

- `refresh-fallback.yml`：每 6 小時跑 `scrape_official.js` 並聯集社群源，內容有變才 commit
- `health-check.yml`：每日體檢官方兩個源與線上站點，任一異常就讓 workflow 失敗（GitHub 會寄信）

> ⚠️ GitHub 對 **60 天無活動**的倉庫會自動停用排程 Actions；有推送就不會被停。

## 跨代可用性標註

- 技能特效（依附該代寶石圖示）→ 該代限定
- 其餘 MTX（武器/裝備外觀、藏身處、傳送門、寵物…）→ 帳號綁定，PoE1 / PoE2 互通
