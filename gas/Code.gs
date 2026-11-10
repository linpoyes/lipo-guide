/**
 * 赤貧軍團賣場 — Apps Script 後端（資料存在 Google 試算表，媒體存在 Google 雲端硬碟）
 *
 * 前台 shop.html／後台 admin.html 都打這支 web app 的 /exec：
 *   GET  ?action=catalog              公開：上架商品、影片、設定（不含折扣碼）
 *   POST {action:"quote"|"order",…}   公開：試算／送出訂單（金額一律由這裡重算，前端算的只是預覽）
 *   POST {action:"admin_…",token,…}   後台：先 login 拿 token
 *
 * 請求一律用 text/plain 送 JSON（簡單請求，不觸發 CORS preflight）。
 * 帳密只存「加鹽雜湊」在指令碼屬性，不寫在程式碼或試算表裡。
 * 結帳目前只收單（payStatus = unpaid）；之後接綠界時在 order 之後導去付款、callback 改 payStatus。
 */

const SHEETS = {
  products: ["id", "name", "category", "price", "listPrice", "desc", "images", "tiers", "stock", "active", "hot", "sort", "updatedAt", "cvsOk", "brand", "supplier", "commission", "preorder", "cvsPer", "homePer", "dims", "weight", "cost", "splitMode", "costBy"],
  videos:   ["id", "title", "src", "poster", "productId", "active", "sort", "updatedAt"],
  codes:    ["code", "type", "value", "minSpend", "startAt", "endAt", "limit", "used", "active", "note", "member"],
  orders:   ["orderNo", "createdAt", "name", "phone", "line", "shipMethod", "address", "note", "items", "subtotal", "tierSaving", "code", "codeDiscount", "shipping", "total", "status", "payStatus", "clientId", "packages", "lineUid", "lineName", "payMethod", "ecpayNo", "payFee", "paidAt", "vaBank", "vaAccount", "vaExpire", "pointsUsed", "shipments", "restocked", "feeSrc"],
  settings: ["key", "value"],
  // 流量（2026-11-08）：前台 track.js 送來的事件，一列一筆；ts＝台北時間 yyyy-MM-dd HH:mm:ss
  traffic:  ["ts", "vid", "sid", "type", "page", "pid", "q", "n", "src", "ref", "dev", "os"],
  // LINE 會員名冊：登入時寫入／更新（uid＝LINE userId）
  members:  ["uid", "name", "pic", "friend", "firstAt", "lastAt", "logins"],
  // 其他支出（報表拆帳用；scope＝all 全部商品分攤，或貨主名稱只攤該貨主）
  expenses: ["id", "date", "item", "amount", "note", "scope"],
  // 綠界物流貨態回報原始紀錄（核對貨態判斷用）
  logilog:  ["ts", "orderNo", "id", "code", "msg"],
  // 後台操作紀錄（2026-11-09 使用者：超級管理員要看得到每個人的每個動作）
  audit:    ["ts", "user", "role", "action", "detail", "target"],
};
// 試算表分頁的中文名稱（給使用者自己打開試算表時看得懂）
const TAB = { products: "商品", videos: "影片", codes: "折扣碼", orders: "訂單", settings: "設定", traffic: "流量", members: "會員", expenses: "支出", logilog: "物流紀錄", audit: "操作紀錄" };
// 寄送只有兩種（使用者 2026-10-31 定）：黑貓宅配（大件、遙控車）／7-11 店到店（商品勾「可超商寄送」的小件才可選）
const SHIP_HOME = "黑貓宅配", SHIP_CVS = "7-11 店到店";
// ordersOpen：全站是否開放下單（2026-11-07 使用者：商品先上架、先不開放下單）
const DEFAULT_SETTINGS = { shipFee: 150, shipFeeCvs: 60, freeShipOver: 0, lineUrl: "", notice: "", ordersOpen: "FALSE", requireLine: "TRUE", shipBarOn: "TRUE", shipBar: "",
  // LINE 入會禮（2026-11-08）：指定一組折扣碼；LINE 登入＋加好友的會員才能用、每人限一次，加好友時用 LINE 送到對方手機。空白＝不送
  welcomeCode: "",
  // 賣場熱門搜尋關鍵字（逗號分隔）；空白＝前台依品牌與分類自動產生
  hotWords: "",
  // 入會禮有效天數（自領取起算）與到期前幾天提醒（2026-11-08 使用者：要有期限、要提醒）
  welcomeDays: "30", welcomeRemind: "3",
  // 會員積分（2026-11-08）：已付款訂單每消費 pointRate 元回饋 1 點；1 點折抵 1 元；單筆最多折抵商品金額的 pointMaxPct %
  pointsOn: "TRUE", pointRate: "100", pointMaxPct: "50",
  // 綠界物流（2026-11-08）：寄件人資料、預設材積（0001=60cm…0004=150cm）、付款後自動建寄件單、測試模式
  logiOn: "FALSE", logiStage: "TRUE", logiAuto: "TRUE", senderName: "", senderPhone: "", senderZip: "", senderAddr: "", logiSize: "0001", homeBox: "40,30,20",
  capital: "0", // 初始資金（報表顯示回本進度）
  // 物流成本（未稅，綠界一般會員 2026-11 公告；記帳時 ×1.05）：交貨便每件、黑貓 60/90/120/150cm
  logiFeeCvs: "65", logiFeeHome: "130,170,210,250",
  // 綠界手續費（2026-11 查證，綠界官網服務費率表・一般會員，未稅＋5% 營業稅）：
  //   信用卡一次付清 2.75%、每筆最低 5 元，另加訂單處理費 1 元（含稅）；ATM 虛擬帳號 1%、每筆最低 15 元
  feeCardPct: "2.75", feeCardMin: "5", feeCardOrder: "1", feeAtmPct: "1", feeAtmMin: "15",
  // 手續費分攤：ratio＝先從營收扣手續費再依分潤比例拆（雙方按比例負擔）；us＝我方全付；owner＝貨主全付
  feeSplit: "ratio" };
const ECPAY_STAGE = { mid: "3002607", key: "pwFHCqoQZGmho4w6", iv: "EkRm7iFT261dpevs" }; // 綠界公開的測試帳號（非機密）
// 登入有效 10 天（使用者 2026-10-31：登入過的裝置不要一直登出）。
// CacheService 最長只存 6 小時，所以 session 存在指令碼屬性：SESS_<token 雜湊> = 到期毫秒。
const SESSION_DAYS = 10;

/* ───────────── 初始化（第一次在編輯器手動執行一次，順便完成授權） ───────────── */
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty("SHEET_ID")) {
    const ss = SpreadsheetApp.create("赤貧軍團賣場資料庫");
    Object.keys(SHEETS).forEach((k, i) => {
      const sh = i === 0 ? ss.getSheets()[0].setName(TAB[k]) : ss.insertSheet(TAB[k]);
      sh.getRange(1, 1, 1, SHEETS[k].length).setValues([SHEETS[k]]).setFontWeight("bold");
      sh.setFrozenRows(1);
      sh.getRange("A:Z").setNumberFormat("@"); // 全部純文字：避免日期被時區平移、代碼前導 0 被吃掉
    });
    p.setProperty("SHEET_ID", ss.getId());
    Object.keys(DEFAULT_SETTINGS).forEach(k => setSetting_(k, DEFAULT_SETTINGS[k]));
  }
  if (!p.getProperty("MEDIA_FOLDER")) {
    p.setProperty("MEDIA_FOLDER", DriveApp.createFolder("赤貧軍團賣場媒體").getId());
  }
  if (!p.getProperty("ADMIN_HASH")) setAdmin_("01", "01"); // 初始帳密，後台「設定」可改
  return "OK " + p.getProperty("SHEET_ID");
}

/* ───────────── 進入點 ───────────── */
function doGet(e) {
  const a = (e.parameter || {}).action;
  if (a === "catalog") return out_(catalogCached_());
  if (a === "ping") return out_({ ok: true });
  if (a === "cron") return out_(cron_()); // GitHub Actions 每小時呼叫（.github/workflows/cron.yml）
  if (a === "lineSetup") return out_(lineSetup_());
  if (a === "liffSetup") return out_(liffSetup_());
  if (a === "welcomePreview") return out_(welcomePreview_());
  if (a === "csPreview") return out_(csPreview_());
  if (a === "orderStatus") return out_(orderStatus_(e.parameter));
  if ((e.parameter || {}).cb === "linelogin") return lineLoginReturn_(e.parameter);
  if (a === "member") return out_(memberCheck_(e.parameter.mt));
  if (a === "loginUrl") return out_({ ok: true, url: loginUrl_() });
  if (a === "store") { // 賣場輪詢：選門市的結果（sk 是賣場產生的一次性亂數）
    const v = CacheService.getScriptCache().get("store:" + String((e.parameter || {}).sk || ""));
    return out_({ ok: true, store: v ? JSON.parse(v) : null });
  }
  return out_({ ok: false, error: "unknown action" });
}

function doPost(e) {
  // 7-11 電子地圖選完門市後，會把門市資料以表單 POST 回這裡（?cb=711），轉交回賣場
  if (e.parameter && e.parameter.cb === "711") return storeReturn_(e.parameter);
  // 綠界通知：付款結果（server→server）、ATM 取號結果、取號後導回客人
  if (e.parameter && e.parameter.cb === "ecpay") return ecpayReturn_(e.parameter);
  if (e.parameter && e.parameter.cb === "line") return lineWebhook_(e);
  if (e.parameter && e.parameter.cb === "ecpayinfo") return ecpayInfo_(e.parameter);
  if (e.parameter && e.parameter.cb === "ecpayback") return ecpayBack_(e.parameter);
  if (e.parameter && e.parameter.cb === "logi") return logiReply_(e.parameter);
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "格式錯誤" }); }
  try {
    const a = req.action;
    if (a === "quote") { // 公開試算：品項不回傳成本、貨主、分潤
      const q = quote_(req.items, req.code, req.shipMethod, req.memberToken ? memberOf_(req.memberToken) : null, !!req.usePoints);
      q.lines = q.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.price, unit: l.unit, total: l.total }));
      return out_({ ok: true, quote: q });
    }
    if (a === "memberCenter") return out_(memberCenter_(req));
    if (a === "order") return out_(placeOrder_(req));
    if (a === "adminLine") { const r = adminLine_(req); return out_(r); }
    if (a === "login") { const r = login_(req.user, req.pass); audit_({ user: String(req.user || "").normalize("NFKC").trim(), role: r.role || "" }, r.ok ? "login" : "loginFail", req, null); return out_(r); }
    if (a === "track") return out_(track_(req));
    if (a === "lineLogin") return out_(lineLoginPost_(req));
    if (a === "liffLogin") return out_(liffLogin_(req));
    if (a && a.indexOf("admin_") === 0) {
      const me = checkToken_(req.token);
      if (!me) return out_({ ok: false, error: "auth" });
      const fn = ADMIN[a];
      if (!fn) return out_({ ok: false, error: "unknown action" });
      if (!can_(me, a)) return out_({ ok: false, error: "此帳號沒有權限" });
      req.me = me;
      const write = !/^admin_(all|me|users|orders|dashboard|expenses|ecpayStatus|lineStatus|logiStatus|audit)$/.test(a);
      const before = write ? auditBefore_(a, req) : null;
      let out;
      try { out = Object.assign({ ok: true }, fn(req) || {}); }
      catch (err) { if (write) audit_(me, a, req, before, String(err && err.message || err)); throw err; }
      if (write) { if (!/^admin_logiPrint/.test(a)) dropCatalog_(); audit_(me, a, req, before, "", out); } // 後台有寫入就讓型錄快取失效＋記錄
      return out_(out);
    }
    return out_({ ok: false, error: "unknown action" });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────── 試算表存取 ───────────── */
let SS_ = null;
function sheet_(k) {
  SS_ = SS_ || SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID"));
  let sh = SS_.getSheetByName(TAB[k]);
  if (!sh) { // 後來新增的分頁：第一次用到時自動建立
    sh = SS_.insertSheet(TAB[k]);
    sh.getRange(1, 1, 1, SHEETS[k].length).setValues([SHEETS[k]]).setFontWeight("bold");
    sh.setFrozenRows(1); sh.getRange("A:Z").setNumberFormat("@");
  }
  return sh;
}
function rows_(k) {
  const sh = sheet_(k), n = sh.getLastRow() - 1, cols = SHEETS[k];
  if (sh.getLastColumn() < cols.length) sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight("bold"); // 新增欄位時補表頭
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => o[c] = cell_(r[j]));
    return o;
  });
}
// 依主鍵寫入一列（有就覆蓋、沒有就新增）。只寫 SHEETS 定義的欄位，多送的欄位不會被靜靜丟掉以外的方式處理。
// 寫入前先把那一列設成純文字再 setValues，並一律轉成字串：
// appendRow 會自行解析，曾把「0912345678」吃掉前導 0、把「2020-01-01」變成日期物件（2026-10-31 實測）。
function upsert_(k, keyCol, obj) {
  const cols = SHEETS[k], sh = sheet_(k);
  const found = rows_(k).find(r => String(r[keyCol]) === String(obj[keyCol]));
  const vals = [cols.map(c => safeCell_(String(obj[c] === undefined ? (found ? found[c] : "") : obj[c] === null ? "" : obj[c])))];
  const row = found ? found._row : sh.getLastRow() + 1;
  const rg = sh.getRange(row, 1, 1, cols.length);
  rg.setNumberFormat("@");
  rg.setValues(vals);
}
// 弱掃 2026-11-06：以 = + - @ 開頭的字串會被試算表當公式（公式注入），一律加 ' 前綴存成文字（讀出時 ' 不會出現）
function safeCell_(v) { return /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? "'" + v : v; }
// 讀出時把已被轉成日期／數字的舊資料還原成文字
function cell_(v) {
  if (v instanceof Date) {
    const t = Utilities.formatDate(v, "Asia/Taipei", "HH:mm");
    return Utilities.formatDate(v, "Asia/Taipei", t === "00:00" ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm");
  }
  return v;
}
function remove_(k, keyCol, key) {
  const r = rows_(k).find(x => String(x[keyCol]) === String(key));
  if (r) sheet_(k).deleteRow(r._row);
}
function getSettings_() {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  rows_("settings").forEach(r => s[r.key] = r.value);
  s.shipFee = Number(s.shipFee) || 0;
  s.shipFeeCvs = Number(s.shipFeeCvs) || 0;
  s.ordersOpen = bool_(s.ordersOpen);
  s.freeShipOver = Number(s.freeShipOver) || 0;
  return s;
}
function setSetting_(key, value) { upsert_("settings", "key", { key: key, value: String(value) }); }

const bool_ = v => v === true || String(v).toUpperCase() === "TRUE" || v === "1";
const json_ = (v, d) => { try { return v ? JSON.parse(v) : d; } catch (e) { return d; } };
function product_(r) {
  const o = {
    id: String(r.id), name: String(r.name), category: String(r.category || ""),
    price: Number(r.price) || 0, listPrice: Number(r.listPrice) || 0, desc: String(r.desc || ""),
    images: json_(r.images, []), tiers: json_(r.tiers, []),
    stock: r.stock === "" || r.stock === null ? -1 : Number(r.stock),
    active: bool_(r.active), hot: bool_(r.hot), sort: Number(r.sort) || 0, cvsOk: bool_(r.cvsOk), brand: String(r.brand || "").trim(),
    // 代銷：supplier＝供貨商（空白＝自有商品）、commission＝我方抽成 %、preorder＝此商品暫不開放下單（即將開賣）
    supplier: String(r.supplier || "").trim(), commission: Number(r.commission) || 0, preorder: bool_(r.preorder),
    // 拆帳（2026-11-09）：cost＝每件成本；splitMode＝profit 淨利分成（扣成本與所有支出後依成數拆）／commission 銷售抽成（我方淨賺售價的 X%，支出由貨主負擔）；
    // costBy＝成本誰出資（us 我方／owner 貨主；貨主出資時成本先還給貨主）。成本只給後台，型錄會拿掉。
    cost: Number(r.cost) || 0, splitMode: String(r.splitMode || "profit") === "commission" ? "commission" : "profit", costBy: String(r.costBy || "us") === "owner" ? "owner" : "us",
    // 包裝：一個 7-11 交貨便／一箱黑貓宅急便各可裝幾件（0＝不限，整單一個包裹）
    cvsPer: Number(r.cvsPer) || 0, homePer: Number(r.homePer) || 0,
    dims: String(r.dims || ""), weight: Number(r.weight) || 0,
  };
  // 有填包裝尺寸＝系統自己算每個交貨便／每箱宅急便裝幾件，並決定能不能走 7-11（2026-11-09 使用者）
  const c = packCaps_(o.dims, o.weight);
  if (c) { o.cvsPer = c.cvs; o.homePer = c.home; o.cvsOk = c.cvs > 0; o.packAuto = true; }
  return o;
}
function video_(r) {
  return { id: String(r.id), title: String(r.title || ""), src: String(r.src || ""), poster: String(r.poster || ""),
           productId: String(r.productId || ""), active: bool_(r.active), sort: Number(r.sort) || 0 };
}
function code_(r) {
  return { code: String(r.code), type: String(r.type || "percent"), value: Number(r.value) || 0,
           minSpend: Number(r.minSpend) || 0, startAt: String(r.startAt || ""), endAt: String(r.endAt || ""),
           limit: r.limit === "" ? 0 : Number(r.limit) || 0, used: Number(r.used) || 0,
           active: bool_(r.active), note: String(r.note || ""), member: bool_(r.member) };
}

/* ───────────── 公開：型錄 ───────────── */
// 已售數量＝未取消訂單的件數加總（賣場「熱門」排序用）
function withSold_(products) {
  const sold = {};
  rows_("orders").forEach(o => {
    if (String(o.status) === "已取消") return;
    json_(o.items, []).forEach(i => sold[i.id] = (sold[i.id] || 0) + (Number(i.qty) || 0));
  });
  products.forEach(p => p.sold = sold[p.id] || 0);
  return products;
}
// 一次性資料調整（只跑一次，用指令碼屬性記號）：2026-11-08 建立入會禮折扣碼 WELCOME50（折 $50）並設為 LINE 入會禮
function migrate_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty("MIG_WELCOME50")) return;
  p.setProperty("MIG_WELCOME50", "1");
  if (!rows_("codes").some(c => String(c.code).toUpperCase() === "WELCOME50"))
    upsert_("codes", "code", { code: "WELCOME50", type: "amount", value: "50", minSpend: "0", startAt: "", endAt: "", limit: "0", used: "0", active: "TRUE", note: "LINE 入會禮", member: "TRUE" });
  if (!String(getSettings_().welcomeCode || "")) setSetting_("welcomeCode", "WELCOME50");
}
// 2026-11-08：AE86 加一張繁體中文版的「配件內容」圖（原圖簡體，重製後放網站 media/），排第 2 張
function migrateAe86_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty("MIG_AE86PACK")) return;
  p.setProperty("MIG_AE86PACK", "1");
  const r = rows_("products").find(x => /AE86/.test(String(x.name))); if (!r) return;
  const imgs = json_(r.images, []), src = "media/ae86-pack.jpg";
  if (imgs.indexOf(src) >= 0) return;
  imgs.splice(Math.min(1, imgs.length), 0, src);
  upsert_("products", "id", { id: String(r.id), images: JSON.stringify(imgs), updatedAt: new Date().toISOString() });
}
// 2026-11-09：迷你甩尾車九款填入包裝尺寸（網路查證：JXC SP4301 盒裝 23×19×10 cm、約 468 g，rc-wing／arrishobby 商品頁）
function migrateDims_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_JXCDIMS")) return; p.setProperty("MIG_JXCDIMS", "1");
  rows_("products").filter(r => /迷你漂移遙控車|JXC/.test(String(r.name)) && !String(r.dims || "")).forEach(r =>
    upsert_("products", "id", { id: String(r.id), dims: "23,19,10", weight: "0.47", updatedAt: new Date().toISOString() }));
}
// 2026-11-09 使用者：目前不設免運 → 門檻歸零（之後要再開，到後台「免運門檻」填金額即可）
function migrateNoFreeShip_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_NOFREESHIP")) return; p.setProperty("MIG_NOFREESHIP", "1");
  setSetting_("freeShipOver", "0");
}
// 2026-11-09：Supra 性能白原廣告圖下半被截斷 → 換成 JXC 官網（jxcmodel.com/product/toyota-supra）的完整原廠圖（前側＋後側）
function migrateSupraWhite_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_SUPRAWHITE")) return; p.setProperty("MIG_SUPRAWHITE", "1");
  const r = rows_("products").find(x => /Supra/.test(String(x.name)) && /性能白/.test(String(x.name))); if (!r) return;
  const imgs = json_(r.images, []);
  const out = [imgs[0], "media/supra-white-front.jpg", "media/supra-white-rear.jpg"].concat(imgs.slice(2)).filter(Boolean);
  upsert_("products", "id", { id: String(r.id), images: JSON.stringify(out), updatedAt: new Date().toISOString() });
}
// 2026-11-09：其餘車款也補 JXC 官網原廠圖（jxcmodel.com：PO4302 GT3 RS、Toyota Supra、Supra 1087X、AE4386），插在封面後面
function migrateOfficialImgs_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_OFFICIAL")) return; p.setProperty("MIG_OFFICIAL", "1");
  const M = [[/GT3RS 競速黃/, ["gt3rs-yellow-front", "gt3rs-yellow-rear"]], [/GT3RS 競速紅/, ["gt3rs-red-front", "gt3rs-red-rear"]],
    [/GT3RS 賽車彩繪/, ["gt3rs-livery-front", "gt3rs-livery-rear"]], [/1087X/, ["1087x-side", "1087x-alt", "1087x-box"]],
    [/Supra 飆速黃/, ["supra-yellow-front", "supra-yellow-rear"]], [/Supra 飆速紅/, ["supra-red-front"]],
    [/Supra 經典白/, ["supra-white-front", "supra-white-rear"]], [/AE86/, ["ae86-white-front", "ae86-white-rear"]]];
  rows_("products").forEach(r => {
    const m = M.find(x => x[0].test(String(r.name))); if (!m) return;
    const imgs = json_(r.images, []), add = m[1].map(n => "media/" + n + ".jpg").filter(x => imgs.indexOf(x) < 0); if (!add.length) return;
    upsert_("products", "id", { id: String(r.id), images: JSON.stringify([imgs[0]].concat(add, imgs.slice(1))), updatedAt: new Date().toISOString() });
  });
}
// 2026-11-09：1087X 實際是 Supra 車身 → 封面改用原廠 Supra 1087X 重製（media/1087x-cover.jpg），拿掉舊的 GT3RS 外型廣告圖；
// 全系列九宮格也重做（media/series.jpg）取代各商品原本雲端硬碟那張
function migrate1087_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_1087SUPRA")) return; p.setProperty("MIG_1087SUPRA", "1");
  const OLD_SERIES = "drive:1IeQcnaVxbYqbR8-z_dE1Ov6WZNOhcf38";
  rows_("products").forEach(r => {
    let imgs = json_(r.images, []);
    if (/1087X/.test(String(r.name))) imgs = ["media/1087x-cover.jpg", "media/1087x-side.jpg", "media/1087x-alt.jpg", "media/1087x-box.jpg", "media/series.jpg"];
    else imgs = imgs.map(x => x === OLD_SERIES ? "media/series.jpg" : x);
    upsert_("products", "id", { id: String(r.id), images: JSON.stringify(imgs), updatedAt: new Date().toISOString() });
  });
}
// 2026-11-09 使用者：「直接幫我做」→ 正式開賣：開放下單、九款迷你甩尾車取消即將開賣
function migrateGoLive_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_GOLIVE")) return; p.setProperty("MIG_GOLIVE", "1");
  setSetting_("ordersOpen", "TRUE");
  rows_("products").filter(r => bool_(r.preorder)).forEach(r => upsert_("products", "id", { id: String(r.id), preorder: "FALSE", updatedAt: new Date().toISOString() }));
}
// 2026-11-09：老闆 IG @haolaba 的 12 支開箱 Reels 加進賣場「老闆開箱」（封面 media/ig/<代碼>.jpg；排在原本短影音之後）
function migrateIg_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_IG")) return; p.setProperty("MIG_IG", "1");
  const R = [["DfCvJhwAVW-", "SCANIA 大拖車頭上線"], ["DdjUHulgwbU", "問南風 EVO 迷你甩尾車上線"], ["DdbouYwgKgb", "SCANIA 甩尾拖車頭上線"], ["DezCPOyAzoH", "1/43 暴力鴨改殼套件"],
    ["Deo-rdggD6l", "性價比最高的拖車頭"], ["Deo7Lc0ApQN", "問南風垃圾桶上線"], ["DemgOZqgf_A", "打造蜘蛛人專屬遙控車"], ["DeZeR3ugLuh", "問南風甩尾車系列大補貨"],
    ["DeZbTgTAnRN", "問南風系列再次大補貨"], ["DeWvyuDAkxW", "幫爸爸介紹遙控車"], ["DePERnfgRM_", "跌倒會自己起來的車"], ["DeMYtyAAwGr", "TOYOTA Yaris 1/43 甩尾車上線"]];
  const have = rows_("videos").map(v => String(v.src));
  R.forEach((r, i) => { const src = "https://www.instagram.com/reel/" + r[0] + "/"; if (have.indexOf(src) >= 0) return;
    upsert_("videos", "id", { id: "ig" + r[0].replace(/[^\w]/g, ""), title: r[1], src: src, poster: "media/ig/" + r[0] + ".jpg", productId: "", active: "TRUE", sort: String(100 + i), updatedAt: new Date().toISOString() }); });
}
// 2026-11-09 使用者：老闆開箱只要影片（不要 IG 介面）→ 改用下載的原始 MP4（media/ig/<代碼>.mp4，老闆本人授權）；焦點推薦停用、九款宣傳影片下架
function migrateIgMp4_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_IGMP4")) return; p.setProperty("MIG_IGMP4", "1");
  rows_("videos").forEach(v => {
    const m = String(v.src).match(/instagram\.com\/(?:[\w.]+\/)?(?:reel|reels|p)\/([\w-]+)/);
    if (m) upsert_("videos", "id", { id: String(v.id), src: "media/ig/" + m[1] + ".mp4", updatedAt: new Date().toISOString() });
    else if (/九款登場/.test(String(v.title))) upsert_("videos", "id", { id: String(v.id), active: "FALSE", updatedAt: new Date().toISOString() });
  });
}
// 2026-11-09 使用者：沒有 LINE 會員也能下單（結帳時提醒一次，不強制）
function migrateNoRequireLine_() { const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_NOREQLINE")) return; p.setProperty("MIG_NOREQLINE", "1"); setSetting_("requireLine", "FALSE"); }
// 2026-11-09 使用者：保時捷（GT3RS 三款）與 1087X 不賣，只賣 5 款 → 下架（不刪除，訂單與報表保留）
function migrateNoPorsche_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_NOPORSCHE2")) return; p.setProperty("MIG_NOPORSCHE2", "1");
  rows_("products").filter(r => /GT3RS|1087X/.test(String(r.name))).forEach(r => upsert_("products", "id", { id: String(r.id), active: "FALSE", updatedAt: new Date().toISOString() }));
}
function catalog_() {
  migrateNoPorsche_();
  migrateNoRequireLine_();
  migrateIg_(); migrateIgMp4_();
  migrateGoLive_();
  migrate_(); migrateAe86_(); migrateDims_(); migrateNoFreeShip_(); migrateSupraWhite_(); migrateOfficialImgs_(); migrate1087_();
  try { expireOrders_(); } catch (e) {}
  try { remindWelcome_(); } catch (e) {}
  const bySort = (a, b) => a.sort - b.sort;
  const s = getSettings_();
  return {
    ok: true,
    products: withSold_(rows_("products").map(product_).filter(p => p.active)).sort(bySort).map(p => { delete p.cost; delete p.splitMode; delete p.costBy; delete p.supplier; delete p.commission; return p; }),
    videos: rows_("videos").map(video_).filter(v => v.active && v.src).sort(bySort),
    settings: { ordersOpen: s.ordersOpen, requireLine: s.requireLine !== "FALSE", payReady: ecpayCfg_().ready, payTest: ecpayCfg_().stage, shipFee: s.shipFee, shipFeeCvs: s.shipFeeCvs, freeShipOver: s.freeShipOver, lineUrl: s.lineUrl, notice: s.notice, shipBarOn: bool_(s.shipBarOn), shipBar: s.shipBar, hotWords: s.hotWords, points: pointCfg_(), welcome: (w => w && { label: w.label, minSpend: w.minSpend })(welcomeInfo_()) },
  };
}

