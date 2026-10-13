# LINE 料號比對機器人

在 LINE 輸入 MOSFET 料號（例如 `RH6E040BGTB1`），機器人會：

1. 用 **Gemini + Google 搜尋** 上網查詢該料號的參數（極性、VDSS、ID、RDS(on)、Qg、Ciss、封裝尺寸）
2. 和 Google 試算表中的 Toshiba 料號清單（`docs/param_304_en (2).xlsx`）比對
3. 回覆最相近的前 5 個料號與相似度

需要上網查詢時，機器人會先回「🔎 已開始上網查詢」，約 10~30 秒後輸入 **「結果」**（或再傳一次料號）就會看到比對結果。全程只用 reply，不用 push，不計入 LINE 訊息額度。

```
🔎 RH6E040BGTB1（ROHM）
N-ch｜30V｜125A｜Rds 2.9mΩ@10V / 4.4mΩ@4.5V
📦 HSMT8 (3.3×3.3×0.8mm)

✅ 最相近的料號：
1. TPN2R903PL　相似度 97%
...
3. TPN2R203NC　相似度 87%
   N-ch｜30V｜100A｜Rds 2.2mΩ@10V / 3.6mΩ@4.5V｜Qg 34nC
   📦 TSON Advance (3.1×3.3×0.85mm)

〔查詢過程〕
📋 Toshiba 清單：沒有此料號
💾 查詢快取：沒有
🌐 上網查詢：Gemini + Google 搜尋
🔗 參數來源：rohm.com、mouser.com
⏱ 耗時 18 秒
🔗 Toshiba 官方對照（需登入）：
https://toshiba.semicon-storage.com/tw/search/cross-reference.2.EQUALS.all.RH6E040BGTB1.html
```

全部跑在 Google Apps Script 上，不需要自己架伺服器。

---

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `src/Code.gs` | LINE Webhook 入口、主流程、回覆格式、設定讀取 |
| `src/Gemini.gs` | 呼叫 Gemini 查參數、查詢結果快取 |
| `src/Catalog.gs` | 讀取試算表料號清單 |
| `src/Matcher.gs` | 參數比對與評分 |
| `src/appsscript.json` | Apps Script 專案設定 |
| `tests/run.js` | 本機測試比對邏輯：`node tests/run.js` |
| `tests/e2e_mock.js` | 模擬 LINE 完整流程：`node tests/e2e_mock.js` |
| `.github/workflows/deploy.yml` | CI/CD：推送到 main 自動測試並部署 |

---

## 安裝步驟

### 步驟 1：建立 Google 試算表 + Apps Script

1. 把 `docs/param_304_en (2).xlsx` 上傳到 Google 雲端硬碟。
2. 右鍵 →「選擇開啟工具」→「Google 試算表」，然後「檔案 → 另存為 Google 試算表」。
3. 在這個試算表上點「擴充功能 → Apps Script」。
4. 在 Apps Script 編輯器裡：
   - 把預設的 `程式碼.gs` 內容換成 `src/Code.gs`（檔名可改成 `Code`）。
   - 按「＋ → 指令碼」，新增 `Gemini`、`Catalog`、`Matcher` 三個檔案，分別貼上對應內容。
   - 左側「⚙ 專案設定」→ 勾選「在編輯器中顯示 appsscript.json」，再把內容換成 `src/appsscript.json`。

> 料號清單要更新時，直接改試算表即可，程式會自動讀取（快取 10 分鐘）。

### 步驟 2：申請 Gemini API Key

1. 到 <https://aistudio.google.com/apikey> 登入 Google 帳號。
2. 按「Create API key」，複製產生的 Key。

> **之後換成客戶（圈圈）的 Key：** 只要把下面步驟 4 的 `GEMINI_API_KEY` 改成客戶的值，不用改程式。

### 步驟 3：建立 LINE 官方帳號與 Messaging API

1. 到 <https://developers.line.biz/console/> 用 LINE 帳號登入。
2. 建立 Provider，再建立「Messaging API」Channel（會同時建立一個 LINE 官方帳號）。
3. 進入 Channel →「Messaging API」分頁：
   - 最下方「Channel access token (long-lived)」按「Issue」，複製 token。
   - 用手機掃描 QR code，把機器人加為好友。
