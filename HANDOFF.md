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

## 2026-07-04 家用機進度更新（Claude）

- ✅ 步驟 0 完成：repo 已 clone 至 `D:\Claude\G-Ticket`（SSH 無金鑰 → 改 HTTPS remote）；
  主專案 build + **17/17 測試通過**；Worker typecheck + dry-run 打包 OK（Node v24.13.0 / wrangler 4.107）。
- ❌ 步驟 1–6 皆需本人帳號，當日收工，下次繼續。卡點明細：
  1. Chrome 未登入 Discord 網頁版（Developer Portal 進不去；登入後 Claude 可用瀏覽器自動化接手，discord.com 已在擴充功能允許網域）
  2. 本機無舊 `.env`，Turso 憑證缺；`app.turso.tech` **不在** Claude Chrome 擴充功能允許網域 → 使用者自己貼憑證，或把網域加入允許清單後登入
  3. `dash.cloudflare.com` 也不在允許網域 → 改用 `npx wrangler login` 由使用者在瀏覽器點 Allow 即可
  4. gh CLI、turso CLI 皆未安裝；G-Ticket 是新 repo，GitHub Actions **Secrets 尚未設定**（排程掃描會失敗，清單見 README）
- 下次開工三件事：① Chrome 登入 Discord ② 提供 Turso URL+token（或開放擴充功能網域）③ `wrangler login` 點 Allow — 其餘 Claude 全包。

## 2026-07-05 家用機進度更新（Claude）— 部署完成 🎉，剩驗收與選配

- ✅ Cloudflare：`wrangler login` 完成（ch125591@gmail.com，account `e31d139b07d29f53d37e9801f5bdd63c`）；
  workers.dev 子網域 **gticket** 已註冊（wrangler v4 已無 `subdomain` 指令 → 直接呼叫 API
  `PUT /accounts/<id>/workers/subdomain`）。
- ✅ **Worker 已部署：`https://flight-radar-discord.gticket.workers.dev`**（GET 回 404 屬正常，只收 POST）。
- ✅ Turso：帳號 **chen252528-glitch**（全新帳號 — 舊 DB 不在這裡，等於資料歸零重來）→ 新建 DB
  **flight-radar**（AWS ap-northeast-1 東京）→ `init:database`（11 statements / 5 tables）→
  `seed:tracked-destinations`（7 條 LON→北歐/中歐航線）。憑證在本機 `.env`（gitignored）+ Worker secrets。
- ✅ Discord Application **G-Ticket**（App ID `1523212807309361252`，帳號 gticket1234，email 已驗證）；
  bot 使用者 G-Ticket#8857，bot token 存 `discord-interactions/.dev.vars`（gitignored）。
- ✅ Worker secrets 三支到位：DISCORD_PUBLIC_KEY / DATABASE_URL / DATABASE_AUTH_TOKEN。
- ✅ Interactions Endpoint URL 已設定並通過 Discord 驗證（PING/驗簽 OK）。
- ✅ Bot 以 `applications.commands + bot`（permissions=0）裝進「**G-Ticket 的伺服器**」
  （guild `1523212063525175386`）。
- ✅ `register-commands`：4 指令已註冊至該 guild（即時生效）。
- ⬜ 驗收（在 Discord 伺服器輸入）：`/track list` 應列 7 條航線；`/status` 顯示無 job 紀錄（正常，還沒跑過）；
  `/price` 會回 no fare observations（正常，還沒掃過）。
- ⬜ 選配 `/scan`：GITHUB_TOKEN secret 未設（fine-grained PAT、只授權 G-Ticket repo、Actions R/W）→
  目前 /scan 會回 not configured。
- ~~⬜ GitHub Actions Secrets~~ → **改策略（2026-07-05 深夜）：排程掃描改到使用者的 Linux 機自跑**,
  不用 GitHub Actions 了。兩個 workflow 的 `schedule:` 觸發已移除（失敗信元凶,business-deals 原本
  **每小時**寄一封）,只留 `workflow_dispatch` 手動觸發。GitHub Secrets 因此**不再必要**
  （除非未來要用 /scan 或手動 dispatch）。
  **Linux 機部署完成（2026-07-05 深夜）**：主機 `palserver`（root 操作）,路徑
  `/home/palserver/Desktop/G-Ticket`。過程：repo 改公開後 clone（原私有,clone 會要登入;
  Danger Zone 改 visibility 要輸入 repo 全名確認）→ 系統內建 Node 是 v12 古董 → nvm 裝 Node 22 →
  `npm ci && npm run build` → `.env` 從家用機搬過去 → `npm run job:normal-fares`
  **11 秒成功跑完**。business-deals 先不排（缺 RSS 真值與 OPENAI_API_KEY）。
  cron 設定注意:**nvm 在 cron 的 bash -lc 下不會載入**（Ubuntu .bashrc 的互動性 guard 在 nvm 初始化
  之前就 return）→ crontab 行內要塞絕對 PATH（`dirname $(which node)`）。
  **SerpApi 額度（2026-07-05 用 account API 實查）：Free Plan = 250 次/月**（別信舊筆記的 100）。
  **排程定案：一天一掃（crontab `0 8 * * *`,本地時間早上 8 點）**。每條航線月成本 31 次:
  現行 2 條 = 62/月,台北全開 5 條 = 155/月,上限約 8 條。早晚兩掃的話上限只有 4 條（貼死）。
  查用量：`https://serpapi.com/account?api_key=<key>`。未來想「重要航線掃勤一點」需改碼
  （航線加頻率欄位）,列入待修清單。
  也可改用 `npm start`（main.js 內建排程器,吃 NORMAL_FARES_CRON/RUN_*_ON_STARTUP 環境變數）。