/* ───────────── 計價（前台 shop.html 的 price() 必須跟這裡一致） ───────────── */
// 數量優惠：tiers = [{qty, price}]，買到 qty 件以上，每件都用該單價；取符合的最低單價。
function unitPrice_(p, qty) {
  let u = p.price;
  (p.tiers || []).forEach(t => { if (qty >= Number(t.qty) && Number(t.price) > 0 && Number(t.price) < u) u = Number(t.price); });
  return u;
}
function today_() { return Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd"); }
function codeCheck_(c, subtotal) {
  if (!c || !c.active) return "折扣碼無效";
  const d = today_();
  if (c.startAt && d < c.startAt) return "折扣碼尚未開始";
  if (c.endAt && d > c.endAt) return "折扣碼已過期";
  if (c.limit > 0 && c.used >= c.limit) return "折扣碼已用完";
  if (subtotal < c.minSpend) return "未達最低消費 $" + c.minSpend;
  return "";
}
function quote_(items, codeStr, shipMethod, mem, usePoints) {
  const prods = {};
  rows_("products").map(product_).forEach(p => prods[p.id] = p);
  const lines = [], errors = [];
  let subtotal = 0, tierSaving = 0;
  (items || []).forEach(it => {
    const p = prods[it.id], qty = Math.max(0, Math.floor(Number(it.qty) || 0));
    if (!p || !p.active) { errors.push("商品已下架"); return; }
    if (!qty) return;
    if (p.stock >= 0 && qty > p.stock) errors.push(p.name + " 庫存不足（剩 " + p.stock + "）");
    const u = unitPrice_(p, qty);
    if (p.preorder) errors.push(p.name + " 即將開賣，尚未開放訂購");
    // 供貨商與抽成在下單當下記進訂單（之後改商品設定不影響舊單的報表）
    lines.push({ id: p.id, name: p.name, qty: qty, price: p.price, unit: u, total: u * qty, supplier: p.supplier, commission: p.commission, cost: p.cost, splitMode: p.splitMode, costBy: p.costBy });
    subtotal += u * qty;
    tierSaving += (p.price - u) * qty;
  });
  let code = "", codeDiscount = 0, codeError = "";
  if (codeStr) {
    const c = rows_("codes").map(code_).find(x => x.code.toUpperCase() === String(codeStr).trim().toUpperCase());
    codeError = codeCheck_(c, subtotal);
    if (!codeError && c.member && !isWelcome_(c.code) && (!mem || !mem.friend)) codeError = "此為會員專屬優惠，請先以 LINE 登入並加入官方帳號好友";
    if (!codeError && isWelcome_(c.code)) {
      if (!mem || !mem.friend) codeError = "此為 LINE 會員入會禮，請先以 LINE 登入並加入官方帳號好友";
      else if (welcomeUsed_(mem.uid)) codeError = "入會禮每位會員限用一次";
      else if (welcomeGrant_(mem.uid, true).expired) codeError = "入會禮已超過使用期限";
    }
    if (!codeError) {
      code = c.code;
      codeDiscount = c.type === "amount" ? Math.min(c.value, subtotal) : Math.round(subtotal * c.value / 100);
    }
  }
  const s = getSettings_();
  const cvs = shipMethod === SHIP_CVS;
  if (cvs) lines.forEach(l => { if (!prods[l.id].cvsOk) errors.push(l.name + " 僅限黑貓宅配"); });
  const after = subtotal - codeDiscount;
  // 包裹數：每項商品依「每個包裹可裝幾件」換算成包裹占比後加總、無條件進位（有設 0＝不限的商品不另佔包裹）
  let share = 0;
  lines.forEach(l => { const per = cvs ? prods[l.id].cvsPer : prods[l.id].homePer; if (per > 0) share += l.qty / per; });
  const packages = lines.length ? Math.max(1, Math.ceil(share - 1e-9)) : 0;
  // 運費＝每包運費 × 包裹數（達免運門檻全免）
  const shipping = !lines.length || (s.freeShipOver > 0 && after >= s.freeShipOver) ? 0 : (cvs ? s.shipFeeCvs : s.shipFee) * packages;
  // 積分折抵：在運費之後扣，最多折到商品金額（折扣後）的 pointMaxPct %
  let pointsDiscount = 0, pointsBalance = 0;
  const pc = pointCfg_();
  if (pc.on && mem && mem.friend) {
    pointsBalance = pointsOf_(mem.uid).balance;
    if (usePoints) pointsDiscount = Math.max(0, Math.min(pointsBalance, Math.floor(after * pc.maxPct / 100)));
  }
  return { packages: packages, lines: lines, subtotal: subtotal, tierSaving: tierSaving, code: code, codeDiscount: codeDiscount,
           codeError: codeError, shipping: shipping, pointsDiscount: pointsDiscount, pointsBalance: pointsBalance, pointsMax: pc.on ? Math.floor(after * pc.maxPct / 100) : 0,
           total: after + shipping - pointsDiscount, errors: errors };
}

/* ───────────── 公開：送出訂單 ───────────── */
// 收件人姓名＝取貨時核對證件用（規則同綠界物流：中文 2–5 字、英文 4–10 字母，不可有數字與符號）；前台 checkName 要一致
function checkName_(n) {
  if (!n) return "請填寫收件人真實姓名";
  if (/[0-9]/.test(n)) return "姓名不可包含數字";
  if (/^[\u4e00-\u9fff]+$/.test(n)) return n.length >= 2 && n.length <= 5 ? "" : "中文姓名需 2–5 字";
  if (/^[A-Za-z][A-Za-z .]*$/.test(n)) { const l = n.replace(/[ .]/g, "").length; return l >= 4 && l <= 10 ? "" : "英文姓名需 4–10 個字母"; }
  return "姓名請填寫與證件相同的中文或英文，不可有符號";
}
function placeOrder_(req) {
  const c = req.customer || {};
  c.name = String(c.name || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  c.phone = String(c.phone || "").replace(/[-\s]/g, "");
  const nameErr = checkName_(c.name);
  if (nameErr) return { ok: false, error: nameErr };
  if (!/^09\d{8}$/.test(c.phone)) return { ok: false, error: "手機格式為 09 開頭 10 碼" };
  c.line = String(c.line || "").slice(0, 40); c.address = String(c.address || "").slice(0, 150); c.note = String(c.note || "").slice(0, 300);
  if (!Array.isArray(req.items) || req.items.length > 50) return { ok: false, error: "購物車內容有誤" };
  const cache = CacheService.getScriptCache();
  const nPhone = Number(cache.get("ord:" + c.phone) || 0), nAll = Number(cache.get("ord:all") || 0);
  if (!req.clientId || !cache.get("ordc:" + req.clientId)) { // 重送同一張不算
    if (nPhone >= 5) return { ok: false, error: "下單次數過多，請稍後再試或與我們聯絡" };
    if (nAll >= 30) return { ok: false, error: "目前訂單量較大，請稍後再試" };
  }
  // admin 帶 token＋test 可在未開放時測試下單（只給後台測試用）
  if (!getSettings_().ordersOpen && !(req.test && (checkToken_(req.token) || {}).role === "owner")) return { ok: false, error: "目前尚未開放下單，敬請期待" };
  // LINE 會員：必須用 LINE 登入且已加入官方帳號好友才能下單（設定 requireLine，預設開）
  const mem = memberOf_(req.memberToken);
  if (getSettings_().requireLine !== "FALSE" && !(req.test && (checkToken_(req.token) || {}).role === "owner")) {
    if (!mem) return { ok: false, error: "請先用 LINE 登入會員", needLogin: true };
    if (!mem.friend) return { ok: false, error: "請先加入赤貧軍團官方帳號好友", needFriend: true };
  }
  const pay = ecpayCfg_().ready ? String(req.payMethod || "") : "";
  if (ecpayCfg_().ready && pay !== "Credit" && pay !== "ATM") return { ok: false, error: "請選擇付款方式" };
  if (c.shipMethod !== SHIP_HOME && c.shipMethod !== SHIP_CVS) return { ok: false, error: "請選擇寄送方式" };
  if (!c.address) return { ok: false, error: c.shipMethod === SHIP_CVS ? "請選擇 7-11 門市" : "請填寫收件地址" };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 冪等：同一個 clientId 只成立一張單（前端重送不會重複下單）
    const dup = req.clientId && rows_("orders").find(o => String(o.clientId) === String(req.clientId));
    if (dup) return Object.assign({ ok: true, orderNo: String(dup.orderNo), total: Number(dup.total) },
      dup.payStatus === "awaiting" && dup.payMethod ? { pay: ecpayForm_(dup, dup.payMethod) } : {});
    const q = quote_(req.items, req.code, c.shipMethod, mem, !!req.usePoints);
    if (!q.lines.length) return { ok: false, error: "購物車是空的" };
    if (q.errors.length) return { ok: false, error: q.errors.join("；") };
    if (req.code && q.codeError) return { ok: false, error: q.codeError };
    const orderNo = "CP" + Utilities.formatDate(new Date(), "Asia/Taipei", "yyMMddHHmmss") + Math.floor(Math.random() * 90 + 10);
    upsert_("orders", "orderNo", {
      orderNo: orderNo, createdAt: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm"),
      name: c.name, phone: c.phone, line: c.line || "", shipMethod: c.shipMethod, address: c.address || "", note: c.note || "",
      items: JSON.stringify(q.lines), subtotal: q.subtotal, tierSaving: q.tierSaving, code: q.code, codeDiscount: q.codeDiscount,
      shipping: q.shipping, packages: String(q.packages), lineUid: mem ? mem.uid : "", lineName: mem ? mem.name : "", total: q.total, status: "新訂單", payStatus: pay ? "awaiting" : "unpaid", clientId: req.clientId || "",
      payMethod: pay, pointsUsed: String(q.pointsDiscount || 0),
    });
    // 扣庫存（-1 = 不限量）
    const sh = sheet_("products"), stockCol = SHEETS.products.indexOf("stock") + 1;
    rows_("products").forEach(r => {
      const l = q.lines.find(x => x.id === String(r.id));
      if (l && r.stock !== "" && Number(r.stock) >= 0) sh.getRange(r._row, stockCol).setNumberFormat("@").setValue(String(Number(r.stock) - l.qty));
    });
    if (q.code) {
      const cr = rows_("codes").find(x => String(x.code) === q.code);
      if (cr) sheet_("codes").getRange(cr._row, SHEETS.codes.indexOf("used") + 1).setNumberFormat("@").setValue(String((Number(cr.used) || 0) + 1));
    }
    cache.put("ord:" + c.phone, String(nPhone + 1), 3600);
    cache.put("ord:all", String(nAll + 1), 600);
    if (req.clientId) cache.put("ordc:" + req.clientId, "1", 3600);
    if (!pay) lineNotifyOrder_(orderNo, "新訂單通知"); // 線上付款的單等付款成功才通知
    dropCatalog_(); // 庫存、已售數字變了
    sysLog_("顧客", "customer", "顧客下單", orderNo + "・" + c.name + "・" + q.lines.map(l => String(l.name).replace(/^.*?[｜|]\s*/, "") + "×" + l.qty).join("、") + "・$" + q.total + (pay ? "（" + (pay === "Credit" ? "信用卡" : "ATM") + "）" : ""), orderNo);
    const res = { ok: true, orderNo: orderNo, total: q.total };
    if (pay) res.pay = ecpayForm_(rows_("orders").find(o => String(o.orderNo) === orderNo), pay);
    return res;
  } finally {
    lock.releaseLock();
  }
}

/* ───────────── 後台登入 ───────────── */
function hash_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}
/* ── 帳號與分級權限（2026-11-07）──
   帳號存在指令碼屬性 USERS（JSON：名稱 → {salt, hash, role}），密碼只存加鹽雜湊。
   角色：owner 管理者（全部）／staff 營運（訂單、商品、短影音、折扣碼）／shipper 出貨（看訂單、改出貨狀態）／viewer 報表（看報表）。
   權限一律在後端檢查（ROLE_ACTIONS），前端只是把看不到的分頁藏起來。 */
const ROLES = { owner: "超級管理員", staff: "營運", shipper: "出貨", viewer: "報表", custom: "自訂" };
/* 權限項目（2026-11-08 使用者：超級管理員可逐項設定權限，並分類）。
   超級管理員（owner）永遠全部權限，另外獨有：帳號管理、重設他人密碼。
   其他帳號＝角色預設（ROLE_PERMS）或「自訂」逐項勾選（USERS[name].perms）。前端 PERMS 要跟這裡一致。 */