4. 到 <https://manager.line.biz/> 開啟該官方帳號 →「設定 → 回應設定」：
   - **聊天** 關閉，**Webhook** 開啟。
   - **自動回應訊息** 關閉（不然會多回一則預設訊息）。

### 步驟 4：設定指令碼屬性（金鑰）

Apps Script 左側「⚙ 專案設定」→ 最下方「指令碼屬性」→ 新增：

| 屬性 | 值 | 必填 |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 步驟 3 的 token | ✅ |
| `GEMINI_API_KEY` | 步驟 2 的 Key | ✅ |
| `WEBHOOK_TOKEN` | 自訂一串亂碼，例如 `k3J9xQ2m` | 建議填 |
| `GEMINI_MODEL` | 預設 `gemini-3.8-flash` | |
| `TOP_N` | 回覆幾筆，預設 `5` | |
| `CACHE_DAYS` | 同料號多久內不重查，預設 `30` | |
| `SHEET_ID` | 只有當程式不是綁在試算表上時才需要 | |

金鑰放在指令碼屬性裡，不會出現在程式碼中。

### 步驟 5：在編輯器內先測試

1. 在編輯器上方選擇函式 `testCatalog` → 按「執行」，第一次會要求授權，請允許。
   執行紀錄應顯示「料號筆數：792」。
2. 選擇 `testLookup` → 執行，會實際用 Gemini 查 `RH6E040BGTB1` 並印出比對結果。

### 步驟 6：部署成網頁應用程式

1. 右上「部署 → 新增部署作業」→ 類型選「網頁應用程式」。
2. 執行身分：**我**；誰可以存取：**所有人**。
3. 部署後複製「網頁應用程式網址」（`https://script.google.com/macros/s/.../exec`）。
4. 回到 LINE Developers Console → Messaging API 分頁 → Webhook URL 填入：
   ```
   https://script.google.com/macros/s/xxxxx/exec?token=你的WEBHOOK_TOKEN
   ```
   並開啟「Use webhook」。
5. 在 LINE 傳一個料號給機器人測試。

> ⚠️ **修改程式後必須重新部署才會生效：**「部署 → 管理部署作業 → ✏ 編輯 → 版本選『新版本』→ 部署」。這樣網址不會變。
>
> ℹ️ 在 LINE 後台按「Verify」有時會顯示錯誤（Apps Script 會先回 302 轉址），但實際收發訊息正常，可以忽略。

### 步驟 7（選用）：設定 CI/CD 自動部署

