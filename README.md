# 🚲 Loco SmartPatrol Triage｜AI 巡邏預判與雙軌順路交差系統

AI-Driven Pre-Dispatch Triage & Dual-Track Opportunistic Proof System

## 1. 一句話簡介（Executive Summary）

在不跳過「強制現場時間戳記（Timestamp）相片」硬性規定的前提下，透過「派單前 Vision AI + IoT 雙重預判」攔截已清空的假警報，並將專程空跑轉化為「Patrol 50m 順路補拍」或「Loco App 用戶 30m 眾包拍照賺踩車券」，大幅減省無效巡邏車程。

## 2. 核心理念與破局邏輯（Core Idea & Problem Assumptions）

營運痛點假設：CS 收到市民 WhatsApp 違泊投訴後轉發 Patrol 處理，但現實中大量單車在 Patrol 到場前已被其他市民解鎖踩走。然而，為滿足「必須有現場 Timestamp 相片回傳 CS 結單」的合規要求，Patrol 仍被迫專程駕車前往拍攝「空地相」，嚴重拖慢真正阻塞交通熱點的清理進度。

關鍵破局思維（不取消證據鏈，而是重構取證路徑）：

- **派單前雙重核實（Pre-Dispatch Triage）**：結合 Vision AI 影像解析（點算車數、識別地標、判斷單車是否溢出黃線指定泊位）與後台 IoT 數據（50m 圍欄內現存上鎖車數、近期解鎖離開紀錄、GPS 漂移誤差值），在派車前即刻篩出「現場已清空」的工單。
- **Auto-Zone 自動地理分區**：系統自動依座標路由至對應營運分區（如「新界東｜沙田・大圍區」）。急單推入該區 Patrol 群組協調清理；已清空工單則不刷屏騷擾群組，靜默掛載至該區地理圍欄。
- **雙軌順路取證（Dual-Track Opportunistic Proof）**：
  - **軌跡 A（🚲 by LOCO PATROL）**：當該區 Patrol 換電／調度日常路線途經投訴點 50m 範圍內，手機網頁自動彈出提示，隊員順手花 5 秒拍一張空地相即秒結單。
  - **軌跡 B（🎟️ by LOCO RIDER）**：若附近暫無 Patrol，當有 Loco App 用戶在投訴點 30m 內開啟 App（抓取 Current Location），系統推送微任務邀請用戶順手拍攝面前行人路實況；AI 驗證地標吻合且通道暢通後，自動派發 2 張 30 分鐘踩車券作為激勵，零 Patrol 出勤即可完成 CS 結單。
- **無縫復刻 Loco 現有審核標準**：系統自動透過 HTML5 Canvas 為現場相片壓印 Loco 慣用的磨砂白底地圖＋日期時間＋純數字 GPS 座標水印，並標註來源，CS 同事無需改變任何審核習慣。

## 3. 評審快速試玩指南（How to Use the Demo — 2 分鐘體驗完整閉環）

打開已部署的 Web App（Next.js App Router + Vercel + Convex Real-Time DB），畫面分為左、中、右三欄，建議按以下順序測試 3 個核心場景：

### 場景一：核心痛點「車已踩走」➔ 雙軌順路補拍（Case A｜大圍站 A 出口）

1. **左欄**：點選 Case A｜大圍站（車已踩走），查看市民 WhatsApp 投訴原圖，點擊 [🔍 執行 AI 派單前預判]。
2. **中欄**：觀察 AI 比對 Vision 影像（6 部車）與後台 IoT（0 部在場、6 部剛被踩走），決策為 🟢 系統確認已清空｜轉入順路補相池。接著點擊下方任一順路觸發掣（🚐 模擬 Patrol 途經 50m 或 📱 模擬 Loco Rider 30m 內影相賺 2 張 30 分鐘券）。
3. **右欄**：點擊模擬拍照（或上傳任意街景相），系統自動驗證地標吻合度並用 Canvas 生成 Loco 磨砂白底 Timestamp 鐵證相（顯示 🚲 by LOCO PATROL 或 🎟️ by LOCO RIDER）；點擊 [📲 一鍵回傳 CS WhatsApp 並結單]，頂部 KPI 統計與 Convex 不可竄改審計日誌（Audit Log）即時同步更新。

### 場景二：真實清理標準「單車歸入黃線指定泊位」（Case E｜太和站）

1. 點選 Case E｜太和站（溢出黃線）執行預判（🔴 確認阻塞，急派清理）。
2. 在右欄點擊 [🟨 模擬拍攝「單車已整齊歸入黃線泊位」]（或上傳太和站整理後實拍相片），展示 Vision AI 不只懂識別「0 部車」，更能精準判斷單車已整齊排入黃色格線內、主通道暢通，合規結單。

### 場景三：False-Positive 防誤判保護（Case C｜沙田圍天橋底）

點選 Case C｜沙田天橋底（GPS 漂移）執行預判。雖然後台顯示 0 部車，但因天橋底 GPS 漂移達 ±45m，系統主動降級為 🟠 低信心度防漏單保護｜建議優先派員核實，展示「寧可穩陣、絕不漏單」的風控設計。

### 進階互動（可選）

- **CS 新增自訂工單**：左欄點擊 [➕ CS 新增自訂投訴 Task] 可即場輸入地點、上傳相片寫入 Convex 資料庫。
- **真實手機掃碼同步**：右欄掃描 QR Code 打開獨立手機端路由 `/patrol/[ticketCode]` 拍照上傳，大螢幕 CS 控制台會透過 Convex Real-Time Sync 毫秒級自動同步結單。
- **效益估算**：點擊頂部 [📊 營運效益計算機 & Loco 試點藍圖]，可拉動滑桿試算每月節省工時與查看兩階段試點計劃。

## 4. 可行性與落地規劃（Feasibility & Next Steps at Loco）

- **零摩擦部署（Zero-Friction）**：CS 繼續使用現有 WhatsApp 流程，Patrol 透過手機網頁連結開相機打卡（免裝新 App），Loco App 僅需新增輕量定位任務彈窗。
- **邊際成本極低**：送出「2 張 30 分鐘踩車券」的邊際成本趨近於零，且能帶動用戶復購騎行，相比派 Patrol 專程出勤（每趟約 20 分鐘人力與車隊成本）節省逾 95% 核實成本。