const PERMS = [
  ["營運總覽", [["dash", "儀表板", ["admin_dashboard"]], ["report", "報表與拆帳", ["admin_orders", "admin_expenses"]], ["expense", "登錄其他支出", ["admin_expenses", "admin_saveExpense", "admin_deleteExpense"]]]],
  ["訂單", [["orders", "查看訂單", ["admin_orders"]], ["ship", "出貨處理（狀態、寄件單、列印）", ["admin_orderStatus", "admin_logiCreate", "admin_logiPrint", "admin_logiPrintBatch"]],
            ["pay", "標記付款", ["admin_orderStatus"]], ["orderDel", "刪除訂單", ["admin_deleteOrder"]]]],
  ["商品與行銷", [["products", "商品", ["admin_saveProduct", "admin_deleteProduct", "admin_upload", "admin_trashFile"]],
                ["videos", "短影音", ["admin_saveVideo", "admin_deleteVideo", "admin_upload", "admin_trashFile"]], ["codes", "折扣碼", ["admin_saveCode", "admin_deleteCode"]]]],
  ["系統設定", [["settings", "賣場設定", ["admin_saveSettings"]],
              ["integrations", "金流、物流、LINE 通知", ["admin_ecpayStatus", "admin_saveEcpay", "admin_logiStatus", "admin_lineStatus", "admin_lineSave", "admin_lineBind", "admin_lineUnbind", "admin_lineTest", "admin_saveSettings"]]]],
];
const PERM_KEYS = [].concat.apply([], PERMS.map(g => g[1].map(p => p[0])));
const ROLE_PERMS = { staff: ["dash", "orders", "ship", "pay", "products", "videos", "codes"], shipper: ["orders", "ship"], viewer: ["dash", "report"] };
const BASE_ACTIONS = ["admin_all", "admin_me", "admin_changeLogin", "admin_lineInviteSelf"];
function permsOf_(rec) {
  if (!rec) return [];
  if (rec.role === "owner") return PERM_KEYS.slice();
  return (rec.role === "custom" && Array.isArray(rec.perms) ? rec.perms : ROLE_PERMS[rec.role] || []).filter(k => PERM_KEYS.indexOf(k) >= 0);
}
const has_ = (me, p) => me.role === "owner" || (me.perms || []).indexOf(p) >= 0;
function can_(me, action) {
  if (me.role === "owner") return true;
  if (BASE_ACTIONS.indexOf(action) >= 0) return true;
  return PERMS.some(g => g[1].some(p => (me.perms || []).indexOf(p[0]) >= 0 && p[2].indexOf(action) >= 0));
}
function users_() {
  const p = PropertiesService.getScriptProperties();
  let u = json_(p.getProperty("USERS"), null);
  if (!u) { // 舊版單一帳號 → 轉成管理者
    u = {};
    if (p.getProperty("ADMIN_HASH")) u[p.getProperty("ADMIN_USER")] = { salt: p.getProperty("ADMIN_SALT"), hash: p.getProperty("ADMIN_HASH"), role: "owner" };
    p.setProperty("USERS", JSON.stringify(u));
  }
  return u;
}
function saveUsers_(u) { PropertiesService.getScriptProperties().setProperty("USERS", JSON.stringify(u)); }
function setAdmin_(user, pass, role) {
  const u = users_(), salt = Utilities.getUuid();
  u[user] = Object.assign({}, u[user] || {}, { salt: salt, hash: hash_(salt + ":" + pass), role: role || (u[user] && u[user].role) || "owner" });
  saveUsers_(u);
}
// 讓某帳號的所有登入失效（刪帳號、改密碼時用）；keepToken＝保留目前這台
function revokeUser_(user, keepToken) {
  const p = PropertiesService.getScriptProperties(), all = p.getProperties(), keep = keepToken ? "SESS_" + hash_(keepToken) : "";
  Object.keys(all).forEach(k => {
    if (k.indexOf("SESS_REVOKED_") === 0) { if (Number(all[k + "_AT"] || 0) < Date.now() - 86400000) { p.deleteProperty(k); p.deleteProperty(k + "_AT"); } return; }
    if (k.indexOf("SESS_") !== 0 || k === keep) return;
    const owner = String(all[k]).split("|")[1] || "";
    if (owner === user || (!owner && user === "*legacy")) {
      p.deleteProperty(k); p.setProperty("SESS_REVOKED_" + k.slice(5), "1"); p.setProperty("SESS_REVOKED_" + k.slice(5) + "_AT", String(Date.now()));
    }
  });
}
function login_(user, pass) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("loginFails") || 0);
  if (fails >= 8) return { ok: false, error: "嘗試次數過多，請 10 分鐘後再試" };
  user = String(user || "").normalize("NFKC").trim(); pass = String(pass || "").normalize("NFKC").trim(); // 全形「０１」也能登入
  const rec = users_()[user];
  if (!rec || hash_(rec.salt + ":" + pass) !== rec.hash) {
    cache.put("loginFails", String(fails + 1), 600);
    return { ok: false, error: "帳號或密碼錯誤" };
  }
  return Object.assign(issueSession_(user), { role: rec.role, isDefault: pass === "01" });
}
function issueSession_(user) {
  const cache = CacheService.getScriptCache();
  const token = Utilities.getUuid() + Utilities.getUuid();
  const props = PropertiesService.getScriptProperties(), now = Date.now();
  Object.keys(props.getProperties()).forEach(k => { if (k.indexOf("SESS_") === 0 && k.indexOf("SESS_REVOKED_") < 0 && Number(String(props.getProperty(k)).split("|")[0]) < now) props.deleteProperty(k); });
  props.setProperty("SESS_" + hash_(token), (now + SESSION_DAYS * 86400000) + "|" + user);
  // 指令碼屬性剛寫入時，下一個請求偶爾讀不到（10-31 實測：登入後第一個動作回 auth），所以同時放快取（最長 6 小時）
  cache.put("tok:" + token, user, 21600);
  return { ok: true, token: token, user: user };
}
// 回傳 {user, role}；無效回 null。角色每次即時查，所以改權限、刪帳號立刻生效
function checkToken_(t) {
  if (!t) return null;
  const p = PropertiesService.getScriptProperties(), h = hash_(t);
  let user = CacheService.getScriptCache().get("tok:" + t);
  if (user && p.getProperty("SESS_REVOKED_" + h) === "1") user = null;
  if (!user) {
    const v = String(p.getProperty("SESS_" + h) || ""), parts = v.split("|");
    if (!(Number(parts[0]) > Date.now())) return null;
    user = parts[1] || p.getProperty("ADMIN_USER") || ""; // 舊格式 session 沒記帳號 → 視為原本的管理者
  }
  if (user === "1") user = p.getProperty("ADMIN_USER") || ""; // 舊快取值
  const rec = users_()[user];
  return rec ? { user: user, role: rec.role, perms: permsOf_(rec) } : null;
}

/* ───────────── 後台動作 ───────────── */
const ADMIN = {
  admin_all: r => ({
    products: withSold_(rows_("products").map(product_)).sort((a, b) => a.sort - b.sort),
    videos: rows_("videos").map(video_).sort((a, b) => a.sort - b.sort),
    codes: rows_("codes").map(code_),
    settings: getSettings_(), me: r.me,
  }),
  admin_me: r => ({ me: r.me, roles: ROLES }),
  admin_dashboard: r => dashboard_(r),
  // LINE 授權（只有超級管理員；不在任何權限項目）：產生一次性邀請連結、解除綁定
  admin_lineInvite: r => {
    const name = String(r.name || ""); if (!users_()[name]) throw new Error("查無此帳號");
    if (name !== r.me.user && users_()[name].role === "owner" && r.me.role !== "owner") throw new Error("此帳號沒有權限");
    const p = PropertiesService.getScriptProperties(), all = p.getProperties();
    Object.keys(all).filter(k => k.indexOf("INV_") === 0 && json_(all[k], {}).user === name).forEach(k => p.deleteProperty(k)); // 舊邀請作廢
    const t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    const exp = Date.now() + 7 * 86400000;
    p.setProperty("INV_" + hash_(t), JSON.stringify({ user: name, exp: exp, by: r.me.user }));
    return { url: "https://linpoyes.github.io/lipo-guide/admin.html#inv=" + t, exp: Utilities.formatDate(new Date(exp), "Asia/Taipei", "yyyy/MM/dd HH:mm") };
  },
  admin_lineInviteSelf: r => ADMIN.admin_lineInvite(Object.assign({}, r, { name: r.me.user })), // 每個帳號都能綁定自己的 LINE
  admin_lineUnbindUser: r => {
    const u = users_(), name = String(r.name || ""); if (!u[name]) throw new Error("查無此帳號");
    ["lineUid", "lineName", "linePic", "lineAt"].forEach(k => delete u[name][k]); saveUsers_(u);
    if (name !== r.me.user) revokeUser_(name);
  },
  // 操作紀錄只有超級管理員（不在任何權限項目裡，can_ 只放行 owner）
  admin_audit: r => {
    const sh = sheet_("audit"), n = sh.getLastRow() - 1; if (n < 1) return { logs: [] };
    const take = Math.min(n, 1000), rows = sh.getRange(n - take + 2, 1, take, SHEETS.audit.length).getValues();
    return { logs: rows.reverse().map(a => ({ ts: String(a[0]), user: String(a[1]), role: String(a[2]), action: String(a[3]), detail: String(a[4]), target: String(a[5]) })) };
  },
  admin_logiCreate: r => ({ shipments: logiCreate_(String(r.orderNo), !!r.again) }),
  admin_logiPrint: r => logiPrint_(String(r.orderNo)),
  admin_logiPrintBatch: r => logiPrintBatch_((r.orderNos || []).map(String)),
  admin_logiStatus: () => ({ logi: logiCfg_().public }),
  // 用正式商店代號送一張「故意缺門市」的單：只看綠界回什麼錯（金鑰錯／未開通物流／參數錯），不會真的成立
  admin_logiProbe: () => { const c = logiCfg_(true); const p = { MerchantID: c.mid, MerchantTradeDate: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss"),
    LogisticsType: "CVS", LogisticsSubType: "UNIMARTC2C", GoodsAmount: "100", CollectionAmount: "100", IsCollection: "N", GoodsName: "測試", SenderName: "測試人員", SenderCellPhone: "0912345678",
    ReceiverName: "測試人員", ReceiverCellPhone: "0912345678", ServerReplyURL: EXEC_URL + "?cb=logi" };
    p.CheckMacValue = logiMac_(p, c); return { live: !c.stage, reply: logiPost_(c.host + "/Express/Create", p).slice(0, 200) }; },
  // 清掉某個訪客碼的流量（測試用資料）；只有管理者
  admin_trafficPurge: r => {
    const sh = sheet_("traffic"), n = sh.getLastRow() - 1, vid = String(r.vid || ""); if (n < 1 || !vid) return { removed: 0 };
    const col = sh.getRange(2, 2, n, 1).getValues(); let removed = 0;
    for (let i = n - 1; i >= 0; i--) if (String(col[i][0]) === vid) { sh.deleteRow(i + 2); removed++; }
    return { removed: removed };
  },
  admin_users: () => { const u = users_(); return { users: Object.keys(u).map(n => ({ name: n, role: u[n].role, perms: permsOf_(u[n]),
      line: u[n].lineUid ? { name: u[n].lineName || "", pic: u[n].linePic || "", at: u[n].lineAt || "" } : null, invite: inviteOf_(n) })), roles: ROLES,
    perms: PERMS.map(g => [g[0], g[1].map(p => [p[0], p[1]])]), rolePerms: ROLE_PERMS }; },
  admin_saveUser: r => {
    const name = String(r.name || "").normalize("NFKC").trim(), role = String(r.role || ""), pass = String(r.pass || "").normalize("NFKC").trim();
    if (!/^[\w.@-]{2,20}$/.test(name)) throw new Error("帳號限英數字 2–20 碼");
    if (!ROLES[role]) throw new Error("請選擇權限");
    const u = users_(), isNew = !u[name];
    if (isNew && pass && pass.length < 4) throw new Error("密碼至少 4 碼");
    if (isNew && !pass) { setAdmin_(name, Utilities.getUuid() + Utilities.getUuid(), role); } // 只用 LINE 登入的帳號：隨機密碼，無法用密碼登入
    if (!isNew && u[name].role === "owner" && role !== "owner" && Object.keys(u).filter(n => u[n].role === "owner").length < 2) throw new Error("至少要保留一個超級管理員");
    if (name === r.me.user && role !== "owner") throw new Error("不能降低自己的權限");
    if (pass) { setAdmin_(name, pass, role); if (!isNew) revokeUser_(name); }
    else { u[name].role = role; saveUsers_(u); }
    // 自訂權限：只存合法的項目；改回預設角色就清掉
    const u2 = users_();
    if (role === "custom") u2[name].perms = (Array.isArray(r.perms) ? r.perms : []).filter(k => PERM_KEYS.indexOf(k) >= 0); else delete u2[name].perms;
    saveUsers_(u2);
  },
  admin_deleteUser: r => {
    const u = users_(), name = String(r.name || "");
    if (!u[name]) return;
    if (name === r.me.user) throw new Error("不能刪除自己");
    if (u[name].role === "owner" && Object.keys(u).filter(n => u[n].role === "owner").length < 2) throw new Error("至少要保留一個超級管理員");
    delete u[name]; saveUsers_(u); revokeUser_(name);
  },
  admin_orders: () => (expireOrders_(true), {
    orders: rows_("orders").map(o => ({
      orderNo: String(o.orderNo), createdAt: String(o.createdAt), name: String(o.name), phone: String(o.phone),
      line: String(o.line), shipMethod: String(o.shipMethod), address: String(o.address), note: String(o.note),
      items: json_(o.items, []), subtotal: Number(o.subtotal), tierSaving: Number(o.tierSaving), code: String(o.code),
      codeDiscount: Number(o.codeDiscount), shipping: Number(o.shipping), packages: Number(o.packages) || 1, total: Number(o.total),
      status: String(o.status), payStatus: String(o.payStatus), lineName: String(o.lineName || ""), lineUid: String(o.lineUid || ""), payMethod: String(o.payMethod || ""), payFee: Number(o.payFee) || 0,
      feeSrc: String(o.feeSrc || ""), paidAt: String(o.paidAt || ""), vaBank: String(o.vaBank || ""), vaAccount: String(o.vaAccount || ""), vaExpire: String(o.vaExpire || ""), pointsUsed: Number(o.pointsUsed) || 0, shipments: json_(o.shipments, []), logiCost: logiCostOf_(o),
    })).reverse(),
  }),
  admin_saveProduct: r => {
    const p = r.product || {};
    if (!p.name) throw new Error("請填寫商品名稱");
    const id = p.id || "p" + Date.now().toString(36);
    upsert_("products", "id", {
      id: id, name: p.name, category: p.category || "", price: String(Number(p.price) || 0),
      listPrice: String(Number(p.listPrice) || 0), desc: p.desc || "", images: JSON.stringify(p.images || []),
      tiers: JSON.stringify((p.tiers || []).filter(t => Number(t.qty) > 1 && Number(t.price) > 0)
        .map(t => ({ qty: Number(t.qty), price: Number(t.price) })).sort((a, b) => a.qty - b.qty)),
      stock: p.stock === "" || p.stock === null || p.stock === undefined ? "-1" : String(Number(p.stock)),
      active: p.active ? "TRUE" : "FALSE", hot: p.hot ? "TRUE" : "FALSE", sort: String(Number(p.sort) || 0),
      updatedAt: new Date().toISOString(), cvsOk: p.cvsOk ? "TRUE" : "FALSE", brand: String(p.brand || "").normalize("NFKC").trim(),
      supplier: String(p.supplier || "").normalize("NFKC").trim(), commission: String(Math.max(0, Math.min(100, Number(p.commission) || 0))),
      cost: String(Math.max(0, Number(p.cost) || 0)), splitMode: p.splitMode === "commission" ? "commission" : "profit", costBy: p.costBy === "owner" ? "owner" : "us",
      preorder: p.preorder ? "TRUE" : "FALSE", dims: dims_(p.dims).join(","), weight: String(Math.max(0, Number(p.weight) || 0)), cvsPer: String(Math.max(0, Math.floor(Number(p.cvsPer) || 0))), homePer: String(Math.max(0, Math.floor(Number(p.homePer) || 0))),
    });
    return { id: id };
  },
  admin_deleteProduct: r => { remove_("products", "id", r.id); },
  admin_saveVideo: r => {
    const v = r.video || {};
    if (!v.src) throw new Error("請上傳影片或貼上連結");
    const id = v.id || "v" + Date.now().toString(36);
    upsert_("videos", "id", { id: id, title: v.title || "", src: v.src, poster: v.poster || "", productId: v.productId || "",
      active: v.active ? "TRUE" : "FALSE", sort: String(Number(v.sort) || 0), updatedAt: new Date().toISOString() });
    return { id: id };
  },
  admin_deleteVideo: r => { remove_("videos", "id", r.id); },
  admin_saveCode: r => {
    const c = r.codeObj || {};
    const code = String(c.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw new Error("折扣碼限英數字 2–20 碼");
    if (c.type === "percent" && !(c.value > 0 && c.value < 100)) throw new Error("折扣 % 需介於 1–99");
    if (c.type === "amount" && !(c.value > 0)) throw new Error("折抵金額需大於 0");
    upsert_("codes", "code", { code: code, type: c.type === "amount" ? "amount" : "percent", value: String(Number(c.value)),
      minSpend: String(Number(c.minSpend) || 0), startAt: c.startAt || "", endAt: c.endAt || "",
      limit: String(Number(c.limit) || 0), active: c.active ? "TRUE" : "FALSE", note: c.note || "", member: c.member ? "TRUE" : "FALSE" });
    if (c.renamedFrom && String(c.renamedFrom).toUpperCase() !== code) remove_("codes", "code", c.renamedFrom);
    return { code: code };
  },
  admin_deleteCode: r => { remove_("codes", "code", r.code); },
  admin_orderStatus: r => {
    if (!has_(r.me, r.field === "payStatus" ? "pay" : "ship")) throw new Error("此帳號沒有權限");
    const nos = r.orderNos || [r.orderNo];
    const sh = sheet_("orders"), col = SHEETS.orders.indexOf(r.field === "payStatus" ? "payStatus" : "status") + 1;
    rows_("orders").forEach(o => {
      if (nos.indexOf(String(o.orderNo)) < 0) return;
      sh.getRange(o._row, col).setNumberFormat("@").setValue(String(r.value));
      // 改成已取消＝退回庫存與折扣碼次數；從已取消改回來＝重新扣
      if (r.field !== "payStatus" && String(r.value) === "已取消" && String(o.status) !== "已取消") releaseOrder_(o);
      if (r.field !== "payStatus" && String(r.value) !== "已取消" && String(o.status) === "已取消") reclaimOrder_(o);
    });
  },
  admin_expenses: () => ({ expenses: rows_("expenses").map(x => ({ id: String(x.id), date: String(x.date), item: String(x.item), amount: Number(x.amount) || 0, note: String(x.note || ""), scope: String(x.scope || "all") })) }),
  admin_saveExpense: r => {
    const x = r.expense || {}, amt = Math.round(Number(x.amount) || 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.date || ""))) throw new Error("請選擇日期");
    if (!String(x.item || "").trim()) throw new Error("請填寫項目");
    if (!(amt > 0)) throw new Error("金額需大於 0");
    const id = x.id || "e" + Date.now().toString(36);
    upsert_("expenses", "id", { id: id, date: x.date, item: String(x.item).trim().slice(0, 40), amount: String(amt), note: String(x.note || "").slice(0, 100), scope: String(x.scope || "all").slice(0, 40) });
    return { id: id };
  },
  admin_deleteExpense: r => { remove_("expenses", "id", r.id); },
  // 一次性設定 GitHub 權杖（只存在指令碼屬性，不進版控）；需要 repo contents 寫入權限
  admin_setGithubToken: r => { PropertiesService.getScriptProperties().setProperty("GH_TOKEN", String(r.ghToken || "")); },
  admin_deleteOrder: r => { remove_("orders", "orderNo", r.orderNo); },
  // 只刪媒體資料夾裡的檔案（避免拿 token 刪到雲端硬碟其他東西）
  admin_trashFile: r => {
    const folder = PropertiesService.getScriptProperties().getProperty("MEDIA_FOLDER");
    const f = DriveApp.getFileById(r.fileId);
    const parents = f.getParents();
    while (parents.hasNext()) if (parents.next().getId() === folder) { f.setTrashed(true); return; }
    throw new Error("非賣場媒體檔案");
  },
  // 綠界金鑰：只寫不讀（後台只顯示「已設定」與商店代號）
  admin_saveEcpay: r => {
    const p = PropertiesService.getScriptProperties(), e = r.ecpay || {};
    if (e.mid !== undefined && e.mid !== "") p.setProperty("ECPAY_MID", String(e.mid).trim());
    if (e.key) p.setProperty("ECPAY_KEY", String(e.key).trim());
    if (e.iv) p.setProperty("ECPAY_IV", String(e.iv).trim());
    if (e.stage !== undefined) p.setProperty("ECPAY_STAGE", e.stage ? "TRUE" : "FALSE");
    if (e.enabled !== undefined) p.setProperty("ECPAY_ON", e.enabled ? "TRUE" : "FALSE");
    return { ecpay: ecpayCfg_().public };
  },
  admin_ecpayStatus: () => ({ ecpay: ecpayCfg_().public }),
  // ── LINE 官方帳號通知 ──
  admin_lineStatus: () => lineStatus_(),
  admin_setLoginSecret: r => { PropertiesService.getScriptProperties().setProperty("LINE_LOGIN_SECRET", String(r.secret || "").trim()); },
  admin_lineSave: r => { if (r.lineToken) PropertiesService.getScriptProperties().setProperty("LINE_TOKEN", String(r.lineToken).trim()); return lineStatus_(); },
  admin_lineBind: () => {  // 產生 6 碼綁定碼（10 分鐘有效），在 LINE 傳給官方帳號就完成綁定
    const code = String(Math.floor(100000 + Math.random() * 900000));
    CacheService.getScriptCache().put("lineBind", code, 600);
    return { code: code };
  },
  admin_lineUnbind: r => { const p = PropertiesService.getScriptProperties(), l = json_(p.getProperty("LINE_USERS"), []).filter(x => x.id !== r.id); p.setProperty("LINE_USERS", JSON.stringify(l)); return lineStatus_(); },
  admin_lineTest: () => { const n = linePush_("【赤貧軍團】LINE 通知測試成功"); if (!n) throw new Error("沒有已綁定的 LINE 或權杖無效"); return { sent: n }; },
  admin_saveSettings: r => {
    const s = r.settings || {};
    const integ = ["logiOn", "logiStage", "logiAuto", "senderName", "senderPhone", "senderZip", "senderAddr", "logiSize", "logiFeeCvs", "logiFeeHome", "homeBox"];
    const keys = Object.keys(s);
    if (keys.some(k => integ.indexOf(k) >= 0) && !has_(r.me, "integrations")) throw new Error("此帳號沒有權限");
    if (keys.some(k => integ.indexOf(k) < 0) && !has_(r.me, "settings")) throw new Error("此帳號沒有權限");
    ["shipFee", "shipFeeCvs", "freeShipOver", "lineUrl", "notice", "ordersOpen", "requireLine", "shipBarOn", "shipBar", "feeCardPct", "feeCardMin", "feeCardOrder", "feeAtmPct", "feeAtmMin", "feeSplit", "welcomeCode", "welcomeDays", "welcomeRemind", "hotWords", "capital", "pointsOn", "pointRate", "pointMaxPct", "logiOn", "logiStage", "logiAuto", "senderName", "senderPhone", "senderZip", "senderAddr", "logiSize", "logiFeeCvs", "logiFeeHome", "homeBox"].forEach(k => { if (s[k] !== undefined) setSetting_(k, s[k]); });
  },
  admin_changeLogin: r => {
    const nf = v => String(v || "").normalize("NFKC").trim(); // 跟登入一樣正規化
    const me = r.me.user, u = users_(), rec = u[me];
    if (hash_(rec.salt + ":" + nf(r.oldPass)) !== rec.hash) throw new Error("目前密碼錯誤");
    const newUser = nf(r.newUser) || me, newPass = nf(r.newPass);
    if (newPass.length < 2) throw new Error("新密碼至少 2 碼");
    if (newUser !== me) { if (u[newUser]) throw new Error("帳號名稱已被使用"); delete u[me]; saveUsers_(u); }
    setAdmin_(newUser, newPass, rec.role);
    revokeUser_(me, r.token); // 其他裝置登出、保留目前這台
    if (newUser !== me) { const p = PropertiesService.getScriptProperties(), k = "SESS_" + hash_(r.token); p.setProperty(k, String(p.getProperty(k)).split("|")[0] + "|" + newUser); CacheService.getScriptCache().put("tok:" + r.token, newUser, 21600); }
  },
  // 上傳：影片 → 直接存進網站 repo 的 media/（GitHub Pages 同網域，<video> 才能直接播放）；
  // 圖片 → 雲端硬碟（lh3 縮圖網址外站可用）。
  // 為什麼影片不能放雲端硬碟：Drive 直連沒有給外站的 CORS 標頭、又帶 CORP same-site，瀏覽器一律擋（2026-10-31 實測 error 4）。
  admin_upload: r => {
    const gh = PropertiesService.getScriptProperties().getProperty("GH_TOKEN");
    if (String(r.mime || "").indexOf("video/") === 0 && gh) {
      if (r.data.length > 41 * 1024 * 1024) throw new Error("影片超過 30MB，請先壓縮");
      const ext = (String(r.name || "").match(/\.(mp4|mov|m4v|webm)$/i) || [, "mp4"])[1].toLowerCase();
      const path = "media/v" + Date.now().toString(36) + "." + ext;
      const res = UrlFetchApp.fetch("https://api.github.com/repos/" + GH_REPO + "/contents/" + path, {
        method: "put", contentType: "application/json", muteHttpExceptions: true,
        headers: { Authorization: "Bearer " + gh, Accept: "application/vnd.github+json" },
        payload: JSON.stringify({ message: "賣場短影音上傳 " + path, content: r.data, branch: "main" }),
      });
      if (res.getResponseCode() >= 300) throw new Error("影片上傳失敗（GitHub " + res.getResponseCode() + "）");
      return { src: path };
    }
    const bytes = Utilities.base64Decode(r.data);
    if (bytes.length > 40 * 1024 * 1024) throw new Error("檔案超過 40MB");
    const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty("MEDIA_FOLDER"));
    const f = folder.createFile(Utilities.newBlob(bytes, r.mime || "application/octet-stream", r.name || "upload"));
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return { fileId: f.getId() };
  },
};