設定完成後，只要把程式推送到 GitHub 的 `main` 分支，GitHub Actions 就會：
1. 執行 `tests/run.js`、`tests/e2e_mock.js`；
2. 測試通過 → 用 [clasp](https://github.com/google/clasp) 把 `src/` 上傳到 Apps Script，並更新原本的網頁應用程式部署（**網址不變**，LINE Webhook 不用改）。

> 未設定下列 Secrets 時只會跑測試、略過部署，不會失敗。

**一次性設定：**

1. 開啟 Apps Script API：<https://script.google.com/home/usersettings> → 「Google Apps Script API」設為 **開啟**。
2. 在自己電腦登入 clasp（會開瀏覽器授權，請用擁有該 Apps Script 的 Google 帳號）：
   ```
   npx @google/clasp@2.4.2 login
   ```
   完成後會產生 `C:Users<你>.clasprc.json`。
3. 取得兩個 ID：
   - **SCRIPT_ID**：Apps Script →「⚙ 專案設定」→「指令碼 ID」。
   - **DEPLOYMENT_ID**：「部署 → 管理部署作業」→ 選網頁應用程式 →「部署作業 ID」（`AKfycb...` 開頭）。
4. 設定 GitHub Secrets（在專案資料夾執行）：
   ```
   gh secret set CLASPRC_JSON < "%USERPROFILE%.clasprc.json"
   gh secret set SCRIPT_ID --body "你的指令碼ID"
   gh secret set DEPLOYMENT_ID --body "你的部署作業ID"
   ```
   或到 GitHub repo →「Settings → Secrets and variables → Actions」手動新增。
5. 到 GitHub repo 的「Actions」分頁 →「CI/CD」→「Run workflow」手動跑一次確認。

> ⚠️ `.clasprc.json` 等同該 Google 帳號操作 Apps Script 的權限，只能放在 GitHub Secrets，**不可提交到 repo**（已列在 `.gitignore`）。
>
> ⚠️ 自動部署會用 `src/` 的內容 **完整覆蓋** 線上 Apps Script 的程式檔，之後請只改 GitHub 上的程式，不要在線上編輯器直接改（會被下次部署蓋掉）。指令碼屬性（金鑰）不受影響。

---

## 使用方式

| 輸入 | 動作 |
|---|---|
| `RH6E040BGTB1` | 清單或快取有 → 直接回覆；沒有 → 先回「已開始查詢」，背景上網查 |
| `結果` | 回覆這個聊天室最後查詢料號的結果；還沒查完會回「還在查詢中（已 N 秒）」 |
| `TPN2R203NC`（清單內的料號） | 不上網，直接找清單中的相近料號 |
| `重查 RH6E040BGTB1` | 忽略快取，強制重新上網查詢 |
| `說明` | 顯示使用說明 |

可以把機器人加進群組使用；群組中只有在訊息看起來像料號時才會回應。

---

## 比對規則

- **硬性條件：** 極性必須相同（N-ch / P-ch / 雙 N 等），VDSS 不可低於原料號。
- **評分（加權）：** VDSS 20、RDS(on)@10V 22、RDS(on)@4.5V 12、ID 14、封裝尺寸 20、Qg 5、Ciss 4、PD 3。
  - 數值以對數比例比較。RDS(on) 比原料號低（較好）時扣分較少，ID 比原料號高時扣分也較少。
  - 封裝以本體長寬比較（可旋轉），並檢查 SMD／插件與 pin 數。
  - 缺少的參數不計分，但查到的參數越少，整體分數會略降。
- 權重可在 `src/Matcher.gs` 的 `MATCH_WEIGHTS` 調整，改完可用 `node tests/run.js` 驗證。

## 查詢快取與人工修正

每次上網查到的參數會存在試算表的 **「查詢快取」** 分頁：
- 同一個料號在 `CACHE_DAYS` 天內不會重複呼叫 Gemini，可以省費用。
- AI 抓錯參數時，可以直接修改該列的 JSON，下次查詢就會使用修正後的值。

## 回應時間限制（為什麼要輸入「結果」）

- LINE 的 reply token 官方只保證收到訊息後 **1 分鐘內** 有效，而且只能用一次。上網查詢約 10~30 秒，偶爾更久。
- 所以流程改成：收到料號 → **立刻**用 reply 回「已開始查詢」→ 同一次執行繼續在背景查 Gemini，結果存在 CacheService（保留 6 小時）。
- 使用者輸入「結果」時會有一個新的 reply token，用它回覆結果。完全不用 push。
- 同一個料號的結果只送一次，之後再問就直接從「查詢快取」分頁回覆。
- 背景查詢超過 6 分鐘（Apps Script 執行上限）仍未完成，會視為失敗，下次詢問時重新查。
- LINE 要求 webhook 在 2 秒內回應，Apps Script 要等背景查詢跑完才會回應，所以 LINE 後台「統計」會出現 request_timeout，不影響使用。建議在 LINE Developers Console 關閉「Webhook redelivery」（程式本身也會略過重送的事件）。

## Toshiba 官方 Cross Reference

回覆中附有 Toshiba 官方對照頁連結。該功能需登入 Toshiba 帳號，網站也會擋程式存取（實測回 403），所以機器人不會自動讀取，只提供連結讓使用者點開查看。

## 費用

- **Apps Script：** 免費。每天有 UrlFetch 呼叫次數上限，一般帳號約 2 萬次。
- **LINE：** 只用 reply 回覆，不計入訊息額度。
- **Gemini：** 有免費額度，超過後按量計費。Google 搜尋 grounding 另有額度，請以 Google AI Studio 的帳單頁為準。