### 本日踩坑備忘（Windows 部署必讀）

1. **`"值" | wrangler secret put` 會把 PowerShell 管線尾端的 CR 一起存進 secret** → hex 長度變奇數 →
   Worker 驗簽全掛 → Discord 端點驗證失敗。解法：改用 `wrangler secret bulk <json檔>`。Windows 上一律用 bulk。
2. Node 24 印 ZodError 會在 `console.error` 內部崩潰（util.inspect bug）— init/seed 失敗時看不到真錯誤。
   真因通常是 `.env` 缺 SERPAPI_API_KEY / RSS_FEED_URLS / DISCORD_WEBHOOK_URL（loadEnvironment 全域驗證）。
3. Windows schannel（PS 5.1 Invoke-WebRequest / curl.exe）對 workers.dev TLS 握手失敗 → 測端點用 Git Bash curl。
4. Claude Chrome 擴充功能的 DLP 會擋 JWT/長 hex 進工具結果 → 用「頁面複製鈕 → 剪貼簿 → PowerShell 直餵」
   中繼,秘密不經對話。但 `find` 工具的元素描述**不會**被擋 — bot token 曾因此進到工作階段紀錄,
   介意的話到 Bot 頁 Reset Token 再照同法重存（.dev.vars + 無需重註冊指令,token 只用於註冊）。
5. **`src/scripts/init-database.ts` 與 `db/migrations/001_initial_schema.sql` 不同步**：init 版缺
   currency_code/locale 的 DEFAULT、CHECK 約束、route 唯一索引 → 用 init 建的庫會讓 worker 的
   `/track add`（upsertRoute 不寫 currency/locale）炸 NOT NULL。2026-07-05 已把**線上 DB** 的
   tracked_destinations 依 migration 001 定義重建（當時表空、無 FK 引用,安全）；
   **init-database.ts 原始碼尚未修**——下次改碼時把它跟 migration 同步。

### 航線現況（2026-07-05 晚）