/* ───────────── 7-11 電子地圖回傳 ───────────── */
// 7-11 交貨便電子地圖（emap.presco.com.tw/c2cemap.ashx）選完門市會 POST：storeid／storename／storeaddress（大小寫不一，全部容錯）。
// 回一個小頁面把門市帶回賣場網址的 #store=…；Apps Script 頁面在 iframe 裡，跳轉要用使用者點擊（target=_top），自動跳轉當備援。
const SHOP_PAGE = "https://linpoyes.github.io/lipo-guide/shop.html";
const GH_REPO = "linpoyes/lipo-guide";
const EXEC_URL = "https://script.google.com/macros/s/AKfycbxtUHvT661QSFsB8ACP0QSMq-8PCR9GIxFzXRFzArl4vswAy2YBd5ZbaSIrfGtcKls/exec"; // 固定部署網址（綠界回呼用）
function storeReturn_(p) {
  const pick = keys => { for (const k in p) if (keys.indexOf(k.toLowerCase()) >= 0 && p[k]) return String(p[k]); return ""; };
  const clean = (v, n) => v.replace(/[<>"'`\\]/g, "").slice(0, n);
  const store = { id: clean(pick(["storeid", "cvsstoreid"]), 10).replace(/\D/g, ""), name: clean(pick(["storename", "cvsstorename"]), 20), addr: clean(pick(["storeaddress", "cvsaddress"]), 80) };
  const url = SHOP_PAGE + "#store=" + encodeURIComponent(JSON.stringify(store));
  if (p.sk && /^\d{8,60}$/.test(String(p.sk))) CacheService.getScriptCache().put("store:" + p.sk, JSON.stringify(store), 1800);
  const safe = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const label = (store.name ? "7-11 " + store.name + "門市" : "門市").replace(/[<>&]/g, "");
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:-apple-system,sans-serif;text-align:center;padding:40px 16px">' +
    '<p style="font-size:18px;font-weight:700">已選擇 ' + label + '</p>' +
    '<a href="' + safe + '" target="_top" style="display:inline-block;margin-top:12px;padding:12px 28px;border-radius:12px;background:#D7261E;color:#fff;font-weight:800;text-decoration:none;font-size:17px">回到賣場</a></div>' +
    // 新分頁模式：賣場會自己帶回門市，這一頁直接關掉；同頁模式才跳轉
    '<script>' + (p.sk ? 'try{window.top.close()}catch(e){}' : 'try{window.top.location.href=' + JSON.stringify(url) + '}catch(e){}') + '</script>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ───────────── 綠界金流（信用卡＋ATM 虛擬帳號）──────────────
   與欣瀚賣場共用同一組綠界特店（使用者 2026-11-07）。正式金鑰只存指令碼屬性，後台只能寫入不能讀出。
   流程：下單 → 回傳簽好章的表單 → 前端自動送到綠界 → 客人付款
         ReturnURL（?cb=ecpay）     付款結果，server→server，驗章後標記 paid 並記手續費，回 1|OK
         PaymentInfoURL（?cb=ecpayinfo） ATM 取號結果，存虛擬帳號
         ClientRedirectURL（?cb=ecpayback） ATM 取號後把客人帶回賣場
         ClientBackURL                  付款完成後回賣場（不代表付款成功，賣場會再查一次狀態） */
function ecpayCfg_() {
  const p = PropertiesService.getScriptProperties();
  const stage = p.getProperty("ECPAY_STAGE") !== "FALSE"; // 預設測試模式，確認正式金鑰後才關
  const on = p.getProperty("ECPAY_ON") === "TRUE";
  const mid = stage ? ECPAY_STAGE.mid : p.getProperty("ECPAY_MID") || "";
  const key = stage ? ECPAY_STAGE.key : p.getProperty("ECPAY_KEY") || "";
  const iv = stage ? ECPAY_STAGE.iv : p.getProperty("ECPAY_IV") || "";
  const host = stage ? "https://payment-stage.ecpay.com.tw" : "https://payment.ecpay.com.tw";
  return { ready: on && !!(mid && key && iv), stage, mid, key, iv, host,
    public: { enabled: on, stage, mid: p.getProperty("ECPAY_MID") || "", keySet: !!p.getProperty("ECPAY_KEY"), ivSet: !!p.getProperty("ECPAY_IV") } };
}
function dotNetEncode_(s) {
  return encodeURIComponent(s).replace(/%20/g, "+").replace(/%21/g, "!").replace(/%27/g, "'").replace(/%28/g, "(")
    .replace(/%29/g, ")").replace(/%2a/gi, "*").replace(/%2d/gi, "-").replace(/%2e/gi, ".").replace(/%5f/gi, "_");
}
function checkMac_(params, cfg) {
  const sorted = Object.keys(params).filter(k => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)
    .map(k => k + "=" + params[k]).join("&");
  const raw = dotNetEncode_("HashKey=" + cfg.key + "&" + sorted + "&HashIV=" + cfg.iv).toLowerCase();
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("").toUpperCase();
}
function ecpayForm_(order, method) {
  const cfg = ecpayCfg_(), exec = EXEC_URL;
  // 綠界不收重複單號：每次付款用新的綠界單號（訂單編號＋2 碼），記在 ecpayNo
  const tradeNo = String(order.orderNo) + Utilities.getUuid().replace(/\D/g, "").slice(0, 2);
  setOrderField_(String(order.orderNo), { ecpayNo: tradeNo, payMethod: method });
  const items = json_(order.items, []).map(i => i.name.replace(/[#&]/g, " ") + " x" + i.qty).join("#").slice(0, 200);
  const p = {
    MerchantID: cfg.mid, MerchantTradeNo: tradeNo,
    MerchantTradeDate: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss"),
    PaymentType: "aio", TotalAmount: String(Math.round(Number(order.total))), TradeDesc: "赤貧軍團線上訂單", ItemName: items,
    ReturnURL: exec + "?cb=ecpay", ClientBackURL: SHOP_PAGE + "#paid=" + order.orderNo,
    ChoosePayment: method, EncryptType: "1",
  };
  // 只開信用卡與 ATM 虛擬帳號（使用者 2026-11-07）：其他電子支付一律隱藏
  p.IgnorePayment = "WebATM#CVS#BARCODE#ApplePay#TWQR#BNPL";
  if (method === "ATM") { p.PaymentInfoURL = exec + "?cb=ecpayinfo"; p.ClientRedirectURL = exec + "?cb=ecpayback"; p.ExpireDate = "3"; }
  p.CheckMacValue = checkMac_(p, cfg);
  return { url: cfg.host + "/Cashier/AioCheckOut/V5", fields: p };
}
function setOrderField_(orderNo, obj) {
  const o = rows_("orders").find(x => String(x.orderNo) === orderNo); if (!o) return null;
  upsert_("orders", "orderNo", Object.assign({ orderNo: orderNo }, obj));
  return o;
}
function orderByTrade_(tradeNo) { return rows_("orders").find(o => String(o.ecpayNo) === String(tradeNo)); }
// 手續費估算（依後台設定的費率；含 5% 營業稅；信用卡另加每筆處理費）
function payFee_(method, amount) {
  const s = getSettings_(), n = x => Number(x) || 0;
  if (/^Credit/.test(method)) return Math.round(Math.max(amount * n(s.feeCardPct) / 100, n(s.feeCardMin)) * 1.05) + n(s.feeCardOrder);
  if (/^ATM/.test(method)) return Math.round(Math.max(amount * n(s.feeAtmPct) / 100, n(s.feeAtmMin)) * 1.05);
  return 0;
}
// 網址上的 ?cb= 會混進 e.parameter，算章前要拿掉（只算綠界送來的欄位）
function verified_(p) {
  const q = Object.assign({}, p); delete q.cb;
  return !!q.CheckMacValue && String(q.CheckMacValue).toUpperCase() === checkMac_(q, ecpayCfg_());
}
function ecpayReturn_(p) {
  const text = t => ContentService.createTextOutput(t);
  if (!verified_(p)) return text("0|CheckMacValue Error");
  const o = orderByTrade_(p.MerchantTradeNo); if (!o) return text("1|OK");
  if (String(p.RtnCode) === "1") {
    const amt = Number(p.TradeAmt) || Number(o.total);
    setOrderField_(String(o.orderNo), { payStatus: "paid", payMethod: String(p.PaymentType || o.payMethod), payFee: String(payFee_(String(p.PaymentType || o.payMethod), amt)),
      paidAt: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm") });
    if (String(o.status) === "已取消" && String(o.restocked) === "TRUE") { // 逾期取消後才付款成功：恢復訂單、重新扣庫存
      reclaimOrder_(o); setOrderField_(String(o.orderNo), { status: "新訂單" });
    }
    try { const real = ecpayFee_(String(p.MerchantTradeNo)); if (real !== null) setOrderField_(String(o.orderNo), { payFee: String(real), feeSrc: "ecpay" }); } catch (e) {} // 換成綠界實際扣的手續費
    if (String(o.payStatus) !== "paid") {
      if (logiCfg_().auto) try { logiCreate_(String(o.orderNo)); } catch (err) {} // 付款成功自動建綠界寄件單，通知裡就有交貨便代號／託運單號
      lineNotifyOrder_(String(o.orderNo), "付款完成・待出貨");
      sysLog_("綠界", "system", "付款完成", o.orderNo + "・$" + (Number(p.TradeAmt) || o.total) + "・" + (/^Credit/.test(String(p.PaymentType)) ? "信用卡" : "ATM"), String(o.orderNo));
    }
  } else if (String(o.payStatus) !== "paid" && !/^ATM/.test(String(p.PaymentType))) {
    setOrderField_(String(o.orderNo), { payStatus: "failed" });
  }
  return text("1|OK");
}
function ecpayInfo_(p) {
  const text = t => ContentService.createTextOutput(t);
  if (!verified_(p)) return text("0|CheckMacValue Error");
  const o = orderByTrade_(p.MerchantTradeNo);
  if (o && String(p.RtnCode) === "2") setOrderField_(String(o.orderNo), { vaBank: String(p.BankCode || ""), vaAccount: String(p.vAccount || ""), vaExpire: String(p.ExpireDate || "") });
  return text("1|OK");
}
function ecpayBack_(p) {
  const o = verified_(p) ? orderByTrade_(p.MerchantTradeNo) : null;
  if (o && p.vAccount) setOrderField_(String(o.orderNo), { vaBank: String(p.BankCode || ""), vaAccount: String(p.vAccount || ""), vaExpire: String(p.ExpireDate || "") });
  const url = SHOP_PAGE + "#paid=" + (o ? o.orderNo : "");
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:-apple-system,sans-serif;text-align:center;padding:40px 16px">' +
    '<p style="font-size:18px;font-weight:700">已取得轉帳帳號</p><a href="' + url + '" target="_top" style="display:inline-block;margin-top:12px;padding:12px 28px;border-radius:12px;background:#C9362C;color:#fff;font-weight:800;text-decoration:none;font-size:17px">回到賣場查看帳號</a></div>' +
    '<script>try{window.top.location.href=' + JSON.stringify(url) + '}catch(e){}</script>').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
// 賣場查自己訂單的付款狀態：要訂單編號＋下單時的 clientId（存在客人瀏覽器），別人猜不到
function orderStatus_(q) {
  const o = rows_("orders").find(x => String(x.orderNo) === String(q.no || ""));
  if (!o || !q.cid || String(o.clientId) !== String(q.cid)) return { ok: false, error: "查無訂單" };
  return { ok: true, orderNo: String(o.orderNo), total: Number(o.total), payStatus: String(o.payStatus), payMethod: String(o.payMethod || ""),
    vaBank: String(o.vaBank || ""), vaAccount: String(o.vaAccount || ""), vaExpire: String(o.vaExpire || "") };
}

/* ───────────── LINE 官方帳號：新訂單／付款通知（2026-11-07）─────────────
   官方帳號「赤貧軍團」@552xxfur，Messaging API channel 2012454428（provider 赤貧軍團）。
   權杖存指令碼屬性 LINE_TOKEN（只寫不讀）；收通知的人存 LINE_USERS [{id, name}]。
   綁定：後台按「產生綁定碼」→ 在 LINE 對官方帳號傳那 6 碼。
   GAS 讀不到 X-Line-Signature 標頭，無法驗章 → 只處理「傳對綁定碼」這一種事件，其他一律忽略，偽造請求也綁不進來。 */
function lineStatus_() {
  const p = PropertiesService.getScriptProperties();
  return { line: { tokenSet: !!p.getProperty("LINE_TOKEN"), users: json_(p.getProperty("LINE_USERS"), []) } };
}
function lineApi_(path, body) {
  const tk = PropertiesService.getScriptProperties().getProperty("LINE_TOKEN"); if (!tk) return null;
  const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/" + path, { method: body ? "post" : "get", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + tk }, payload: body ? JSON.stringify(body) : undefined });
  return res;
}
function linePush_(text) {
  const users = json_(PropertiesService.getScriptProperties().getProperty("LINE_USERS"), []);
  let n = 0;
  users.forEach(u => { const r = lineApi_("message/push", { to: u.id, messages: [{ type: "text", text: text.slice(0, 4900) }] }); if (r && r.getResponseCode() === 200) n++; });
  return n;
}
function lineNotifyOrder_(orderNo, title) {
  try {
    const o = rows_("orders").find(x => String(x.orderNo) === orderNo); if (!o) return;
    const items = json_(o.items, []).map(i => "・" + i.name.replace(/^JXC 1\/43 迷你漂移遙控車｜/, "") + " ×" + i.qty).join("\n");
    const cvs = String(o.shipMethod).indexOf("7-11") === 0;
    const pay = /^Credit/.test(o.payMethod) ? "信用卡" : /^ATM/.test(o.payMethod) ? "ATM 轉帳" : "未線上付款";
    linePush_(["【赤貧軍團】" + title, "訂單編號：" + o.orderNo, items,
      "金額：$" + Number(o.total).toLocaleString() + "（" + pay + "）",
      "寄送方式：" + o.shipMethod + "・" + (Number(o.packages) || 1) + (cvs ? " 個交貨便" : " 箱宅急便"),
      "收件人：" + o.name + "　" + o.phone, (cvs ? "門市：" : "地址：") + o.address, o.note ? "備註：" + o.note : "",
      shipLines_(o),
      json_(o.shipments, []).length ? "列印託運單：https://linpoyes.github.io/lipo-guide/admin.html#print=" + o.orderNo : "",
      "訂單明細：https://linpoyes.github.io/lipo-guide/admin.html#order=" + o.orderNo].filter(Boolean).join("\n"));
  } catch (e) {}
}
function lineWebhook_(e) {
  const ok = ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  let body; try { body = JSON.parse(e.postData.contents); } catch (err) { return ok; }
  const code = CacheService.getScriptCache().get("lineBind");
  (body.events || []).forEach(ev => { try { lineEvent_(ev); } catch (err) {} });
  (body.events || []).forEach(ev => {
    if (!code || ev.type !== "message" || !ev.message || ev.message.type !== "text") return;
    if (String(ev.message.text).trim() !== code || !ev.source || !ev.source.userId) return;
    const p = PropertiesService.getScriptProperties(), users = json_(p.getProperty("LINE_USERS"), []);
    let name = "";
    try { const r = lineApi_("profile/" + ev.source.userId); if (r && r.getResponseCode() === 200) name = JSON.parse(r.getContentText()).displayName || ""; } catch (err) {}
    if (!users.some(u => u.id === ev.source.userId)) users.push({ id: ev.source.userId, name: name });
    p.setProperty("LINE_USERS", JSON.stringify(users));
    CacheService.getScriptCache().remove("lineBind");
    lineApi_("message/reply", { replyToken: ev.replyToken, messages: [{ type: "text", text: "綁定完成。之後有新訂單或付款完成時，將於此通知您。" }] });
  });
  return ok;
}

/* ───────────── LINE 會員登入（2026-11-08）─────────────
   LINE Login channel 2012457738（provider 赤貧軍團，已連結官方帳號 @552xxfur）。
   流程：賣場按「LINE 登入」→ access.line.me（bot_prompt=aggressive，登入時一併邀請加好友）
        → 回到這裡 ?cb=linelogin&code&state → 用 secret 換 token、驗 id_token、查好友狀態
        → 發一組會員權杖（存 SESS 類屬性 MEM_<雜湊>，30 天）→ 帶 #lm=<權杖> 回賣場。
   channel secret 存指令碼屬性 LINE_LOGIN_SECRET（不進版控）。 */
const LINE_LOGIN_ID = "2012457738";
const LOGIN_CB = EXEC_URL + "?cb=linelogin";
function lineLoginReturn_(q) {
  const back = (frag) => HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:-apple-system,sans-serif;text-align:center;padding:40px 16px"><p style="font-size:18px;font-weight:700">' +
    (frag.indexOf("lm=") === 0 ? "登入成功" : "登入未完成") + '</p><a href="' + SHOP_PAGE + "#" + frag + '" target="_top" style="display:inline-block;margin-top:12px;padding:12px 28px;border-radius:12px;background:#06C755;color:#fff;font-weight:800;text-decoration:none;font-size:17px">回到賣場</a></div><script>try{window.top.location.href=' +
    JSON.stringify(SHOP_PAGE + "#" + frag) + '}catch(e){}</script>').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  try {
    if (!q.code) return back("lmerr=cancel");
    const r = lineExchange_(q.code, q.state, LOGIN_CB);
    return back(r.mt ? "lm=" + r.mt : "lmerr=" + r.err);
  } catch (e) { return back("lmerr=fail"); }
}
// 2026-11-08：LINE 改為直接導回賣場（shop.html?code&state），賣場在背景 POST lineLogin 換會員權杖——不再經過 Apps Script 頁面（那頁無法自動跳轉、上方還有 Google 提示列）。
// 舊的 ?cb=linelogin 回呼保留，登入到一半的人不受影響。
const LOGIN_SHOP = SHOP_PAGE;
function lineLoginPost_(req) {
  try {
    const r = lineExchange_(String(req.code || ""), String(req.state || ""), LOGIN_SHOP, String(req.nonce || ""));
    // 一併回傳會員資料，賣場不必再查一次（2026-11-08：從 LINE 進來登入要等太久）
    return r.mt ? { ok: true, mt: r.mt, member: memberCheck_(r.mt).member } : { ok: false, error: "LINE 登入未完成，請再試一次" };
  } catch (e) { return { ok: false, error: "LINE 登入未完成，請再試一次" }; }
}
// state／nonce：舊流程由後端產生存快取；新流程由賣場產生（state 由賣場自行比對防 CSRF），nonce 隨 code 送來，交給 LINE 驗 id_token
function lineExchange_(code, state, redirect, nonce) {
  const cache = CacheService.getScriptCache(), st = cache.get("lls:" + state) || nonce;
  if (!st) return { err: "state" };
  cache.remove("lls:" + state);
  const secret = PropertiesService.getScriptProperties().getProperty("LINE_LOGIN_SECRET");
  const tok = JSON.parse(UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/token", { method: "post", muteHttpExceptions: true,
    payload: { grant_type: "authorization_code", code: code, redirect_uri: redirect, client_id: LINE_LOGIN_ID, client_secret: secret } }).getContentText());
  if (!tok.id_token) return { err: "token" };
  const idt = JSON.parse(UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", { method: "post", muteHttpExceptions: true,
    payload: { id_token: tok.id_token, client_id: LINE_LOGIN_ID, nonce: st } }).getContentText());
  if (!idt.sub) return { err: "verify" };
  return memberFromLine_(idt, tok.access_token);
}
// 用 LINE 身分（id_token 驗證結果＋access token）發會員權杖：OAuth 登入與 LIFF 共用
function memberFromLine_(idt, accessToken) {
  const fr = JSON.parse(UrlFetchApp.fetch("https://api.line.me/friendship/v1/status", { muteHttpExceptions: true, headers: { Authorization: "Bearer " + accessToken } }).getContentText());
  const mt = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  const rec = { uid: idt.sub, name: idt.name || "", pic: idt.picture || "", friend: !!fr.friendFlag, at: accessToken, exp: Date.now() + 30 * 86400000 };
  PropertiesService.getScriptProperties().setProperty("MEM_" + hash_(mt), JSON.stringify(rec));
  welcomePush_(rec);
  memberLog_(rec, true);
  sysLog_(rec.name || "LINE 會員", "customer", "會員登入", (rec.name || "LINE 會員") + (rec.friend ? "・已加好友" : "・未加好友"), "");
  return { mt: mt };
}
function memberOf_(mt) {
  if (!mt) return null;
  const p = PropertiesService.getScriptProperties(), k = "MEM_" + hash_(String(mt));
  const rec = json_(p.getProperty(k), null);
  if (!rec || rec.exp < Date.now()) return null;
  if (!rec.friend) { // 剛加好友：重查一次（access token 有效 30 天）
    try { const fr = JSON.parse(UrlFetchApp.fetch("https://api.line.me/friendship/v1/status", { muteHttpExceptions: true, headers: { Authorization: "Bearer " + rec.at } }).getContentText());
      if (fr.friendFlag) { rec.friend = true; p.setProperty(k, JSON.stringify(rec)); welcomePush_(rec); memberLog_(rec, false); } } catch (e) {}
  }
  return rec;
}
function memberCheck_(mt) {
  const m = memberOf_(mt);
  if (!m) return { ok: true, member: null };
  const w = m.friend ? welcomeInfo_() : null;
  return { ok: true, member: { name: m.name, pic: m.pic, friend: m.friend,
    welcome: w ? (g => ({ code: w.code, used: welcomeUsed_(m.uid), label: w.label, minSpend: w.minSpend, expires: g.date, daysLeft: g.left, expired: g.expired }))(welcomeGrant_(m.uid, true)) : null } };
}
/* 入會禮期限：每位會員從「領取」起算 welcomeDays 天。領取時間存 WELCOMED_<uid 雜湊>＝JSON {t: 毫秒, uid, r: 已提醒}；
   舊資料只有 "1" 的，以會員名冊的加入時間為準。到期前 welcomeRemind 天推播提醒一次（remindWelcome_，型錄載入時最多每 6 小時檢查一次）。 */
function welcomeDays_() { return Math.max(1, Number(getSettings_().welcomeDays) || 30); }
function welcomeGrant_(uid, create) {
  const p = PropertiesService.getScriptProperties(), k = "WELCOMED_" + hash_(uid);
  let v = json_(p.getProperty(k), null);
  if (v === 1 || (v && !v.t)) { // 舊格式
    const m = rows_("members").find(x => String(x.uid) === uid);
    const t = m ? Date.parse(String(m.firstAt).replace(" ", "T") + ":00+08:00") || Date.now() : Date.now();
    v = { t: t, uid: uid, r: 0 }; p.setProperty(k, JSON.stringify(v));
  }
  if (!v && create) { v = { t: Date.now(), uid: uid, r: 0 }; p.setProperty(k, JSON.stringify(v)); }
  if (!v) return { date: "", left: welcomeDays_(), expired: false };
  const end = v.t + welcomeDays_() * 86400000;
  return { date: Utilities.formatDate(new Date(end), "Asia/Taipei", "yyyy/MM/dd"), left: Math.max(0, Math.ceil((end - Date.now()) / 86400000)), expired: Date.now() > end, end: end };
}
function remindWelcome_() {
  const cache = CacheService.getScriptCache(); if (cache.get("wrem")) return; cache.put("wrem", "1", 21600);
  const w = welcomeInfo_(); if (!w) return;
  const p = PropertiesService.getScriptProperties(), all = p.getProperties(), before = Math.max(1, Number(getSettings_().welcomeRemind) || 3) * 86400000, now = Date.now();
  Object.keys(all).filter(k => k.indexOf("WELCOMED_") === 0).forEach(k => {
    const v = json_(all[k], null); if (!v || !v.t || !v.uid || v.r) return;
    const end = v.t + welcomeDays_() * 86400000;
    if (now < end - before || now > end || welcomeUsed_(v.uid)) return;
    v.r = 1; p.setProperty(k, JSON.stringify(v));
    lineApi_("message/push", { to: v.uid, messages: [{ type: "text", text: "【赤貧軍團】入會禮即將到期\n您的入會禮 " + w.label + " 將於 " + Utilities.formatDate(new Date(end), "Asia/Taipei", "yyyy/MM/dd") +
      " 到期，提醒您把握使用。\n折扣碼：" + w.code + (w.minSpend ? "\n使用條件：消費滿 $" + w.minSpend : "") + "\n\n立即選購：" + SHOP_PAGE }] });
  });
}
/* ── LINE 入會禮 ──
   設定 welcomeCode 指向折扣碼分頁的一組碼；這組碼只限「LINE 登入＋已加好友」的會員、每個 LINE 帳號限用一次（用訂單的 lineUid 判斷）。
   會員第一次確認是好友時，用官方帳號推播把折扣碼送到對方 LINE（WELCOMED_<uid 雜湊> 記錄已送過，不重送）。 */
function welcomeInfo_() {
  const wc = String(getSettings_().welcomeCode || "").trim().toUpperCase(); if (!wc) return null;
  const c = rows_("codes").map(code_).find(x => x.code.toUpperCase() === wc);
  if (!c || !c.active || (c.endAt && today_() > c.endAt)) return null;
  const off = 100 - c.value;
  return { code: c.code, minSpend: c.minSpend,
    label: c.type === "amount" ? "$" + c.value + " 折價券" : (off % 10 === 0 ? off / 10 : off) + " 折優惠券" };
}
function isWelcome_(codeStr) {
  const wc = String(getSettings_().welcomeCode || "").trim().toUpperCase();
  return !!wc && String(codeStr || "").trim().toUpperCase() === wc;
}
// 已用過＝有用這組碼的訂單，且不是已取消／付款失敗；待付款的單 3 天內算（ATM 繳費期限），逾期沒付就釋放
function welcomeUsed_(uid) {
  const wc = String(getSettings_().welcomeCode || "").trim().toUpperCase(); if (!wc || !uid) return false;
  const cutoff = Utilities.formatDate(new Date(Date.now() - 3 * 86400000), "Asia/Taipei", "yyyy-MM-dd HH:mm");
  return rows_("orders").some(o => String(o.lineUid) === uid && String(o.code).toUpperCase() === wc && String(o.status) !== "已取消" &&
    String(o.payStatus) !== "failed" && !(String(o.payStatus) === "awaiting" && String(o.createdAt) < cutoff));
}
function welcomePush_(rec) {
  try {
    const w = welcomeInfo_(); if (!w || !rec || !rec.uid || !rec.friend) return;
    const p = PropertiesService.getScriptProperties(), k = "WELCOMED_" + hash_(rec.uid);
    if (p.getProperty(k)) return;
    const g = welcomeGrant_(rec.uid, true);
    lineApi_("message/push", { to: rec.uid, messages: [{ type: "text", text:
      "【赤貧軍團】歡迎加入會員\n" + (rec.name ? rec.name + " 您好，" : "您好，") + "感謝您加入赤貧軍團會員。\n\n入會禮：" + w.label + "\n折扣碼：" + w.code +
      (w.minSpend ? "\n使用條件：消費滿 $" + w.minSpend : "") + "\n使用期限：" + g.date + " 前\n每位會員限用一次，結帳時輸入折扣碼即可折抵。\n\n" + SHOP_PAGE }] });
  } catch (e) {}
}
// 產生登入網址（含一次性 state／nonce）
function loginUrl_() {
  const state = Utilities.getUuid().replace(/-/g, ""), nonce = Utilities.getUuid().replace(/-/g, "");
  CacheService.getScriptCache().put("lls:" + state, nonce, 900);
  return "https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=" + LINE_LOGIN_ID + "&redirect_uri=" + encodeURIComponent(LOGIN_SHOP) +
    "&state=" + state + "&scope=openid%20profile&nonce=" + nonce + "&bot_prompt=aggressive";
}


/* ───────────── 流量追蹤與儀表板（2026-11-08）─────────────
   前台 track.js 把事件批次送來（action:"track"）：view 瀏覽頁面／product 看商品／cart 加購物車／checkout 前往結帳／
   order 送出訂單／search 搜尋（n＝結果數）／video 看影片／login 按 LINE 登入。
   不存個資：vid＝瀏覽器隨機碼（localStorage）、sid＝工作階段（30 分鐘無動作換新）。自動化瀏覽器（navigator.webdriver）前台就不送。
   超過 TRAFFIC_KEEP_DAYS 的舊資料在寫入時順手刪掉，避免試算表越長越慢。 */
const TRAFFIC_TYPES = ["view", "product", "cart", "checkout", "order", "search", "video", "login"];
const TRAFFIC_KEEP_DAYS = 400;
const ts_ = d => Utilities.formatDate(d, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
function track_(req) {
  const id = v => /^[a-z0-9]{8,40}$/.test(String(v || "")) ? String(v) : "";
  const vid = id(req.vid), sid = id(req.sid);
  if (!vid || !sid || !Array.isArray(req.ev)) return { ok: false };
  const cache = CacheService.getScriptCache(), rk = "trk:" + vid, n = Number(cache.get(rk) || 0);
  if (n > 120) return { ok: true }; // 同一訪客 10 分鐘內超過 120 批＝異常，丟掉
  cache.put(rk, String(n + 1), 600);
  const clip = (v, k) => String(v == null ? "" : v).replace(/[\r\n\t]/g, " ").slice(0, k);
  const now = Date.now(), sent = Number(req.sent) || now;
  const rows = req.ev.slice(0, 40).filter(e => e && TRAFFIC_TYPES.indexOf(e.t) >= 0).map(e => {
    const at = Math.min(now, Math.max(now - 86400000, now - (sent - (Number(e.at) || sent))));
    return [ts_(new Date(at)), vid, sid, e.t, clip(e.page, 30), clip(e.pid, 30), clip(e.q, 40), String(Math.round(Number(e.n) || 0)),
            clip(req.src, 20), clip(req.ref, 60), clip(req.dev, 6), clip(req.os, 10)].map(v => safeCell_(v));
  });
  if (!rows.length) return { ok: true };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { ok: true };
  try {
    const sh = sheet_("traffic"), r0 = sh.getLastRow() + 1;
    sh.getRange(r0, 1, rows.length, SHEETS.traffic.length).setNumberFormat("@").setValues(rows);
    if (r0 % 500 < rows.length) pruneTraffic_(sh); // 大約每 500 筆檢查一次舊資料
  } finally { lock.releaseLock(); }
  return { ok: true };
}
function pruneTraffic_(sh) {
  const n = sh.getLastRow() - 1; if (n < 1000) return;
  const cut = ts_(new Date(Date.now() - TRAFFIC_KEEP_DAYS * 86400000));
  const col = sh.getRange(2, 1, n, 1).getValues();
  let k = 0; while (k < col.length && String(col[k][0]) < cut) k++;
  if (k > 0) sh.deleteRows(2, k);
}
function memberLog_(rec, isLogin) {
  try {
    const now = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm");
    const old = rows_("members").find(m => String(m.uid) === rec.uid);
    upsert_("members", "uid", { uid: rec.uid, name: rec.name || "", pic: rec.pic || "", friend: rec.friend ? "TRUE" : "FALSE",
      firstAt: old ? old.firstAt : now, lastAt: isLogin || !old ? now : old.lastAt, logins: String((old ? Number(old.logins) || 0 : 0) + (isLogin ? 1 : 0)) });
  } catch (e) {}
}
// 會員名冊上線前就登入過的人：從 MEM_ 權杖補進名冊（只補一次）
function backfillMembers_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty("MEMBERS_BACKFILLED")) return;
  const all = p.getProperties(), seen = {};
  Object.keys(all).filter(k => k.indexOf("MEM_") === 0).forEach(k => {
    const r = json_(all[k], null); if (!r || !r.uid) return;
    if (!seen[r.uid] || r.exp > seen[r.uid].exp) seen[r.uid] = r;
  });
  Object.keys(seen).forEach(u => { const r = seen[u], at = Utilities.formatDate(new Date(r.exp - 30 * 86400000), "Asia/Taipei", "yyyy-MM-dd HH:mm");
    upsert_("members", "uid", { uid: u, name: r.name || "", pic: r.pic || "", friend: r.friend ? "TRUE" : "FALSE", firstAt: at, lastAt: at, logins: "1" }); });
  p.setProperty("MEMBERS_BACKFILLED", "1");
}
// 儀表板：所有彙總在後端算好，前端只畫圖。days＝1（今日）/7/30/90；同時算前一段同長度期間做比較。
function dashboard_(r) {
  backfillMembers_();
  const days = [1, 7, 30, 90].indexOf(Number(r.days)) >= 0 ? Number(r.days) : 7;
  const day0 = d => Utilities.formatDate(d, "Asia/Taipei", "yyyy-MM-dd");
  const today = day0(new Date());
  const from = day0(new Date(Date.now() - (days - 1) * 86400000)), prevFrom = day0(new Date(Date.now() - (2 * days - 1) * 86400000));
  // 流量：只讀需要的那一段（資料依時間排序，先讀 ts 欄找起點）
  const sh = sheet_("traffic"), total = sh.getLastRow() - 1;
  let ev = [];
  if (total > 0) {
    const tsCol = sh.getRange(2, 1, total, 1).getValues();
    let lo = 0; while (lo < total && String(tsCol[lo][0]) < prevFrom) lo++;
    if (lo < total) ev = sh.getRange(2 + lo, 1, total - lo, SHEETS.traffic.length).getValues().map(a => { const o = {}; SHEETS.traffic.forEach((c, j) => o[c] = String(a[j])); return o; });
  }
  const cur = ev.filter(e => e.ts >= from), prev = ev.filter(e => e.ts < from);
  // 新訪客：全部資料裡第一次出現在本期間（只看保留期間內）
  const firstSeen = {};
  if (total > 0) { const vc = sh.getRange(2, 1, total, 2).getValues(); vc.forEach(a => { const v = String(a[1]); if (!firstSeen[v]) firstSeen[v] = String(a[0]); }); }
  const uniq = (list, k) => { const s = {}; list.forEach(e => s[e[k]] = 1); return Object.keys(s).length; };
  const cnt = (list, t) => list.filter(e => e.type === t).length;
  // 訂單（排除已取消）
  const ords = rows_("orders").filter(o => String(o.status) !== "已取消").map(o => ({ at: String(o.createdAt), total: Number(o.total) || 0, paid: String(o.payStatus) === "paid",
    items: json_(o.items, []), uid: String(o.lineUid || ""), code: String(o.code || "") }));
  const oCur = ords.filter(o => o.at.slice(0, 10) >= from), oPrev = ords.filter(o => o.at.slice(0, 10) >= prevFrom && o.at.slice(0, 10) < from);
  const paidRev = list => list.filter(o => o.paid).reduce((a, o) => a + o.total, 0);
  const mem = rows_("members");
  const kpi = list => {
    const sess = {}; list.forEach(e => { const s = sess[e.sid] || (sess[e.sid] = { n: 0, types: {} }); if (e.type === "view") s.n++; s.types[e.type] = 1; });
    const sids = Object.keys(sess), bounce = sids.filter(k => sess[k].n <= 1 && Object.keys(sess[k].types).length <= 1).length;
    return { visitors: uniq(list, "vid"), sessions: sids.length, views: cnt(list, "view"), productViews: cnt(list, "product"), carts: cnt(list, "cart"),
      bounce: sids.length ? Math.round(bounce / sids.length * 100) : 0, ppv: sids.length ? Math.round(cnt(list, "view") / sids.length * 10) / 10 : 0 };
  };
  const K = kpi(cur), P = kpi(prev);
  K.newVisitors = Object.keys(cur.reduce((s, e) => (s[e.vid] = 1, s), {})).filter(v => (firstSeen[v] || "") >= from).length;
  K.orders = oCur.length; K.paidOrders = oCur.filter(o => o.paid).length; K.revenue = paidRev(oCur);
  K.aov = K.paidOrders ? Math.round(K.revenue / K.paidOrders) : 0; K.conv = K.visitors ? Math.round(K.orders / K.visitors * 1000) / 10 : 0;
  P.orders = oPrev.length; P.revenue = paidRev(oPrev); P.conv = P.visitors ? Math.round(P.orders / P.visitors * 1000) / 10 : 0;
  K.members = mem.length; K.newMembers = mem.filter(m => String(m.firstAt).slice(0, 10) >= from).length;
  P.newMembers = mem.filter(m => String(m.firstAt).slice(0, 10) >= prevFrom && String(m.firstAt).slice(0, 10) < from).length;
  K.friends = mem.filter(m => bool_(m.friend)).length;
  const nowTs = ts_(new Date(Date.now() - 5 * 60000));
  K.online = uniq(ev.filter(e => e.ts >= nowTs), "vid");
  // 回購：本期下單的會員中，之前也下過單的比例
  const buyers = {}; ords.forEach(o => { if (o.uid) (buyers[o.uid] = buyers[o.uid] || []).push(o.at); });
  const curBuyers = Object.keys(buyers).filter(u => buyers[u].some(a => a.slice(0, 10) >= from));
  K.repeat = curBuyers.length ? Math.round(curBuyers.filter(u => buyers[u].some(a => a.slice(0, 10) < from) || buyers[u].filter(a => a.slice(0, 10) >= from).length > 1).length / curBuyers.length * 100) : 0;
  // 每日走勢（今日＝每小時）
  const series = [];
  if (days === 1) {
    for (let h = 0; h < 24; h++) { const hh = (h < 10 ? "0" : "") + h, l = cur.filter(e => e.ts.slice(11, 13) === hh);
      series.push({ k: hh + ":00", visitors: uniq(l, "vid"), views: cnt(l, "view"), orders: oCur.filter(o => o.at.slice(11, 13) === hh).length, revenue: paidRev(oCur.filter(o => o.at.slice(11, 13) === hh)) }); }
  } else {
    for (let i = days - 1; i >= 0; i--) { const d = day0(new Date(Date.now() - i * 86400000)), l = cur.filter(e => e.ts.slice(0, 10) === d), od = oCur.filter(o => o.at.slice(0, 10) === d);
      series.push({ k: d.slice(5).replace("-", "/"), visitors: uniq(l, "vid"), views: cnt(l, "view"), orders: od.length, revenue: paidRev(od) }); }
  }
  // 來源、裝置、系統（以工作階段計）
  const bySess = (k) => { const first = {}; cur.forEach(e => { if (!first[e.sid]) first[e.sid] = e[k] || "其他"; }); const c = {}; Object.keys(first).forEach(s => c[first[s]] = (c[first[s]] || 0) + 1); return top_(c, 8); };
  // 熱門商品：瀏覽、加購物車、售出件數
  const prodName = {}; rows_("products").forEach(p => prodName[String(p.id)] = String(p.name));
  const pv = {}; const bump = (id, k, v) => { if (!id) return; const x = pv[id] || (pv[id] = { id: id, views: 0, carts: 0, sold: 0, rev: 0 }); x[k] += v; };
  cur.forEach(e => { if (e.type === "product") bump(e.pid, "views", 1); if (e.type === "cart") bump(e.pid, "carts", Number(e.n) || 1); });
  oCur.forEach(o => o.items.forEach(i => { bump(String(i.id), "sold", Number(i.qty) || 0); bump(String(i.id), "rev", Number(i.total) || 0); }));
  const products = Object.keys(pv).map(k => Object.assign(pv[k], { name: prodName[k] || k })).sort((a, b) => b.views + b.sold * 5 - (a.views + a.sold * 5)).slice(0, 10);
  // 搜尋關鍵字＋搜不到的字（找貨源的線索）
  const sq = {}, zero = {};
  cur.filter(e => e.type === "search" && e.q).forEach(e => { const q = e.q.toLowerCase().trim(); sq[q] = (sq[q] || 0) + 1; if (e.n === "0") zero[q] = (zero[q] || 0) + 1; });
  // 轉換漏斗（以工作階段計）
  const st = {}; cur.forEach(e => (st[e.sid] = st[e.sid] || {})[e.type] = 1);
  const sv = Object.keys(st).map(k => st[k]);
  const funnel = [["進站", sv.length], ["看商品", sv.filter(x => x.product).length], ["加入購物車", sv.filter(x => x.cart).length], ["前往結帳", sv.filter(x => x.checkout).length], ["送出訂單", sv.filter(x => x.order).length]];
  // 星期 × 時段熱度（瀏覽次數）
  const heat = []; for (let i = 0; i < 7; i++) heat.push(new Array(24).fill(0));
  cur.filter(e => e.type === "view").forEach(e => { const dd = (new Date(Date.parse(e.ts.replace(" ", "T") + "+08:00") + 8 * 3600000)).getUTCDay(); heat[dd][Number(e.ts.slice(11, 13))]++; });
  const pages = {}; cur.filter(e => e.type === "view").forEach(e => pages[e.page] = (pages[e.page] || 0) + 1);
  const vids = {}; cur.filter(e => e.type === "video").forEach(e => vids[e.pid] = (vids[e.pid] || 0) + 1);
  const vName = {}; rows_("videos").forEach(v => vName[String(v.id)] = String(v.title || v.id));
  const latestMembers = mem.slice().sort((a, b) => String(b.firstAt).localeCompare(String(a.firstAt))).slice(0, 12)
    .map(m => ({ name: String(m.name), pic: String(m.pic), friend: bool_(m.friend), firstAt: String(m.firstAt), lastAt: String(m.lastAt), orders: (buyers[String(m.uid)] || []).length }));
  const welcome = String(getSettings_().welcomeCode || "").toUpperCase();
  return { days: days, from: from, to: today, kpi: K, prev: P, series: series, sources: bySess("src"), devices: bySess("dev"), os: bySess("os"),
    products: products, searches: top_(sq, 12), zero: top_(zero, 8), funnel: funnel, heat: heat, pages: top_(pages, 6),
    videos: top_(Object.keys(vids).reduce((o, k) => (o[vName[k] || k] = vids[k], o), {}), 6), members: latestMembers,
    welcomeUsed: welcome ? ords.filter(o => o.code.toUpperCase() === welcome).length : null, tracked: total };
}
function top_(obj, n) { return Object.keys(obj).map(k => [k, obj[k]]).sort((a, b) => b[1] - a[1]).slice(0, n); }


/* ───────────── 會員中心：訂單紀錄、積分、等級、優惠券（2026-11-08）─────────────
   積分不另開帳本，一律由訂單即時算：
     獲得＝已付款且未取消的訂單，(商品金額 − 折扣碼 − 積分折抵) ÷ pointRate 無條件捨去
     使用＝訂單的 pointsUsed（未取消、未付款失敗；待付款超過 3 天視為放棄，點數退回）
   訂單取消或付款失敗，獲得與使用的點數都自動還原，不必人工處理。
   等級依累積已付款消費（商品金額）：一般 → 銀卡 3,000 → 金卡 10,000 → 黑卡 30,000。 */
const TIERS = [["一般會員", 0], ["銀卡會員", 3000], ["金卡會員", 10000], ["黑卡會員", 30000]];
function pointCfg_() {
  const s = getSettings_();
  return { on: s.pointsOn !== "FALSE", rate: Math.max(1, Number(s.pointRate) || 100), maxPct: Math.max(0, Math.min(100, Number(s.pointMaxPct) || 50)) };
}
function orderLive_(o) {
  if (String(o.status) === "已取消" || String(o.payStatus) === "failed") return false;
  const cutoff = Utilities.formatDate(new Date(Date.now() - 3 * 86400000), "Asia/Taipei", "yyyy-MM-dd HH:mm");
  return !(String(o.payStatus) === "awaiting" && String(o.createdAt) < cutoff);
}
const goods_ = o => Math.max(0, (Number(o.subtotal) || 0) - (Number(o.codeDiscount) || 0) - (Number(o.pointsUsed) || 0));
/* 點數效期（2026-11-10 使用者）：一年；只要有新增點數，全部點數的效期就從最新一次入帳日重新起算一年。
   依時間順序重算：入帳時若距上次入帳已超過一年，先前餘額歸零（已過期）；最後若距最近入帳超過一年，目前餘額也歸零。 */
const POINT_DAYS = 365;
function pointsOf_(uid, list) {
  const pc = pointCfg_(), t = v => Date.parse(String(v || "").replace(" ", "T") + ":00+08:00") || 0;
  const ev = []; let pending = 0, earned = 0, used = 0;
  (list || rows_("orders")).forEach(o => {
    if (String(o.lineUid) !== uid || !orderLive_(o)) return;
    const pts = Math.floor(goods_(o) / pc.rate), u = Number(o.pointsUsed) || 0;
    if (u) { ev.push({ at: t(o.createdAt), d: -u }); used += u; }
    if (String(o.payStatus) === "paid") { ev.push({ at: t(o.paidAt || o.createdAt), d: pts, earn: true }); earned += pts; } else pending += pts;
  });
  ev.sort((a, b) => a.at - b.at);
  let bal = 0, last = 0, expired = 0;
  ev.forEach(e => {
    if (e.earn) { if (last && e.at - last > POINT_DAYS * 86400000) { expired += Math.max(0, bal); bal = 0; } last = e.at; }
    bal = Math.max(0, bal + e.d);
  });
  const exp = last ? last + POINT_DAYS * 86400000 : 0;
  if (exp && Date.now() > exp) { expired += bal; bal = 0; }
  return { earned: earned, used: used, pending: pending, balance: bal, expired: expired,
    expires: exp && bal ? Utilities.formatDate(new Date(exp), "Asia/Taipei", "yyyy/MM/dd") : "", expMs: exp };
}
// 點數到期前 30 天提醒一次（排程呼叫）；PTREM_<uid 雜湊>＝已提醒的到期日，續期後到期日變了會再提醒
function remindPoints_() {
  const all = rows_("orders"), uids = {}, p = PropertiesService.getScriptProperties(), now = Date.now();
  all.forEach(o => { if (o.lineUid) uids[String(o.lineUid)] = 1; });
  Object.keys(uids).forEach(uid => {
    const pt = pointsOf_(uid, all); if (!pt.balance || !pt.expMs) return;
    if (pt.expMs - now > 30 * 86400000 || pt.expMs < now) return;
    const k = "PTREM_" + hash_(uid); if (p.getProperty(k) === pt.expires) return; p.setProperty(k, pt.expires);
    lineApi_("message/push", { to: uid, messages: [{ type: "text", text: "【赤貧軍團】點數即將到期\n您目前有 " + pt.balance + " 點（可折抵 $" + pt.balance + "），將於 " + pt.expires + " 到期。\n再次消費即可延長一年，歡迎選購：" + SHOP_PAGE }] });
  });
}
function memberCenter_(req) {
  const m = memberOf_(req.memberToken);
  if (!m) return { ok: false, error: "請先以 LINE 登入", needLogin: true };
  const all = rows_("orders"), mine = all.filter(o => String(o.lineUid) === m.uid).reverse();
  const pc = pointCfg_(), pts = pointsOf_(m.uid, all);
  const spend = mine.filter(o => String(o.payStatus) === "paid" && String(o.status) !== "已取消").reduce((a, o) => a + goods_(o), 0);
  let ti = 0; TIERS.forEach((t, i) => { if (spend >= t[1]) ti = i; });
  const next = TIERS[ti + 1];
  const orders = mine.slice(0, 50).map(o => ({ orderNo: String(o.orderNo), createdAt: String(o.createdAt), status: String(o.status), payStatus: String(o.payStatus),
    payMethod: String(o.payMethod || ""), shipMethod: String(o.shipMethod), address: String(o.address), total: Number(o.total) || 0, shipping: Number(o.shipping) || 0,
    codeDiscount: Number(o.codeDiscount) || 0, pointsUsed: Number(o.pointsUsed) || 0, items: json_(o.items, []).map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, total: i.total })),
    earn: orderLive_(o) ? Math.floor(goods_(o) / pc.rate) : 0, vaBank: String(o.vaBank || ""), vaAccount: String(o.vaAccount || ""), vaExpire: String(o.vaExpire || "") }));
  // 優惠券：入會禮（未用過）＋後台勾「會員中心顯示」且仍有效的折扣碼
  const d = today_(), coupons = [], w = welcomeInfo_();
  if (w && m.friend) { const g = welcomeGrant_(m.uid, true); coupons.push({ code: w.code, label: w.label, minSpend: w.minSpend, endAt: g.date.replace(/\//g, "-"), note: "入會禮・限用一次", used: welcomeUsed_(m.uid), expired: g.expired, daysLeft: g.left }); }
  rows_("codes").map(code_).filter(c => c.member && c.active && !isWelcome_(c.code) && !(c.endAt && d > c.endAt) && !(c.limit > 0 && c.used >= c.limit)).forEach(c => {
    const off = 100 - c.value;
    coupons.push({ code: c.code, label: c.type === "amount" ? "折 $" + c.value : (off % 10 === 0 ? off / 10 : off) + " 折", minSpend: c.minSpend, startAt: c.startAt, endAt: c.endAt, note: c.note, used: false });
  });
  return { ok: true, member: { name: m.name, pic: m.pic, friend: m.friend }, orders: orders, points: Object.assign(pts, { rate: pc.rate, maxPct: pc.maxPct, on: pc.on }),
    tier: { name: TIERS[ti][0], level: ti, spend: spend, next: next ? next[0] : "", nextAt: next ? next[1] : 0 }, coupons: coupons };
}


/* ───────────── 綠界物流：7-11 交貨便（UNIMARTC2C）／黑貓宅急便（TCAT）（2026-11-08）─────────────
   與金流同一組特店（ECPAY_MID/KEY/IV）；測試模式改用綠界公開的物流測試帳號（C2C 與宅配各一組）。
   流程：付款成功（或後台按「建立寄件單」）→ Express/Create，一個包裹一張單 → 存 shipments：
         [{id: AllPayLogisticsID, no: 交貨便代號／託運單號, vno: 驗證碼, sub, trade, at, st: 最新貨態}]
   列印：後台拿簽好章的表單，新分頁 POST 到綠界列印頁（綠界要求不要用 iframe）。
   貨態：綠界 POST 到 ?cb=logi（MD5 驗章）→ 更新 st；出貨／到店／取件時自動改訂單狀態並 LINE 通知客人。
   CheckMacValue 與金流同算法，只是雜湊用 MD5。 */
const LOGI_STAGE = { C2C: { mid: "2000933", key: "XBERn1YOvpM9nfZc", iv: "h1ONHk4P4yqbl5LK" }, HOME: { mid: "2000132", key: "5294y06JbISpM5x9", iv: "v77hoKGq4kWxNNIS" } }; // 綠界公開測試帳號
function logiCfg_(forceLive, kind, forceStage) {
  const s = getSettings_(), p = PropertiesService.getScriptProperties();
  const stage = !!forceStage || (!forceLive && s.logiStage !== "FALSE");
  const t = LOGI_STAGE[kind === "HOME" ? "HOME" : "C2C"];
  const mid = stage ? t.mid : p.getProperty("ECPAY_MID") || "", key = stage ? t.key : p.getProperty("ECPAY_KEY") || "", iv = stage ? t.iv : p.getProperty("ECPAY_IV") || "";
  const sender = { name: String(s.senderName || "").trim(), phone: String(s.senderPhone || "").replace(/\D/g, ""), zip: String(s.senderZip || "").trim(), addr: String(s.senderAddr || "").trim() };
  const senderOk = !checkName_(sender.name) && /^09\d{8}$/.test(sender.phone) && /^\d{3,6}$/.test(sender.zip) && sender.addr.length >= 6;
  const on = s.logiOn === "TRUE" && !!(mid && key && iv) && senderOk;
  return { on: on, auto: on && s.logiAuto !== "FALSE", stage: stage, mid: mid, key: key, iv: iv, sender: sender, size: homeSpec_() || (/^000[1-4]$/.test(s.logiSize) ? s.logiSize : "0001"),
    host: stage ? "https://logistics-stage.ecpay.com.tw" : "https://logistics.ecpay.com.tw",
    public: { enabled: s.logiOn === "TRUE", stage: stage, auto: s.logiAuto !== "FALSE", senderOk: senderOk, keySet: !!p.getProperty("ECPAY_KEY") } };
}
function logiMac_(params, cfg) {
  const sorted = Object.keys(params).filter(k => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0).map(k => k + "=" + params[k]).join("&");
  const raw = dotNetEncode_("HashKey=" + cfg.key + "&" + sorted + "&HashIV=" + cfg.iv).toLowerCase();
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8).map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("").toUpperCase();
}
function logiPost_(url, p) {
  return UrlFetchApp.fetch(url, { method: "post", payload: p, muteHttpExceptions: true }).getContentText();
}
// 綠界品名不可有 ^ ' ` ! @ # % & * + \ " < > | _ [ ]，最多 50 字
const logiText_ = (t, n) => String(t || "").replace(/[\^'`!@#%&*+\\"<>|_\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const ISLAND_ZIP = /^(209|21[0-2]|88[0-5]|89[0-6])/;
function logiCreate_(orderNo, again) {
  const o = rows_("orders").find(x => String(x.orderNo) === orderNo); if (!o) throw new Error("查無訂單");
  const old = json_(o.shipments, []);
  if (old.length && !again) return old;
  const cvs = String(o.shipMethod) === SHIP_CVS, kind = cvs ? "C2C" : "HOME", cfg = logiCfg_(false, kind);
  if (!cfg.on) throw new Error("綠界物流尚未啟用或寄件人資料不完整（設定 → 物流）");
  const n = Math.max(1, Number(o.packages) || 1), items = json_(o.items, []);
  const amt = Math.max(1, Math.min(20000, Math.round(Number(o.total) / n)));
  const goods = logiText_(items.map(i => String(i.name).replace(/^.*?[｜|]\s*/, "") + "x" + i.qty).join(" "), 25) || "RC 商品";
  const base = { MerchantID: cfg.mid, MerchantTradeDate: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss"),
    GoodsAmount: String(amt), GoodsName: goods, SenderName: cfg.sender.name, SenderCellPhone: cfg.sender.phone,
    ReceiverName: String(o.name), ReceiverCellPhone: String(o.phone), ServerReplyURL: EXEC_URL + "?cb=logi", Remark: logiText_(orderNo, 60) };
  if (cvs) {
    const sid = (String(o.address).match(/店號\s*(\d{6})/) || [])[1];
    if (!sid) throw new Error("訂單沒有 7-11 店號，無法建立交貨便");
    Object.assign(base, { LogisticsType: "CVS", LogisticsSubType: "UNIMARTC2C", CollectionAmount: String(amt), IsCollection: "N", ReceiverStoreID: sid });
  } else {
    const m = String(o.address).match(/^(\d{3,6})(.+)$/);
    if (!m || m[2].length < 6) throw new Error("收件地址缺郵遞區號或太短");
    const city = a => a.replace(/^臺/, "台").slice(0, 3);
    const dist = ISLAND_ZIP.test(m[1]) ? "02" : city(m[2]) === city(cfg.sender.addr) ? "00" : "01";
    Object.assign(base, { LogisticsType: "HOME", LogisticsSubType: "TCAT", SenderZipCode: cfg.sender.zip, SenderAddress: cfg.sender.addr,
      ReceiverZipCode: m[1], ReceiverAddress: m[2].slice(0, 60), Temperature: "0001", Distance: dist, Specification: cfg.size, ScheduledPickupTime: "4", ScheduledDeliveryTime: "4" });
  }
  const list = again ? [] : old.slice();
  for (let i = list.length; i < n; i++) {
    const p = Object.assign({}, base, { MerchantTradeNo: ("L" + orderNo.replace(/\D/g, "") + i + Utilities.getUuid().replace(/\D/g, "")).slice(0, 20) });
    p.CheckMacValue = logiMac_(p, cfg);
    const res = logiPost_(cfg.host + "/Express/Create", p);
    if (res.indexOf("1|") !== 0) { if (list.length) break; throw new Error("綠界建單失敗：" + res.replace(/^0\|/, "").slice(0, 120)); }
    const r = {}; res.slice(2).split("&").forEach(kv => { const j = kv.indexOf("="); r[kv.slice(0, j)] = kv.slice(j + 1); });
    list.push({ id: r.AllPayLogisticsID, no: cvs ? r.CVSPaymentNo + (r.CVSValidationNo || "") : r.BookingNote, pno: r.CVSPaymentNo || "", vno: r.CVSValidationNo || "",
      sub: cvs ? "UNIMARTC2C" : "TCAT", trade: p.MerchantTradeNo, cost: logiFee_(cvs, cvs ? "" : base.Specification, !cvs && base.Distance === "02"), at: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm"), st: r.RtnMsg || "", stage: cfg.stage });
  }
  setOrderField_(orderNo, { shipments: JSON.stringify(list) });
  return list;
}
// 批次列印（2026-11-08：收到訂單自動建單，管理者一次印完）：同類（交貨便／黑貓）同環境的寄件單合併成一張表單
function logiPrintBatch_(orderNos) {
  const all = rows_("orders").filter(o => orderNos.indexOf(String(o.orderNo)) >= 0);
  const groups = {};
  all.forEach(o => json_(o.shipments, []).forEach(x => { const k = x.sub + (x.stage ? "_t" : ""); (groups[k] = groups[k] || []).push(x); }));
  return { forms: Object.keys(groups).map(k => { const list = groups[k], f = logiForm_(list); f.kind = list[0].sub === "UNIMARTC2C" ? "7-11 交貨便" : "黑貓宅急便"; f.count = list.length; return f; }) };
}
function logiForm_(list) {
  const cvs = list[0].sub === "UNIMARTC2C", cfg = logiCfg_(!list[0].stage, cvs ? "C2C" : "HOME", !!list[0].stage);
  const p = { MerchantID: cfg.mid, AllPayLogisticsID: list.map(x => x.id).join(",") };
  if (cvs) { p.CVSPaymentNo = list.map(x => x.pno).join(","); p.CVSValidationNo = list.map(x => x.vno).join(","); }
  p.CheckMacValue = logiMac_(p, cfg);
  return { url: cfg.host + (cvs ? "/Express/PrintUniMartC2COrderInfo" : "/helper/printTradeDocument"), fields: p };
}
function logiPrint_(orderNo) {
  const o = rows_("orders").find(x => String(x.orderNo) === orderNo); if (!o) throw new Error("查無訂單");
  const list = json_(o.shipments, []); if (!list.length) throw new Error("尚未建立寄件單");
  return logiForm_(list);
  const cvs = list[0].sub === "UNIMARTC2C", cfg = logiCfg_(!list[0].stage, cvs ? "C2C" : "HOME", !!list[0].stage); // 依建單當時是測試或正式
  const p = { MerchantID: cfg.mid, AllPayLogisticsID: list.map(x => x.id).join(",") };
  if (cvs) { p.CVSPaymentNo = list.map(x => x.pno).join(","); p.CVSValidationNo = list.map(x => x.vno).join(","); }
  p.CheckMacValue = logiMac_(p, cfg);
  return { url: cfg.host + (cvs ? "/Express/PrintUniMartC2COrderInfo" : "/helper/printTradeDocument"), fields: p };
}
// 綠界貨態通知：驗章（依 MerchantID 判斷是正式或測試帳號）→ 更新 st；出貨／到店／取件時改訂單狀態並通知客人
function logiReply_(q) {
  const text = t => ContentService.createTextOutput(t);
  const p = Object.assign({}, q); delete p.cb;
  const cand = [logiCfg_(true), logiCfg_(false, "C2C", true), logiCfg_(false, "HOME", true)].find(c => c.mid === String(p.MerchantID));
  if (!cand || String(p.CheckMacValue || "").toUpperCase() !== logiMac_(p, cand)) return text("0|CheckMacValue Error");
  const all = rows_("orders"), o = all.find(x => json_(x.shipments, []).some(s => String(s.id) === String(p.AllPayLogisticsID)));
  if (!o) return text("1|OK");
  const list = json_(o.shipments, []), sh = list.find(s => String(s.id) === String(p.AllPayLogisticsID));
  const msg = String(p.RtnMsg || ""); sh.st = msg; sh.code = String(p.RtnCode || ""); sh.upd = String(p.UpdateStatusDate || "");
  try { const lg = sheet_("logilog"); lg.getRange(lg.getLastRow() + 1, 1, 1, 5).setNumberFormat("@").setValues([[ts_(new Date()), String(o.orderNo), String(sh.id), sh.code, safeCell_(msg)]]); } catch (e) {}
  const upd = { shipments: JSON.stringify(list) };
  // 綠界沒有公開完整貨態代碼表（各處說法矛盾），以訊息文字判斷；原始回報都記在「物流紀錄」分頁供核對
  const back = /退|拒收|未取|逾期|異常|遺失|取消|閉店|無法/.test(msg);
  const done = !back && /(成功|已)取(件|貨)|取(件|貨)成功|到店取(件|貨)|順利送達|配達完成|已配達(?!.*門市)|簽收/.test(msg);
  const arrived = !back && !done && /取貨門市|取件門市|送達門市|到達門市|抵達門市|已到店|配達.*門市/.test(msg);
  const shipped = !back && !done && !arrived && /寄件|收件|配送中|出貨|轉運|集貨|出庫|物流中心|運送中/.test(msg);
  const st = String(o.status), uid = String(o.lineUid || "");
  const push = t => { if (uid) lineApi_("message/push", { to: uid, messages: [{ type: "text", text: t }] }); };
  if (done && st !== "已完成" && st !== "已取消") upd.status = "已完成";
  if ((shipped || arrived) && (st === "新訂單" || st === "已確認")) upd.status = "已出貨";
  setOrderField_(String(o.orderNo), upd);
  try {
    const key = "LGN_" + sh.id + "_" + (done ? "d" : arrived ? "a" : shipped ? "s" : back ? "b" + hash_(msg).slice(0, 6) : "");
    if (shipped || arrived || done || back) sysLog_("綠界物流", "system", "物流狀態", o.orderNo + "・" + msg, String(o.orderNo));
    if (back && !PropertiesService.getScriptProperties().getProperty(key)) { // 退件、門市閉店等異常：通知管理者處理
      PropertiesService.getScriptProperties().setProperty(key, "1");
      linePush_("【赤貧軍團】物流異常通知\n訂單編號：" + o.orderNo + "\n物流狀態：" + msg + "\n物流單號：" + sh.no + "\n請盡速處理：https://linpoyes.github.io/lipo-guide/admin.html#order=" + o.orderNo);
    }
    const pp = PropertiesService.getScriptProperties();
    if ((shipped || arrived || done) && !pp.getProperty(key)) {
      pp.setProperty(key, "1");
      const cvs = sh.sub === "UNIMARTC2C";
      if (shipped) push("【赤貧軍團】出貨通知\n訂單編號：" + o.orderNo + "\n您訂購的商品已寄出。\n" + (cvs ? "7-11 交貨便代號：" : "黑貓宅急便託運單號：") + sh.no + (cvs ? "\n商品送達取貨門市後，將再次通知您。" : "\n可至黑貓宅急便官網查詢配送進度。"));
      if (arrived) push("【赤貧軍團】到店通知\n訂單編號：" + o.orderNo + "\n商品已送達取貨門市：" + String(o.address).replace(/（店號.*?）/, "") + "\n請於 7 日內攜帶身分證件至門市取貨。");
      if (done) push("【赤貧軍團】取件完成\n訂單編號：" + o.orderNo + "\n感謝您的訂購，期待再次為您服務。");
    }
  } catch (e) {}
  return text("1|OK");
}
function shipLines_(o) {
  const list = json_(o.shipments, []); if (!list.length) return "";
  const cvs = list[0].sub === "UNIMARTC2C";
  return (cvs ? "交貨便代號：" : "黑貓託運單號：") + list.map(s => s.no).join("、") + (list[0].stage ? "（測試）" : "");
}


/* ───────────── 逾期未付款自動取消、退回庫存（2026-11-08）─────────────
   下單當下就扣庫存（避免超賣），所以沒付款的單要放掉：
     付款失敗 → 30 分鐘後取消；信用卡待付款 → 2 小時；ATM → 繳費期限過後 1 小時（沒取到帳號比照 2 小時）
   取消時退回庫存與折扣碼次數，restocked＝TRUE 防止重複；之後若綠界仍通知付款成功（reclaimOrder_）會恢復訂單並重新扣庫存。
   檢查時機：賣場載入型錄、後台讀訂單時順便做，10 分鐘最多一次（不需要額外授權觸發器）。 */
function adjustStock_(items, sign) {
  dropCatalog_();
  const sh = sheet_("products"), col = SHEETS.products.indexOf("stock") + 1;
  rows_("products").forEach(r => {
    const qty = items.filter(i => String(i.id) === String(r.id)).reduce((a, i) => a + (Number(i.qty) || 0), 0);
    if (qty && r.stock !== "" && Number(r.stock) >= 0) sh.getRange(r._row, col).setNumberFormat("@").setValue(String(Math.max(0, Number(r.stock) + sign * qty)));
  });
}
function adjustCode_(code, sign) {
  if (!code) return;
  const cr = rows_("codes").find(x => String(x.code) === String(code));
  if (cr) sheet_("codes").getRange(cr._row, SHEETS.codes.indexOf("used") + 1).setNumberFormat("@").setValue(String(Math.max(0, (Number(cr.used) || 0) + sign)));
}
function releaseOrder_(o) {
  if (String(o.restocked) === "TRUE") return;
  adjustStock_(json_(o.items, []), +1); adjustCode_(String(o.code || ""), -1);
  setOrderField_(String(o.orderNo), { restocked: "TRUE" });
}
function reclaimOrder_(o) {
  if (String(o.restocked) !== "TRUE") return;
  adjustStock_(json_(o.items, []), -1); adjustCode_(String(o.code || ""), +1);
  setOrderField_(String(o.orderNo), { restocked: "" });
}
function expireOrders_(force) {
  const cache = CacheService.getScriptCache();
  if (!force && cache.get("expchk")) return;
  cache.put("expchk", "1", 600);
  const lock = LockService.getScriptLock(); if (!lock.tryLock(5000)) return;
  try {
    const now = Date.now(), t = s => Date.parse(String(s).replace(" ", "T") + ":00+08:00") || 0;
    rows_("orders").forEach(o => {
      const ps = String(o.payStatus);
      if (String(o.status) === "已取消" || (ps !== "awaiting" && ps !== "failed")) return;
      const made = t(o.createdAt); if (!made) return;
      let deadline;
      if (ps === "failed") deadline = made + 30 * 60000;
      else if (/^ATM/.test(String(o.payMethod)) && o.vaExpire) deadline = (Date.parse(String(o.vaExpire).replace(/\//g, "-").slice(0, 10) + "T23:59:59+08:00") || made + 3 * 86400000) + 3600000;
      else deadline = made + 2 * 3600000;
      if (now < deadline) return;
      setOrderField_(String(o.orderNo), { status: "已取消" });
      sysLog_("系統", "system", "逾期取消訂單", o.orderNo + "・未於期限內付款，已退回庫存", String(o.orderNo));
      releaseOrder_(o);
      if (o.lineUid) try { lineApi_("message/push", { to: String(o.lineUid), messages: [{ type: "text", text: "【赤貧軍團】訂單取消通知\n訂單編號：" + o.orderNo + "\n因未於付款期限內完成付款，本訂單已自動取消。" + backNote_(o) + "\n如仍有需要，歡迎重新下單：" + SHOP_PAGE }] }); } catch (e) {}
    });
  } finally { lock.releaseLock(); }
}

/* ───────────── 物流成本（報表用，2026-11-08）─────────────
   已建綠界寄件單：用建單當下記的 cost；沒建單（手動寄）：依包裹數與設定費率估算。費率未稅，×1.05 營業稅。 */
function logiFee_(cvs, spec, island) {
  const s = getSettings_(), tax = v => Math.round((Number(v) || 0) * 1.05);
  if (cvs) return tax(s.logiFeeCvs || 65);
  const list = String(s.logiFeeHome || "130,170,210,250").split(",").map(Number), i = Math.max(0, ["0001", "0002", "0003", "0004"].indexOf(spec || homeSpec_() || s.logiSize || "0001"));
  return tax((list[i] || list[0] || 130) + (island ? 90 : 0));
}
function logiCostOf_(o) {
  const list = json_(o.shipments, []), cvs = String(o.shipMethod) === SHIP_CVS;
  if (list.length) return list.reduce((a, x) => a + (Number(x.cost) || logiFee_(x.sub === "UNIMARTC2C")), 0);
  return (Number(o.packages) || 1) * logiFee_(cvs);
}


/* ───────────── LINE 官方帳號：歡迎詞、客服、圖文選單（2026-11-08）─────────────
   歡迎詞：加好友（follow 事件）時回覆一張卡片（主視覺、入會禮、按鈕）；官方帳號後台內建的「加入好友的歡迎訊息」已關閉，避免重複。
   客服：圖文選單「聯絡客服」送出固定文字 → 自動回覆客人，並推播通知管理者到官方帳號後台回覆。
   圖文選單：?action=lineSetup 只會建立一次（RICHMENU_V 記版本；改版就把 RICH_VER 加一），圖在網站 media/richmenu.jpg。
   follow／message 事件的 replyToken 只有 LINE 真的發出的才能用，所以偽造的請求不會讓我們亂發訊息。 */
const LINE_SITE = "https://linpoyes.github.io/lipo-guide/";
const UTM = "?utm_source=LINE&utm_medium=oa";
const LIFF_URL = "https://liff.line.me/2012457738-sW2OqmOO"; // 從 LINE 開賣場一律走 LIFF（免跳轉登入）
const CS_TEXT = "聯絡客服";
const CS_OLD = ["我要聯絡客服"]; // 舊版選單送出的文字，仍視為聯絡客服
function lineEvent_(ev) {
  const uid = ev.source && ev.source.userId; if (!uid || !ev.replyToken) return;
  if (ev.type === "follow") {
    let name = ""; try { const r = lineApi_("profile/" + uid); if (r && r.getResponseCode() === 200) name = JSON.parse(r.getContentText()).displayName || ""; } catch (e) {}
    const w = welcomeInfo_();
    if (w) w.expires = welcomeGrant_(uid, true).date; // 歡迎卡片已含入會禮（從現在起算期限），LINE 登入時不再重送
    lineApi_("message/reply", { replyToken: ev.replyToken, messages: welcomeMessages_(name, w) });
    return;
  }
  if (ev.type === "message" && ev.message && ev.message.type === "text" && (String(ev.message.text).trim() === CS_TEXT || CS_OLD.indexOf(String(ev.message.text).trim()) >= 0)) {
    let name = ""; try { const r = lineApi_("profile/" + uid); if (r && r.getResponseCode() === 200) name = JSON.parse(r.getContentText()).displayName || ""; } catch (e) {}
    lineApi_("message/reply", { replyToken: ev.replyToken, messages: [{ type: "text", text: "您好，已為您轉接客服人員，請稍候。\n\n為加快處理，請提供訂單編號或商品名稱，客服人員將盡快於此回覆您。" }] });
    // 2026-11-10 使用者：客服直接在官方帳號聊天室回覆即可，不再推播到管理者私人 LINE；只留紀錄

    sysLog_(name || "LINE 使用者", "customer", "聯絡客服", "透過官方帳號選單要求客服", "");
  }
}
// 歡迎訊息＝主卡片＋熱門商品圖卡（可左右滑，最多 6 件：熱銷優先、再依後台排序，排除售完）
function welcomeMessages_(name, w) {
  const msgs = [welcomeFlex_(name, w)], car = productCarousel_(6);
  if (car) msgs.push(car);
  return msgs;
}
function productCarousel_(n) {
  const ps = rows_("products").map(product_).filter(p => p.active && p.stock !== 0 && p.images.length).sort((a, b) => (b.hot - a.hot) || a.sort - b.sort).slice(0, n);
  if (!ps.length) return null;
  const img = src => /^drive:/.test(src) ? "https://lh3.googleusercontent.com/d/" + src.slice(6) + "=w1000" : /^https:/.test(src) ? src : LINE_SITE + src;
  const short = nm => String(nm).replace(/^.*?[｜|]\s*/, "") || nm;
  const bubble = p => ({ type: "bubble", size: "kilo",
    hero: { type: "image", url: img(p.images[0]), size: "full", aspectRatio: "4:3", aspectMode: "cover", action: { type: "uri", uri: LIFF_URL + UTM + "#p=" + p.id } },
    body: { type: "box", layout: "vertical", spacing: "xs", paddingAll: "14px", contents: [
      { type: "text", text: short(p.name), weight: "bold", size: "md", color: "#1A2130", wrap: true, maxLines: 2 },
      p.brand ? { type: "text", text: p.brand, size: "xxs", color: "#C9362C", weight: "bold" } : { type: "filler" },
      { type: "box", layout: "baseline", spacing: "sm", contents: [
        { type: "text", text: "$" + p.price.toLocaleString(), weight: "bold", size: "lg", color: "#D7261E", flex: 0 },
        p.listPrice > p.price ? { type: "text", text: "$" + p.listPrice.toLocaleString(), size: "xs", color: "#8C8880", decoration: "line-through", flex: 0 } : { type: "filler" },
        p.preorder ? { type: "text", text: "即將開賣", size: "xxs", color: "#575D69", align: "end" } : (p.hot ? { type: "text", text: "熱銷", size: "xxs", color: "#D7261E", weight: "bold", align: "end" } : { type: "filler" })] }] },
    footer: { type: "box", layout: "vertical", paddingAll: "10px", contents: [{ type: "button", style: "secondary", height: "sm", action: { type: "uri", label: "查看商品", uri: LIFF_URL + UTM + "#p=" + p.id } }] } });
  const more = { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", justifyContent: "center", alignItems: "center", spacing: "md", paddingAll: "20px", backgroundColor: "#1D2129", contents: [
    { type: "image", url: LINE_SITE + "badge.png", size: "sm", aspectRatio: "1:1" },
    { type: "text", text: "看更多商品", weight: "bold", size: "lg", color: "#FFFFFF", align: "center" },
    { type: "text", text: "遙控車・鋰電池・改裝配件", size: "xs", color: "#B4AFA6", align: "center" },
    { type: "button", style: "primary", color: "#D7261E", height: "sm", margin: "md", action: { type: "uri", label: "前往賣場", uri: LIFF_URL + UTM } }] } };
  return { type: "flex", altText: "熱門商品推薦", contents: { type: "carousel", contents: ps.map(bubble).concat([more]) } };
}
function welcomeFlex_(name, w) {
  const btn = (label, uri, primary) => ({ type: "button", style: primary ? "primary" : "secondary", color: primary ? "#D7261E" : undefined, height: "sm", action: { type: "uri", label: label, uri: uri } });
  const body = [
    { type: "text", text: "歡迎加入赤貧軍團", weight: "bold", size: "xl", color: "#1A2130" },
    { type: "text", text: (name ? name + " 您好，" : "您好，") + "感謝您加入赤貧軍團官方帳號。新品上架、優惠活動及訂單出貨進度，將於此即時通知您。", size: "sm", color: "#575D69", wrap: true, margin: "md" }];
  if (w) body.push({ type: "box", layout: "vertical", margin: "lg", paddingAll: "14px", cornerRadius: "10px", backgroundColor: "#FFF1EF", borderColor: "#D7261E", borderWidth: "1px", contents: [
    { type: "text", text: "入會禮　" + w.label, weight: "bold", size: "lg", color: "#D7261E" },
    { type: "text", text: "折扣碼 " + w.code + (w.minSpend ? "・滿 $" + w.minSpend + " 可用" : "") + "・限用一次", size: "xs", color: "#575D69", margin: "sm", wrap: true },
    { type: "text", text: "使用期限：" + (w.expires || Utilities.formatDate(new Date(Date.now() + welcomeDays_() * 86400000), "Asia/Taipei", "yyyy/MM/dd")) + " 前", size: "xs", color: "#D7261E", weight: "bold", wrap: true },
    { type: "text", text: "以 LINE 登入賣場會員後，結帳時即可使用", size: "xs", color: "#575D69", wrap: true }] });
  return { type: "flex", altText: "歡迎加入赤貧軍團" + (w ? "，入會禮 " + w.label + " 已送上" : ""), contents: { type: "bubble",
    hero: { type: "image", url: LINE_SITE + "media/welcome.jpg?v=2", size: "full", aspectRatio: "3:2", aspectMode: "cover", action: { type: "uri", uri: LIFF_URL + UTM } },
    body: { type: "box", layout: "vertical", contents: body },
    footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
      btn(w ? "登入會員・領取入會禮" : "登入會員", LIFF_URL + UTM + "#member", true), btn("逛賣場", LIFF_URL + UTM), btn("電池充電計算", LINE_SITE + UTM + "#calc")] } } };
}
const RICH_VER = "8";
function lineSetup_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty("RICHMENU_V") === RICH_VER) return { ok: true, done: true, result: p.getProperty("RICHMENU_RESULT") || "" };
  p.setProperty("RICHMENU_V", RICH_VER);
  const tk = p.getProperty("LINE_TOKEN"); if (!tk) return { ok: false, error: "no token" };
  const H = { Authorization: "Bearer " + tk };
  const W = 2500, Hh = 1686, cw = Math.floor(W / 3), rh = Math.floor(Hh / 2);
  const area = (c, r, action) => ({ bounds: { x: c * cw, y: r * rh, width: c === 2 ? W - 2 * cw : cw, height: r === 1 ? Hh - rh : rh }, action: action });
  const uri = (label, u) => ({ type: "uri", label: label, uri: u });
  const menu = { size: { width: W, height: Hh }, selected: true, name: "赤貧軍團主選單 v" + RICH_VER, chatBarText: "選單", areas: [
    area(0, 0, uri("逛賣場", LIFF_URL + "?utm_source=LINE&utm_medium=richmenu")),
    area(1, 0, uri("新品上架", LIFF_URL + "?utm_source=LINE&utm_medium=richmenu#new")),
    area(2, 0, uri("入會禮", LIFF_URL + "?utm_source=LINE&utm_medium=richmenu#member")),
    area(0, 1, uri("我的訂單", LIFF_URL + "?utm_source=LINE&utm_medium=richmenu#orders")),
    area(1, 1, uri("電池充電", LINE_SITE + "?utm_source=LINE&utm_medium=richmenu#calc")),
    area(2, 1, { type: "message", label: "聯絡客服", text: CS_TEXT })] };
  const log = [];
  try {
    const old = p.getProperty("RICHMENU_ID");
    const c = UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu", { method: "post", contentType: "application/json", headers: H, payload: JSON.stringify(menu), muteHttpExceptions: true });
    log.push("create " + c.getResponseCode());
    const id = JSON.parse(c.getContentText()).richMenuId; if (!id) throw new Error(c.getContentText().slice(0, 200));
    const img = UrlFetchApp.fetch(LINE_SITE + "media/richmenu.jpg?v=" + RICH_VER).getBlob().getBytes();
    const u = UrlFetchApp.fetch("https://api-data.line.me/v2/bot/richmenu/" + id + "/content", { method: "post", contentType: "image/jpeg", headers: H, payload: img, muteHttpExceptions: true });
    log.push("image " + u.getResponseCode());
    const d = UrlFetchApp.fetch("https://api.line.me/v2/bot/user/all/richmenu/" + id, { method: "post", headers: H, muteHttpExceptions: true });
    log.push("default " + d.getResponseCode());
    p.setProperty("RICHMENU_ID", id);
    if (old && old !== id) { const x = UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu/" + old, { method: "delete", headers: H, muteHttpExceptions: true }); log.push("delete old " + x.getResponseCode()); }
  } catch (e) { log.push("error " + String(e.message || e).slice(0, 200)); p.deleteProperty("RICHMENU_V"); }
  p.setProperty("RICHMENU_RESULT", log.join(", "));
  return { ok: true, result: log.join(", ") };
}

// 驗證歡迎卡片格式，並（只一次）推一則預覽給已綁定通知的管理者
function welcomePreview_() {
  const p = PropertiesService.getScriptProperties(), msgs = welcomeMessages_("", welcomeInfo_());
  const v = lineApi_("message/validate/push", { messages: msgs });
  const res = { ok: true, validate: v ? v.getResponseCode() + " " + v.getContentText().slice(0, 200) : "no token" };
  if (v && v.getResponseCode() === 200 && !p.getProperty("WELCOME_PREVIEWED_2")) {
    p.setProperty("WELCOME_PREVIEWED_2", "1");
    json_(p.getProperty("LINE_USERS"), []).forEach(u => lineApi_("message/push", { to: u.id, messages: [{ type: "text", text: "【預覽】新版歡迎訊息（新好友加入時自動送出）" }].concat(msgs) }));
    res.sent = true;
  }
  return res;
}

// 客服通知（給管理者）：卡片顯示顧客、時間、來源；不附網址（使用者 11-08）
function csNotify_(name, preview) {
  const t = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm");
  const row = (k, v) => ({ type: "box", layout: "baseline", spacing: "md", contents: [{ type: "text", text: k, size: "sm", color: "#8C8880", flex: 2 }, { type: "text", text: v, size: "sm", color: "#1A2130", weight: "bold", flex: 5, wrap: true }] });
  const msg = { type: "flex", altText: "【客服通知】顧客 " + name + " 等候回覆", contents: { type: "bubble", size: "kilo",
    header: { type: "box", layout: "vertical", backgroundColor: "#D7261E", paddingAll: "14px", contents: [{ type: "text", text: "客服通知", color: "#FFFFFF", weight: "bold", size: "lg" }, { type: "text", text: "顧客正在等候回覆", color: "#FFE3DF", size: "xs" }] },
    body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: [row("顧客", name), row("時間", t), row("來源", "聯絡客服"),
      { type: "separator", margin: "md" }, { type: "text", text: "請至官方帳號聊天室回覆顧客", size: "xs", color: "#8C8880", margin: "md", wrap: true }] } } };
  if (preview) return msg;
  json_(PropertiesService.getScriptProperties().getProperty("LINE_USERS"), []).forEach(u => lineApi_("message/push", { to: u.id, messages: [msg] }));
}
function csPreview_() {
  const p = PropertiesService.getScriptProperties(), msg = csNotify_("（範例顧客）", true);
  const v = lineApi_("message/validate/push", { messages: [msg] }), res = { ok: true, validate: v ? v.getResponseCode() + " " + v.getContentText().slice(0, 200) : "" };
  if (v && v.getResponseCode() === 200 && !p.getProperty("CS_PREVIEWED")) {
    p.setProperty("CS_PREVIEWED", "1");
    json_(p.getProperty("LINE_USERS"), []).forEach(u => lineApi_("message/push", { to: u.id, messages: [{ type: "text", text: "【預覽】客服通知樣式" }, msg] }));
    res.sent = true;
  }
  return res;
}


/* ───────────── 裝箱計算（2026-11-09）─────────────
   商品填「包裝後」長寬高（公分）＋重量（公斤）→ 依各種擺放方向算一個箱子能裝幾件（取最多的方向），再受重量上限限制。
   7-11 交貨便（綠界 C2C）：最長邊 45、三邊合計 105、10 公斤內 → 以 45×30×30 計。
   黑貓：用設定的紙箱內尺寸（homeBox，預設 40×30×20＝90 材），每箱 20 公斤內；材積級距由紙箱三邊合計決定。
   前台 admin.html 的 packCaps 必須跟這裡一致。 */
const CVS_BOX = [45, 30, 30], CVS_KG = 10, HOME_KG = 20, PACK_PAD = 1; // 每邊多留 1 公分給包材／緩衝，不必塞到剛好
function dims_(v) { const a = String(v || "").split(/[,x×*\s]+/).map(Number).filter(n => n > 0); return a.length === 3 ? a : []; }
function fit_(box, d) {
  const P = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  return Math.max.apply(null, P.map(p => Math.floor(box[0] / d[p[0]]) * Math.floor(box[1] / d[p[1]]) * Math.floor(box[2] / d[p[2]])));
}
let HOMEBOX_ = null; // 同一次執行只讀一次設定（product_ 每列都會用到）
function homeBox_() { if (!HOMEBOX_) { const b = dims_(getSettings_().homeBox); HOMEBOX_ = b.length ? b : [40, 30, 20]; } return HOMEBOX_; }
function homeSpec_() { const b = dims_(getSettings_().homeBox); if (!b.length) return ""; const t = b[0] + b[1] + b[2]; return t <= 60 ? "0001" : t <= 90 ? "0002" : t <= 120 ? "0003" : "0004"; }
function packCaps_(dimsStr, kg) {
  const d = dims_(dimsStr).map(n => n + PACK_PAD); if (d.length < 3) return null;
  const byKg = (lim) => kg > 0 ? Math.floor(lim / kg) : Infinity;
  return { cvs: Math.min(fit_(CVS_BOX, d), byKg(CVS_KG)), home: Math.max(1, Math.min(fit_(homeBox_(), d), byKg(HOME_KG))) }; // 放不進紙箱＝自己一箱
}

// 排程工作（2026-11-09）：逾期未付款取消、入會禮到期提醒。原本只在有人逛賣場時順便跑，改由 GitHub Actions 每小時打一次，不需要 Apps Script 觸發器授權。
// 兩個工作本身都冪等（restocked／r 記號），重複呼叫無害；15 分鐘內只會真的跑一次。
// 2026-11-09 使用者已填寄件人、要求直接處理 → 物流正式啟用（關測試模式、付款後自動建單），只跑一次
function migrateLogiLive_() {
  const p = PropertiesService.getScriptProperties(); if (p.getProperty("MIG_LOGILIVE")) return; p.setProperty("MIG_LOGILIVE", "1");
  if (!logiCfg_().public.senderOk) { p.deleteProperty("MIG_LOGILIVE"); return; }
  setSetting_("logiOn", "TRUE"); setSetting_("logiStage", "FALSE"); setSetting_("logiAuto", "TRUE");
}
function cron_() {
  try { migrateLogiLive_(); } catch (e) {}
  const c = CacheService.getScriptCache(); if (c.get("cronRan2")) return { ok: true, skipped: true }; c.put("cronRan2", "1", 900);
  const res = { ok: true, at: ts_(new Date()) };
  try { expireOrders_(true); res.expire = "ok"; } catch (e) { res.expire = String(e.message || e).slice(0, 100); }
  try { CacheService.getScriptCache().remove("wrem"); remindWelcome_(); res.remind = "ok"; } catch (e) { res.remind = String(e.message || e).slice(0, 100); }
  try { catalogCached_(); res.warm = "ok"; } catch (e) {} // 順便預熱型錄快取
  try { if (!c.get("ptrem")) { c.put("ptrem", "1", 21600); remindPoints_(); } res.ptrem = "ok"; } catch (e) { res.ptrem = String(e.message || e).slice(0, 80); }
  try { const l = logiCfg_().public; res.logi = (l.enabled ? "on" : "off") + "/" + (l.stage ? "stage" : "live") + "/" + (l.auto ? "auto" : "manual") + "/" + (l.senderOk ? "senderOk" : "senderMissing"); } catch (e) {} // 只回狀態，不含寄件人資料
  try { res.fees = syncFees_(); } catch (e) { res.fees = String(e.message || e).slice(0, 100); }
  return res;
}

/* 型錄快取（2026-11-09 使用者：從 LINE 點進賣場要等很久）：
   catalog_ 每次要讀商品、影片、設定、訂單（算已售）四張表，加上冷啟動要 4–8 秒。結果放 CacheService 1 小時；
   後台任何寫入、下單、庫存變動都會清掉，所以不會看到舊資料。單一快取值上限 100KB，超過就不快取。 */
function catalogCached_() {
  const c = CacheService.getScriptCache(), hit = c.get("catalogJson8");
  if (hit) return JSON.parse(hit);
  const d = catalog_(), j = JSON.stringify(d);
  if (j.length < 95000) c.put("catalogJson8", j, 3600);
  return d;
}
function dropCatalog_() { try { CacheService.getScriptCache().remove("catalogJson8"); } catch (e) {} }


/* ───────────── 後台操作紀錄（2026-11-09）─────────────
   每個後台寫入動作（含失敗與登入）都記一列：時間、帳號、角色、動作、白話內容、對象。密碼、金鑰、權杖一律不記。
   商品、設定、訂單狀態、權限這幾類會比對修改前後，寫出「售價 1200→1100」這種差異。
   非超級管理員做了敏感動作（刪除、付款狀態、權限、金流物流設定）會即時推 LINE 給管理者。 */
const AUDIT_NAME = {
  login: "登入", loginFail: "登入失敗", admin_saveProduct: "儲存商品", admin_deleteProduct: "刪除商品", admin_saveVideo: "儲存短影音", admin_deleteVideo: "刪除短影音",
  admin_saveCode: "儲存折扣碼", admin_deleteCode: "刪除折扣碼", admin_orderStatus: "變更訂單", admin_deleteOrder: "刪除訂單", admin_saveSettings: "修改設定",
  admin_saveUser: "帳號權限", admin_deleteUser: "刪除帳號", admin_changeLogin: "變更自己的帳號密碼", admin_saveEcpay: "修改金流設定", admin_upload: "上傳檔案",
  admin_trashFile: "刪除檔案", admin_logiCreate: "建立寄件單", admin_logiPrint: "列印託運單", admin_logiPrintBatch: "批次列印託運單", admin_saveExpense: "登錄支出",
  admin_deleteExpense: "刪除支出", admin_lineInvite: "產生 LINE 授權邀請", admin_lineInviteSelf: "綁定自己的 LINE", admin_lineUnbindUser: "解除 LINE 綁定", lineBind: "LINE 綁定帳號", lineLogin: "LINE 登入後台", lineLoginFail: "LINE 登入後台失敗", admin_lineSave: "修改 LINE 權杖", admin_lineBind: "產生 LINE 綁定碼", admin_lineUnbind: "移除 LINE 接收者", admin_lineTest: "傳送 LINE 測試",
  admin_setGithubToken: "設定 GitHub 權杖", admin_setLoginSecret: "設定 LINE 登入金鑰", admin_trafficPurge: "清除測試流量", admin_logiProbe: "物流連線測試" };
const SET_NAME = { shipFee: "黑貓運費", shipFeeCvs: "7-11 運費", freeShipOver: "免運門檻", lineUrl: "LINE 聯絡網址", notice: "賣場公告", ordersOpen: "開放下單", requireLine: "需 LINE 會員",
  shipBarOn: "免運公告條", shipBar: "免運公告文字", feeCardPct: "信用卡費率", feeCardMin: "信用卡最低", feeCardOrder: "信用卡處理費", feeAtmPct: "ATM 費率", feeAtmMin: "ATM 最低", feeSplit: "手續費分攤",
  welcomeCode: "入會禮", welcomeDays: "入會禮天數", welcomeRemind: "到期提醒天數", hotWords: "熱門搜尋", capital: "初始資金", pointsOn: "會員積分", pointRate: "積分比例", pointMaxPct: "積分折抵上限",
  logiOn: "綠界物流", logiStage: "物流測試模式", logiAuto: "自動建單", senderName: "寄件人", senderPhone: "寄件手機", senderZip: "寄件郵遞區號", senderAddr: "寄件地址", logiSize: "黑貓材積",
  logiFeeCvs: "交貨便運費成本", logiFeeHome: "黑貓運費成本", homeBox: "黑貓紙箱" };
const AUDIT_ALERT = /^admin_(lineInvite|lineUnbindUser|deleteOrder|deleteProduct|deleteCode|deleteUser|saveUser|saveEcpay|lineSave|setGithubToken|setLoginSecret|deleteExpense)$/;
const PROD_FIELDS = { name: "名稱", price: "售價", listPrice: "原價", stock: "庫存", active: "上架", preorder: "即將開賣", hot: "熱銷", cost: "成本", commission: "分潤%", splitMode: "拆帳方式", supplier: "貨主", category: "分類" };
function auditBefore_(a, r) {
  try {
    if (a === "admin_saveProduct" && r.product && r.product.id) return rows_("products").map(product_).find(p => p.id === String(r.product.id)) || null;
    if (a === "admin_deleteProduct") return rows_("products").map(product_).find(p => p.id === String(r.id)) || null;
    if (a === "admin_saveSettings") return getSettings_();
    if (a === "admin_orderStatus") { const nos = r.orderNos || [r.orderNo]; return rows_("orders").filter(o => nos.indexOf(String(o.orderNo)) >= 0).map(o => ({ no: String(o.orderNo), status: String(o.status), pay: String(o.payStatus) })); }
    if (a === "admin_saveUser" || a === "admin_deleteUser") { const u = users_()[String(r.name || "")]; return u ? { role: u.role, perms: permsOf_(u) } : null; }
  } catch (e) {}
  return null;
}
function auditDetail_(a, r, b, out) {
  const v = x => x === true ? "是" : x === false ? "否" : String(x === undefined || x === null || x === "" ? "（空）" : x);
  const PAY = { paid: "已付款", unpaid: "未付款", awaiting: "待付款", failed: "付款失敗" };
  switch (a) {
    case "admin_saveProduct": {
      const p = r.product || {};
      if (!b) return ["新增商品「" + p.name + "」售價 $" + p.price, String(out && out.id || "")];
      const ch = Object.keys(PROD_FIELDS).filter(k => p[k] !== undefined && String(p[k] === true ? "true" : p[k] === false ? "false" : p[k]) !== String(b[k] === true ? "true" : b[k] === false ? "false" : b[k]))
        .map(k => PROD_FIELDS[k] + " " + v(b[k]) + "→" + v(p[k]));
      if (JSON.stringify(p.images || []) !== JSON.stringify(b.images || [])) ch.push("圖片 " + (b.images || []).length + "→" + (p.images || []).length + " 張");
      if (String(p.desc || "") !== String(b.desc || "")) ch.push("商品介紹");
      return ["「" + b.name + "」" + (ch.length ? ch.join("、") : "無變更"), String(p.id)];
    }
    case "admin_deleteProduct": return ["「" + (b ? b.name : r.id) + "」", String(r.id)];
    case "admin_saveSettings": {
      const SECRET = /^(sender(Phone|Addr|Name))$/;
      const ch = Object.keys(r.settings || {}).filter(k => b && String(r.settings[k]) !== String(b[k] === true ? "TRUE" : b[k] === false ? "FALSE" : b[k]))
        .map(k => (SET_NAME[k] || k) + (SECRET.test(k) ? "（已修改）" : " " + v(b[k]) + "→" + v(r.settings[k])));
      return [ch.join("、") || "無變更", ""];
    }
    case "admin_orderStatus": {
      const nos = r.orderNos || [r.orderNo];
      return [(b || []).map(o => o.no + " " + (r.field === "payStatus" ? "付款 " + (PAY[o.pay] || o.pay) + "→" + (PAY[r.value] || r.value) : o.status + "→" + r.value)).join("；") || nos.join("、"), nos.join(",")];
    }
    case "admin_deleteOrder": return ["訂單 " + r.orderNo, String(r.orderNo)];
    case "admin_saveCode": return ["折扣碼 " + ((r.codeObj || {}).code || "") + "・" + (((r.codeObj || {}).type === "amount") ? "折 $" : "打折 ") + ((r.codeObj || {}).value || "") + ((r.codeObj || {}).active ? "" : "（停用）"), String((r.codeObj || {}).code || "")];
    case "admin_deleteCode": return ["折扣碼 " + r.code, String(r.code)];
    case "admin_saveUser": return ["帳號 " + r.name + "：" + (b ? (ROLES[b.role] || b.role) + "→" : "新增 ") + (ROLES[r.role] || r.role) + (r.role === "custom" ? "（" + (r.perms || []).join("、") + "）" : "") + (r.pass ? "・重設密碼" : ""), String(r.name)];
    case "admin_deleteUser": return ["帳號 " + r.name, String(r.name)];
    case "admin_lineInvite": case "admin_lineUnbindUser": return ["帳號 " + r.name, String(r.name)];
    case "admin_changeLogin": return [r.newUser && r.newUser !== r.me.user ? "帳號改名為 " + r.newUser + "・變更密碼" : "變更密碼", ""];
    case "admin_logiCreate": case "admin_logiPrint": return ["訂單 " + r.orderNo + (r.again ? "（重新建單）" : ""), String(r.orderNo)];
    case "admin_logiPrintBatch": return [(r.orderNos || []).length + " 筆訂單", (r.orderNos || []).join(",")];
    case "admin_saveExpense": return [((r.expense || {}).item || "") + " $" + ((r.expense || {}).amount || ""), String((r.expense || {}).id || "")];
    case "admin_saveVideo": return ["「" + ((r.video || {}).title || "") + "」", String((r.video || {}).id || "")];
    case "admin_upload": return [String(r.name || "") + "（" + String(r.mime || "") + "）", ""];
    case "admin_saveEcpay": return ["金鑰／模式（內容不記錄）", ""];
    case "loginFail": return ["帳號「" + String(r.user || "") + "」", ""];
    default: { const t = r.id || r.orderNo || r.code || r.name || ""; return [t ? String(t) : "", String(t)]; }
  }
}
function audit_(me, a, r, before, err, out) {
  try {
    const d = auditDetail_(a, r, before, out), detail = (err ? "【失敗】" + err + "　" : "") + d[0];
    const sh = sheet_("audit");
    sh.getRange(sh.getLastRow() + 1, 1, 1, 6).setNumberFormat("@").setValues([[ts_(new Date()), safeCell_(String(me.user || "")), String(me.role || ""), AUDIT_NAME[a] || a, safeCell_(detail.slice(0, 500)), safeCell_(String(d[1] || "").slice(0, 200))]]);
    if (!err && me.role !== "owner" && AUDIT_ALERT.test(a))
      linePush_("【赤貧軍團】後台操作通知\n帳號：" + me.user + "（" + (ROLES[me.role] || me.role) + "）\n動作：" + (AUDIT_NAME[a] || a) + "\n內容：" + d[0]);
  } catch (e) {}
}


/* ───────────── 綠界實際手續費（2026-11-09，比照欣瀚賣場）─────────────
   原本用公式估（費率×1.05＋固定處理費 1 元），但綠界實際每筆處理費是 1～2 元，報表會跟綠界對不上。
   付款成功當下與每次排程，用 QueryTradeInfo 查 HandlingCharge（綠界實際扣的手續費，含稅）寫回 payFee，feeSrc＝ecpay；
   查不到的維持估算（feeSrc 空），報表會標「估算」。 */
function ecpayFee_(tradeNo) {
  const cfg = ecpayCfg_(); if (!cfg.mid || !tradeNo) return null;
  const p = { MerchantID: cfg.mid, MerchantTradeNo: tradeNo, TimeStamp: String(Math.floor(Date.now() / 1000)) };
  p.CheckMacValue = checkMac_(p, cfg);
  const res = UrlFetchApp.fetch(cfg.host + "/Cashier/QueryTradeInfo/V5", { method: "post", payload: p, muteHttpExceptions: true }).getContentText();
  const q = {}; res.split("&").forEach(kv => { const i = kv.indexOf("="); if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " ")); });
  if (String(q.TradeStatus) !== "1" || q.HandlingCharge === undefined || q.HandlingCharge === "") return null;
  return Math.round(Number(q.HandlingCharge) || 0);
}
function syncFees_() {
  let n = 0, done = 0;
  rows_("orders").forEach(o => {
    if (n >= 15 || String(o.payStatus) !== "paid" || String(o.feeSrc) === "ecpay" || !o.ecpayNo) return;
    n++;
    const real = ecpayFee_(String(o.ecpayNo));
    if (real !== null) { setOrderField_(String(o.orderNo), { payFee: String(real), feeSrc: "ecpay" }); done++; }
  });
  return done + "/" + n;
}

// 顧客與系統事件也寫進操作紀錄（2026-11-09 使用者：超級管理員要看到任何人留下的紀錄）
function sysLog_(who, role, action, detail, target) {
  try { const sh = sheet_("audit"); sh.getRange(sh.getLastRow() + 1, 1, 1, 6).setNumberFormat("@").setValues([[ts_(new Date()), safeCell_(String(who).slice(0, 40)), role, action, safeCell_(String(detail).slice(0, 500)), safeCell_(String(target || ""))]]); } catch (e) {}
}


/* ───────────── 後台 LINE 授權（2026-11-09）─────────────
   超級管理員在「帳號與權限」對某帳號按「LINE 授權邀請」→ 一次性連結（7 天、用過即失效）傳給對方 →
   對方用 LINE 登入一次就綁定，之後後台按「LINE 登入」免密碼。誰綁定、何時、LINE 名稱都存在帳號上，紀錄頁也有，並 LINE 通知超級管理員。
   LINE Login 的 Callback 只登記了 shop.html，所以 state 以 a_ 開頭，賣場頁一載入就把 ?code&state 轉給 admin.html。 */
function inviteOf_(name) {
  const all = PropertiesService.getScriptProperties().getProperties(); let best = null;
  Object.keys(all).forEach(k => { if (k.indexOf("INV_") !== 0) return; const v = json_(all[k], null); if (v && v.user === name && v.exp > Date.now()) best = Utilities.formatDate(new Date(v.exp), "Asia/Taipei", "MM/dd HH:mm"); });
  return best;
}
function lineIdent_(code, nonce) {
  const secret = PropertiesService.getScriptProperties().getProperty("LINE_LOGIN_SECRET");
  const tok = JSON.parse(UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/token", { method: "post", muteHttpExceptions: true,
    payload: { grant_type: "authorization_code", code: code, redirect_uri: LOGIN_SHOP, client_id: LINE_LOGIN_ID, client_secret: secret } }).getContentText());
  if (!tok.id_token) return null;
  const idt = JSON.parse(UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", { method: "post", muteHttpExceptions: true,
    payload: { id_token: tok.id_token, client_id: LINE_LOGIN_ID, nonce: nonce } }).getContentText());
  return idt.sub ? { uid: idt.sub, name: idt.name || "", pic: idt.picture || "" } : null;
}
function adminLine_(req) {
  const id = String(req.code || "") && String(req.nonce || "") ? lineIdent_(String(req.code), String(req.nonce)) : null;
  if (!id) return { ok: false, error: "LINE 驗證失敗，請再試一次" };
  const p = PropertiesService.getScriptProperties(), u = users_();
  let name = Object.keys(u).find(n => u[n].lineUid === id.uid);
  if (req.invite) {
    const k = "INV_" + hash_(String(req.invite)), inv = json_(p.getProperty(k), null);
    if (!inv || inv.exp < Date.now() || !u[inv.user]) return { ok: false, error: "邀請連結無效或已過期，請向超級管理員索取新連結" };
    if (name && name !== inv.user) return { ok: false, error: "此 LINE 已綁定帳號「" + name + "」，一個 LINE 只能綁定一個帳號" };
    name = inv.user;
    Object.assign(u[name], { lineUid: id.uid, lineName: id.name, linePic: id.pic, lineAt: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm") });
    saveUsers_(u); p.deleteProperty(k);
    try { sysLogDetail_(name, u[name].role, "LINE 綁定帳號", "帳號 " + name + " 綁定 LINE「" + id.name + "」（邀請人 " + inv.by + "）", name); } catch (e) {}
    linePush_("【赤貧軍團】後台 LINE 綁定通知\n帳號：" + name + "（" + (ROLES[u[name].role] || u[name].role) + "）\nLINE 名稱：" + id.name + "\n邀請人：" + inv.by);
  }
  if (!name) { sysLog_(id.name || "LINE 使用者", "", "LINE 登入後台失敗", "LINE「" + id.name + "」尚未授權", ""); return { ok: false, error: "此 LINE 尚未授權登入後台，請向超級管理員索取邀請連結" }; }
  if (!req.invite) sysLog_(name, u[name].role, "LINE 登入後台", "LINE「" + id.name + "」", name);
  return Object.assign(issueSession_(name), { role: u[name].role, isDefault: false, lineName: id.name });
}
function sysLogDetail_(who, role, action, detail, target) { sysLog_(who, role, action, detail, target); }


/* ───────────── LIFF（2026-11-09）─────────────
   在 LINE 裡開賣場改走 LIFF：不必跳轉 LINE 登入頁，LIFF SDK 直接給 id_token＋access token，後端驗證後發會員權杖（liffLogin_）。
   LIFF app 建在 LINE Login channel 2012457738，endpoint＝shop.html，botPrompt aggressive（同時邀加好友）。liffSetup_ 只建一次，ID 存 LIFF_ID。 */
function liffSetup_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty("LIFF_ID")) return { ok: true, liffId: p.getProperty("LIFF_ID") };
  const secret = p.getProperty("LINE_LOGIN_SECRET");
  const tk = JSON.parse(UrlFetchApp.fetch("https://api.line.me/oauth2/v3/token", { method: "post", muteHttpExceptions: true,
    payload: { grant_type: "client_credentials", client_id: LINE_LOGIN_ID, client_secret: secret } }).getContentText());
  if (!tk.access_token) return { ok: false, error: "token", detail: JSON.stringify(tk).slice(0, 200) };
  const r = UrlFetchApp.fetch("https://api.line.me/liff/v1/apps", { method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + tk.access_token },
    payload: JSON.stringify({ view: { type: "full", url: SHOP_PAGE }, description: "赤貧軍團賣場", features: { qrCode: false }, permanentLinkPattern: "concat", scope: ["openid", "profile"], botPrompt: "aggressive" }) });
  const j = json_(r.getContentText(), {});
  if (!j.liffId) return { ok: false, error: "create " + r.getResponseCode(), detail: r.getContentText().slice(0, 300) };
  p.setProperty("LIFF_ID", j.liffId);
  return { ok: true, liffId: j.liffId };
}
function liffLogin_(req) {
  try {
    const idt = JSON.parse(UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", { method: "post", muteHttpExceptions: true,
      payload: { id_token: String(req.idToken || ""), client_id: LINE_LOGIN_ID } }).getContentText());
    if (!idt.sub) return { ok: false, error: "LINE 驗證失敗" };
    const r = memberFromLine_(idt, String(req.accessToken || ""));
    return { ok: true, mt: r.mt, member: memberCheck_(r.mt).member };
  } catch (e) { return { ok: false, error: "LINE 驗證失敗" }; }
}

// 取消通知附註：入會禮折扣碼、積分已退回（取消的訂單不算使用，系統自動恢復可用）
function backNote_(o) {
  const n = [];
  if (o.code && isWelcome_(o.code)) { const g = welcomeGrant_(String(o.lineUid), false); n.push(g.expired ? "入會禮已超過使用期限，無法退回" : "入會禮 " + o.code + " 已退回，可於 " + g.date + " 前再次使用"); }
  if (Number(o.pointsUsed) > 0) n.push("折抵的 " + o.pointsUsed + " 點已退回");
  return n.length ? "\n" + n.join("\n") : "";
}
