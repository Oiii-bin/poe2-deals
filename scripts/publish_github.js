// -*- coding: utf-8 -*-
// publish_github.js — 把整個 poe2-deals 專案推上 GitHub（首次建倉或後續同步）
//
// 環境變數：
//   GITHUB_TOKEN  Personal Access Token (classic)，需勾 repo 權限
//   GH_OWNER      預設從 git remote 解析，解析不到才用 Oiii-bin
//   GH_REPO       預設 poe2-deals
//   GH_BRANCH     預設 main
//   GH_EMAIL      commit 信箱，預設 ID 型 noreply（不外洩真實信箱）
//
// 用法：
//   GITHUB_TOKEN=ghp_xxx node scripts/publish_github.js --init "初始提交"
//   GITHUB_TOKEN=ghp_xxx node scripts/publish_github.js "更新說明"
//
// ⚠️ 本機 git push 常被代理擋（CONNECT 502 或無限 hang），但 api.github.com 正常。
//    所以流程是：push 加 60s 逾時 → 失敗就改走 Git Data API（blobs→tree→commit→ref）。
//    ※ 不能用 Contents API 逐檔 PUT：GitHub 禁止經由它建立/更新 .github/workflows/*（回 404）。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const GIT = "C:\\Users\\loi\\.workbuddy\\binaries\\PortableGit\\versions\\1.2.0\\cmd\\git.exe";
const DIR = path.resolve(__dirname, "..");
const BRANCH = process.env.GH_BRANCH || "main";
const TOKEN = process.env.GITHUB_TOKEN;
const args = process.argv.slice(2);
const IS_INIT = args.includes("--init");
const MSG = args.filter((a) => a !== "--init")[0];

function git(a, opts) {
  return execFileSync(GIT, ["-C", DIR, ...a], { encoding: "utf8", ...(opts || {}) });
}

// ---- owner：優先用環境變數，否則從 remote 解析（帳號改名後才不會寫死舊名） ----
let OWNER = process.env.GH_OWNER || "";
if (!OWNER) {
  try {
    const url = git(["remote", "get-url", "origin"]).trim();
    const m = url.match(/github\.com[:/]([^/]+)\//);
    if (m) OWNER = m[1];
  } catch (e) {}
}
if (!OWNER) OWNER = "Oiii-bin";
const REPO = process.env.GH_REPO || "poe2-deals";
const EMAIL = process.env.GH_EMAIL || "329207111+Oiii-bin@users.noreply.github.com";
const DESC = "PoE1/PoE2 官方商城即時折扣彙整站（官方 API 優先 + 社群源補漏）";

const cleanUrl = `https://github.com/${OWNER}/${REPO}.git`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const HDR = {
  Authorization: "Bearer " + TOKEN,
  Accept: "application/vnd.github+json",
  "User-Agent": "poe2-deals-publish",
  "Content-Type": "application/json",
};

// ---------- 1) commit ----------
git(["add", "-A"]);
let hasCommit = true;
try { git(["rev-parse", "HEAD"], { stdio: "ignore" }); } catch (e) { hasCommit = false; }
let staged = "";
try { staged = git(["diff", "--cached", "--name-only"]).trim(); } catch (e) {}

if (staged) {
  git(["commit", "-q", "-m", MSG || (hasCommit ? "chore: update" : "Initial commit"),
       "--author", `${OWNER} <${EMAIL}>`]);
  console.log("✅ 已 commit：" + staged.split("\n").length + " 個檔案");
} else if (!hasCommit) {
  git(["commit", "-q", "-m", MSG || "Initial commit", "--author", `${OWNER} <${EMAIL}>`]);
  console.log("✅ 已 commit（初始）");
} else {
  console.log("ℹ️ 本機無變更");
}

async function ensureRepo() {
  if (!IS_INIT) return;
  const r = await fetch("https://api.github.com/user/repos", {
    method: "POST", headers: HDR,
    body: JSON.stringify({ name: REPO, description: DESC, private: false, auto_init: false }),
  });
  if (r.status === 201) console.log("✅ 倉庫已建立：" + OWNER + "/" + REPO);
  else if (r.status === 422) console.log("ℹ️ 倉庫已存在，直接推送");
  else throw new Error("建立倉庫失敗 " + r.status + "：" + (await r.text()));
}

// ---------- 2) git push（逾時 60s）----------
async function tryPush() {
  const withTok = `https://${OWNER}:${TOKEN}@github.com/${OWNER}/${REPO}.git`;
  try { git(["remote", "remove", "origin"], { stdio: "ignore" }); } catch (e) {}
  git(["remote", "add", "origin", withTok]);
  try {
    const out = git(["push", "-u", "origin", BRANCH], { timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    console.log("✅ git push 成功");
    if (out) console.log(String(out).trim());
    return true;
  } catch (e) {
    console.log("⚠️ git push 失敗（" + String(e.message).split("\n")[0] + "）→ 改用 Contents API");
    return false;
  } finally {
    git(["remote", "set-url", "origin", cleanUrl]);   // token 絕對不能留在 .git/config
  }
}

// ---------- 3) Git Data API（blobs→tree→commit→ref）----------
//    ⚠️ 關鍵坑：GitHub 禁止經由任何 REST API 建立/更新 .github/workflows/*（安全限制，回 404），
//       且本機 github.com 被代理擋（git push 也走不通）→ workflow 檔挑出來手動加，
//       其餘檔案走 Git Data API；整棵 tree 替換（不帶 base_tree，避開空倉/commit-sha 的 404）。
async function pushViaApi() {
  const all = git(["ls-files"]).trim().split("\n").filter(Boolean);
  // workflow 檔：API 推不上去，挑出來最後提示手動加
  const wf = all.filter((f) => f.replace(/\\/g, "/").startsWith(".github/workflows/"));
  const files = all.filter((f) => !wf.includes(f));

  // 1) 目前 main HEAD（不存在則做 root commit）
  let parentSha = null;
  try {
    const r = await fetch(`${API}/git/refs/heads/${BRANCH}`, { headers: HDR });
    if (r.ok) parentSha = (await r.json()).object.sha;
  } catch (e) {}

  // 2) 每個非 workflow 檔建立 blob
  const entries = [];
  for (const f of files) {
    const rel = f.replace(/\\/g, "/");
    const raw = fs.readFileSync(path.join(DIR, rel));
    const b = await fetch(`${API}/git/blobs`, {
      method: "POST", headers: HDR,
      body: JSON.stringify({ content: raw.toString("base64"), encoding: "base64" }),
    });
    if (!b.ok) throw new Error(rel + " blob 失敗 " + b.status + "：" + (await b.text()));
    entries.push({ path: rel, mode: "100644", type: "blob", sha: (await b.json()).sha });
  }

  // 3) 建立 tree（整棵替換，不帶 base_tree）
  const t = await fetch(`${API}/git/trees`, {
    method: "POST", headers: HDR, body: JSON.stringify({ tree: entries }),
  });
  if (!t.ok) throw new Error("tree 失敗 " + t.status + "：" + (await t.text()));
  const treeSha = (await t.json()).sha;

  // 4) 建立 commit
  const c = await fetch(`${API}/git/commits`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ message: MSG || "chore: update", tree: treeSha, parents: parentSha ? [parentSha] : [] }),
  });
  if (!c.ok) throw new Error("commit 失敗 " + c.status + "：" + (await c.text()));
  const commitSha = (await c.json()).sha;

  // 5) 更新 ref（不存在就建）
  const refUrl = `${API}/git/refs/heads/${BRANCH}`;
  let refR = await fetch(refUrl, { headers: HDR });
  if (refR.ok) {
    refR = await fetch(refUrl, { method: "PATCH", headers: HDR, body: JSON.stringify({ sha: commitSha, force: true }) });
  } else {
    refR = await fetch(`${API}/git/refs`, { method: "POST", headers: HDR, body: JSON.stringify({ ref: "refs/heads/" + BRANCH, sha: commitSha }) });
  }
  if (!refR.ok) throw new Error("ref 更新失敗 " + refR.status + "：" + (await refR.text()));
  console.log(`✅ Git Data API 推送完成：${files.length} 個檔案（commit ${commitSha.slice(0, 7)}）`);

  // 6) workflow 檔無法經由 API 推送
  if (wf.length) {
    console.log("\n⚠️ 以下 workflow 檔無法經由 API 推送（GitHub 禁止經由 REST API 建立/更新 .github/workflows/*，且本機 github.com 被代理擋）：");
    for (const f of wf) console.log("   - " + f);
    console.log("   請改用 GitHub 網頁 UI 貼上，或在本機（github.com 可連線時）執行 git push。");
  }
  return true;
}