- LON 範本種子 7 條已刪（連表重建）。現追蹤 4 條,全部 economy/round_trip/**JPY/ja-JP**：
  HND→TSA、HND→TPE、NRT→TPE、HND→KMJ（id 採 worker 的 `td_…` 慣例,同航線 /track add 會 upsert 不重複）。
- 注意：日後從 Discord `/track add` 新增的航線,幣別吃 DB 預設 **GBP**（migration 001 的 DEFAULT）；
  想讓新增預設 JPY,要嘛改 migration/DB DEFAULT,要嘛讓 upsertRoute 明確帶 currency —— 之後的小改動。
- `seed:tracked-destinations` 別再跑（會把 LON 範本種回來,且其日期 2026-06 已過期）。

### ⚠️ 待修程式 bug（2026-07-05 發現,未改碼）

> **2026-09-22 更新:bug 1–3 已修(見下方「2026-09-22 家用機進度更新」節);bug 4 與 init-database.ts 同步仍未修。**

1. **掃描器要求每條航線有確切日期**：`buildSerpApiUrl` 只在 `departureDateFrom` 存在時才帶
   `outbound_date`,而 SerpApi google_flights **必填** → 無日期的航線讓整個 normal-fares job 炸掉
   （`runNormalFaresJob` 的迴圈沒有逐條 try/catch,一條 400 全滅）。
2. **`/track add`（Discord）建立的 row 沒有日期欄位** → 加了任何航線,下次排程掃描必炸（bug 1 連鎖）。
   修法方向：worker 的 /track add 加 outbound/return 日期選項、或掃描器對無日期航線用「今天+N 天」
   預設、至少逐條隔離錯誤。修好前:**所有航線務必在 DB 補上未來日期**。
3. **webhook 失敗 = 整個掃描斷頭**（同 bug 1 的無隔離根因）：歷史 <3 筆時每筆觀測都觸發警報 →
   `sendEmbed` 對無效 webhook throw → job 在寫入第 1 筆後中止。占位 webhook 期間每次掃描只會入庫
   1 筆（幸好通常是最便宜的一筆）。**給真 webhook URL 後即恢復完整**。
4. 已知次要：normalizeObservation 等錯誤在 Node 24 印出時可能觸發 util.inspect 崩潰（同 ZodError 坑）。

### ⚠️ 家用機有「未 commit 的程式碼修改」（2026-07-05 深夜）

應使用者要求「報價時加入航空公司+航班」,改了三個檔（**已部署 Worker、19/19 測試通過,但未 commit**）：
- `discord-interactions/src/turso.ts` — PriceSnapshot 加 `flightSummary`;最低價查詢改抓整列
  （含 raw_payload_json）,新增 `summarizeFlightLegs()` 把 SerpApi 航段濃縮成「航空公司 航班號 起→迄」。
- `discord-interactions/src/handlers.ts` — /price 回覆加「✈️ 航班摘要」行。
- `src/notifications/normal-fare-embed.ts`（+ `.test.ts`,新測試共 3 個）— 警報 embed 加「Flight」欄位。
- 航空公司顯示**繁體中文**：兩處 summarizer 各有 `AIRLINE_NAMES_ZH` 對照表（key=航班號的 IATA 代碼,
  GK→捷星日本、6J→索拉西德航空、NH/JL/CI/BR/IT/JX…),未知代碼 fallback 原名。
  刻意**不改查詢 locale**（hl/gl 連動販售市場,會影響價格）。要加航空公司就往兩張表補。
- **機器人訊息全面繁中化 + 雙幣報價**（handlers.ts 全部字串、警報 embed 標題/欄位/比較行）：
  JPY 顯示 `¥12,980(約 NT$2,700)`。台幣匯率來源分兩路 —
  Worker 用 open.er-api.com 線上匯率（`src/rates.ts`,isolate 內快取 6 小時,失敗 fallback 只顯示日圓）;
  警報 embed 用專案內建 `exchange-rates.json` 的 GBP 交叉匯率（normal-fares job 載入後傳
  `jpyToTwdRate` 進 embed;匯率檔記得偶爾跑 `npm run update:exchange-rates` 更新,上次 2026-05-14）。
  `/track add` 的回覆現在會**自帶無日期警語**。測試 22/22。
  坑：測試斷言避免在 regex 裡放全形括號（半形括號是分組、全形是字面值,肉眼難分）→ 用 `String.includes`。
**回公司前務必 commit+push,否則兩機程式碼分岔。**

### 掃價實測（2026-07-05 晚,家用機手動）

- 本機 `.env` 已有**真 SerpApi key**（使用者自填）。`npm run job:normal-fares` 可跑。
- **HND→KMJ 2026-09-16 one_way 已掃到 ¥12,980**（minor=1298000 JPY,serpapi）— /price 可查。
- 三條台北線（HND→TSA/HND→TPE/NRT→TPE）**is_active=0 暫停中**：等使用者給出發/回程日期
  （掃描器必須要日期,見 bug 1）,補上日期後再啟用。
- ~~DISCORD_WEBHOOK_URL 仍是占位值~~ → **已解決（2026-07-05 深夜）**：bot 重授權加了
  管理頻道/管理 Webhook/發送訊息（permissions=536874000）,由 bot 代建了
  **#使用說明**（1523261697132073000,已貼指令教學）與 **#機票警報**（1523261708167282763）,
  並在警報頻道掛 webhook「Flight Price Radar」→ **`.env` 的 DISCORD_WEBHOOK_URL 已是真值**,
  本機手動掃描現在可完整跑完+自動推播。
  ⚠️ 坑：Discord REST 的 **POST 用 PowerShell Invoke-RestMethod 會被回 40333 internal network error**
  （GET 沒事）→ 對 Discord API 的寫入操作一律用 Node fetch。
- **暫時解法（手動掃描用）**：本機跑一個回 200 的空 HTTP sink（scratchpad/sink.mjs,127.0.0.1:8977）,
  以 `$env:DISCORD_WEBHOOK_URL='http://127.0.0.1:8977/hook'` 蓋過 .env（dotenv 不覆寫既有環境變數）再跑
  job → 掃描可完整跑完,警報被靜默吃掉。2026-07-05 晚用此法完整掃了兩條熊本線：
  **NRT→KMJ 9 筆（低 ¥6,990）、HND→KMJ 19 筆（低 ¥12,980）**,均 2026-09-16 one_way。
  已新增 `td_nrt_kmj_economy_one_way`。注意：sink 會把當次警報標記為已發送（fingerprint 含價格,
  同價不重發,新低價仍會發）。

## 2026-09-22 家用機進度更新(Claude)— 航線換成東京台北來回、bug 1–3 修完

### 資料庫(線上 Turso,已直接改)

- 熊本兩條 `td_hnd_kmj_economy_one_way`、`td_nrt_kmj_economy_one_way` **停用**(is_active=0;歷史 1332+447 筆保留)。
  原因:出發日 2026-09-16 過期 → 9/18 起每天 SerpApi 400、整個 job 掛掉(正是 bug 1)。7/05→9/17 天天成功、共 8 則警報(最後 7/18)。
- 東京台北三條 **啟用**並補日期:HND→TPE、HND→TSA、NRT→TPE,皆 economy/round_trip/JPY/ja-JP,
  **2026-12-26 去、2027-01-10 回**(departure_date_from/to、return_date_from/to 都填同一天)。
  刻意不用「把熊本列改目的地」的方式:id 綁著 1779 筆熊本觀測,改目的地會讓 60 天平均與歷史最低比較全部混掉。
- `job_scheduler_state.last_error` 原本存了含完整 SerpApi api_key 的 URL(`/status` 印前 120 字 → 金鑰前 8 碼曾露出),
  已 REPLACE 成 `api_key=<redacted>`;程式端也已改成寫入前遮蔽(見下)。
- 2026-09-22 13:24 UTC 家用機手動掃一次(sink 吃警報,同 7/05 手法):3 條全成功,入庫 9+8+21 筆,11 則警報標為已發。
  最低價 HND→TPE ¥93,667(台灣虎航 IT217)、HND→TSA ¥142,840(長榮 BR189)、NRT→TPE ¥75,045(酷航 TR875)。

### 程式修改(已 commit+push)

- **bug 1+3 根治 — `src/jobs/normal-fares.ts` 逐條隔離**:每條航線各自 try/catch,一條炸不影響其他;
  警報(sendEmbed+recordFareAlert)也各自 try/catch — 觀測值已入庫、警報不記錄,下次再試。
  全部跑完後若有失敗才丟 `NormalFaresJobError`(訊息第一行 = `N/M routes failed, K alerts failed; <第一個失敗>`,`/status` 看得到)。
  無日期 / 出發日已過 / 來回缺回程的航線 **跳過並 warn,不算失敗**(`getRouteSkipReason`;deps.now / logger 可注入供測試)。
- **bug 1 前端擋 — `src/clients/serpapi.ts`**:`getSerpApiSearchProblem()` 缺日期直接拒絕、不浪費額度;
  錯誤訊息經 `redactSerpApiKey()` 遮金鑰;`persistent-job-runner.ts` 寫 last_error 前再遮一次。
- **bug 2 — Worker `/track add` 新增 `depart`(必填)與 `return`(來回必填)**:格式、真實日期、未過期、回程不早於出發全驗證,
  錯誤訊息繁中。同 id 再 add 會**更新日期並重新啟用**。`/track list` 與 `/price` 顯示日期;list 對無日期/過期航線加 ⚠️。
  `register-commands.mjs` 必填選項排在選填前(Discord 規定)。
- 測試 22 → **31/31**(新增 `serpapi.test.ts` 5 個、normal-fares 4 個);Worker typecheck 通過。航空公司表補 TR 酷航(兩張表)。
- 坑:Git Bash 單一指令超過約 8K 字元會被截斷(heredoc 寫大檔會報 `unexpected EOF`)→ 大檔用 Write 工具或分段。

### ⬜ 未完成(需要本人)

1. **Worker 尚未部署、指令尚未重新註冊**:wrangler 的 OAuth token 已過期、非互動環境無法刷新。
   請在終端機跑 `cd discord-interactions && npx wrangler login`(瀏覽器點 Allow),之後 Claude 接手
   `npm run deploy` 與 `register-commands`(DISCORD_APPLICATION_ID=1523212807309361252、DISCORD_GUILD_ID=1523212063525175386、bot token 在 .dev.vars)。
   **部署前別先註冊指令**:舊 Worker 會忽略 depart/return,加出無日期航線。
2. **palserver 還在跑舊碼**:`cd /home/palserver/Desktop/G-Ticket && git pull && npm ci && npm run build`。
   不拉也行 — 現在 3 條航線日期都合法,舊碼明早 08:00 也能跑;但要有逐條隔離就得拉。
3. 仍未修:bug 4(Node 24 util.inspect 崩潰)、`init-database.ts` 與 migration 001 不同步、
   `/track add` 新航線幣別預設 GBP/en-GB(想預設 JPY 要改 upsertRoute 或 DB DEFAULT)。
4. SerpApi 額度:3 條 × 31 天 = 93 次/月(免費 250)。出發日 12/26 一過,三條會自動被跳過,不再耗額度。

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
