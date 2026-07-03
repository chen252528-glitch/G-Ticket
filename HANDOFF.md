# HANDOFF — Discord Slash Commands 部署備忘

> 寫給接手的 Claude（以及未來的自己）。上一個工作階段（2026-07-03，公司電腦）已完成所有程式碼，
> 剩下的步驟需要本人的 Discord / Cloudflare / GitHub 帳號，所以留到家裡做。
> 使用者偏好繁體中文。

## 這個專案是什麼

flight-price-radar：監控機票價格（SerpApi/Google Flights + RSS 特價源 + LLM 抽取），
資料存 Turso，透過 Discord Webhook 發通知，GitHub Actions 排程執行。
新加入的 `discord-interactions/` 是一個 Cloudflare Worker，讓使用者能在 Discord 用
slash commands 雙向互動（查價、管理航線、手動觸發掃描）。

## 程式碼位置

- 完整程式碼（含 2026-07-03 的所有修改：bug 修正 + Discord Worker + 60 天平均值功能）已推上
  **git@github.com:chen252528-glitch/G-Ticket.git**。回家直接 clone 這個 repo 即可。
- 注意：是 **G-Ticket**，不是原本 flight-radar 的舊 repo — 舊 repo 缺少所有新修改。
- push 到 main 會自動觸發 CI workflow（typecheck + build + test）；排程的掃描 workflow 會開始執行，
  但在 GitHub Secrets 設定好之前會失敗，屬正常現象（Secrets 清單見主 README）。

## 目前狀態（已驗證）

| 項目 | 狀態 |
|---|---|
| 主專案 `npm run typecheck` / `npm run build` | ✅ 通過 |
| 主專案 `npm test` | ✅ 17/17 通過 |
| Worker `npm run typecheck`（discord-interactions/） | ✅ 通過 |
| Worker `npx wrangler deploy --dry-run` 打包 | ✅ 成功（162 KiB） |
| 實際部署 + Discord 串接 | ❌ 未做 — 就是這次的待辦 |

註：公司電腦沒有安裝 Node.js（驗證時是用 scratchpad 裡的可攜式 Node 22 跑的）。家裡機器需要 Node 20+。

## 待辦步驟（依序）

### 0. 環境準備

```bash
# 主目錄
npm install
npm run build
npm test        # 應該 17/17 通過

# Worker
cd discord-interactions
npm install
```

### 1. 建立 Discord Application

1. https://discord.com/developers/applications → **New Application**
2. **General Information** 頁記下：**Application ID**、**Public Key**
3. **Bot** 頁記下：**Token**（只用來註冊指令）
4. **Installation**（或 OAuth2 → URL Generator）把 app 以 `applications.commands` scope 裝進自己的伺服器

### 2. 部署 Cloudflare Worker

```bash
cd discord-interactions
npx wrangler login                              # 開瀏覽器登入 Cloudflare

npx wrangler secret put DISCORD_PUBLIC_KEY      # 貼上步驟 1 的 Public Key
npx wrangler secret put DATABASE_URL            # 與主程式相同的 libsql:// URL（在主程式 .env 或 GitHub Secrets 裡）
npx wrangler secret put DATABASE_AUTH_TOKEN     # Turso token
npx wrangler secret put GITHUB_TOKEN            # 選配，/scan 用（見步驟 5）

# 先編輯 wrangler.toml：GITHUB_REPOSITORY 填 "帳號/repo名"（/scan 用）
npm run deploy                                  # 記下印出的 workers.dev URL
```

### 3. 把 Worker 接上 Discord

Discord app 的 **General Information** → **Interactions Endpoint URL** 貼上 Worker URL → Save。
Discord 會發一個簽了名的 PING 驗證；存檔失敗幾乎都是 `DISCORD_PUBLIC_KEY` 貼錯。

### 4. 註冊 slash commands

```bash
cd discord-interactions
DISCORD_APPLICATION_ID=xxx DISCORD_BOT_TOKEN=xxx DISCORD_GUILD_ID=伺服器ID npm run register-commands
```

帶 `DISCORD_GUILD_ID`（在 Discord 對伺服器名稱右鍵 → 複製伺服器 ID，需開發者模式）指令**立即生效**；
不帶則註冊為 global，最多要等一小時。

### 5.（選配）讓 /scan 能觸發 GitHub Actions

1. GitHub → Settings → Developer settings → **Fine-grained personal access token**
2. 只授權這一個 repo，權限給 **Actions: Read and write**
3. `npx wrangler secret put GITHUB_TOKEN` 貼上
4. `wrangler.toml` 的 `GITHUB_REPOSITORY` 已填好 `chen252528-glitch/G-Ticket`，確認無誤後重新 `npm run deploy`

### 6. 測試

在 Discord 依序打：

1. `/track list` — 應列出資料庫中的追蹤航線（最快的煙霧測試）
2. `/price` 某條已追蹤航線 — 應回覆目前最低價 vs 60 天平均、便宜/溢價判定
3. `/status` — 各 job 上次執行紀錄
4. `/scan normal-fares` —（若設了步驟 5）應回覆 GitHub Actions 連結

除錯時開著 `npx wrangler tail` 看即時 log。

## 疑難排解速查

| 症狀 | 原因 / 解法 |
|---|---|
| Interactions Endpoint URL 存檔失敗 | `DISCORD_PUBLIC_KEY` secret 錯誤或 Worker 沒部署成功 |
| 指令在 Discord 看不到 | global 註冊要等最多 1 小時 → 改用 `DISCORD_GUILD_ID` 重跑註冊 |
| `/price` 說 no fare observations | 該航線還沒掃過 → `/scan normal-fares` 或等排程 |
| `/price` 說 not enough history | 正常 — 60 天平均需要至少一天「最新掃描日以前」的資料，多掃幾天就有 |
| `/scan` 說 not configured | `GITHUB_TOKEN` secret 或 `wrangler.toml` 的 `GITHUB_REPOSITORY` 沒設 |
| 指令回 ⚠️ Command failed | `npx wrangler tail` 看實際錯誤（多半是 DATABASE_URL/TOKEN 錯） |

## 程式碼地圖（給 Claude）

- `discord-interactions/README.md` — 完整英文版設定說明（與本檔內容一致，更詳細）
- `discord-interactions/src/index.ts` — 入口：Ed25519 驗簽 → PING 回 PONG → 指令先回 deferred 再補結果
- `discord-interactions/src/handlers.ts` — 四個指令的邏輯；`/price` 的判定門檻 ±5% 在 `PRICE_VERDICT_BAND_PERCENT`
- `discord-interactions/src/turso.ts` — 所有 SQL 查詢（60 天平均 = 每日最低價的平均，排除最新掃描日）
- `discord-interactions/scripts/register-commands.mjs` — 指令定義與註冊
- 主程式對應功能：`src/db/repositories.ts` 的 `getAverageDailyLowFare`、`src/notifications/normal-fare-embed.ts` 的平均值顯示行
- 主專案說明：`README.md`（環境變數、部署）、`docs/architecture.md`

## 安全提醒

- 所有 token / key 只放 `wrangler secret` 和本機 `.env`，**不要**寫進任何會 commit 的檔案（`.dev.vars` 與 `.env` 已在 .gitignore）。
- 伺服器裡看得到指令的人都能使用；要限制的話在 Discord「伺服器設定 → 整合」對個別指令設權限。