// ---------- 4) API 推送後要對齊本地 refs ----------
// API commit 不在本地歷史，且本環境 git fetch 常常沒真的寫出 refs/remotes/origin/<branch>
// → 手動補寫 ref 再 reset，否則下次 git status 會變成 [gone]
function alignLocal() {
  git(["fetch", "origin", BRANCH], { stdio: "ignore" });
  let sha = null;
  const fh = path.join(DIR, ".git", "FETCH_HEAD");
  if (fs.existsSync(fh)) {
    const m = fs.readFileSync(fh, "utf8").match(/^[0-9a-f]{40}/);
    if (m) sha = m[0];
  }
  if (!sha) { console.log("⚠️ 讀不到遠端 sha，跳過 refs 對齊"); return; }
  const refDir = path.join(DIR, ".git", "refs", "remotes", "origin");
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(path.join(refDir, BRANCH), sha + "\n");
  try { git(["update-ref", `refs/remotes/origin/${BRANCH}`, sha], { stdio: "ignore" }); } catch (e) {}
  git(["reset", "--hard", sha], { stdio: "ignore" });
  console.log("✅ 本地已對齊遠端 " + sha.slice(0, 7));
}

(async () => {
  if (!TOKEN) {
    console.log("⚠️ 未設定 GITHUB_TOKEN，只完成本機 commit。\n   手動推送：git -C \"" + DIR + "\" push -u origin " + BRANCH);
    return;
  }
  await ensureRepo();
  const ok = await tryPush();
  if (!ok) { await pushViaApi(); alignLocal(); }
  console.log("\n🚀 https://github.com/" + OWNER + "/" + REPO);
  console.log("📦 https://cdn.jsdelivr.net/gh/" + OWNER + "/" + REPO + "@" + BRANCH + "/fallback.json");
  console.log("⚙️  Actions：https://github.com/" + OWNER + "/" + REPO + "/actions");
})().catch((e) => { console.error("❌ " + e.message); process.exit(1); });
