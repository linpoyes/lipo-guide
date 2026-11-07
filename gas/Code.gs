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
  products: ["id", "name", "category", "price", "listPrice", "desc", "images", "tiers", "stock", "active", "hot", "sort", "updatedAt", "cvsOk", "brand", "supplier", "commission", "preorder", "cvsPer", "homePer"],
  videos:   ["id", "title", "src", "poster", "productId", "active", "sort", "updatedAt"],
  codes:    ["code", "type", "value", "minSpend", "startAt", "endAt", "limit", "used", "active", "note", "member"],
  orders:   ["orderNo", "createdAt", "name", "phone", "line", "shipMethod", "address", "note", "items", "subtotal", "tierSaving", "code", "codeDiscount", "shipping", "total", "status", "payStatus", "clientId", "packages", "lineUid", "lineName", "payMethod", "ecpayNo", "payFee", "paidAt", "vaBank", "vaAccount", "vaExpire", "pointsUsed", "shipments"],
  settings: ["key", "value"],
  // 流量（2026-11-08）：前台 track.js 送來的事件，一列一筆；ts＝台北時間 yyyy-MM-dd HH:mm:ss
  traffic:  ["ts", "vid", "sid", "type", "page", "pid", "q", "n", "src", "ref", "dev", "os"],
  // LINE 會員名冊：登入時寫入／更新（uid＝LINE userId）
  members:  ["uid", "name", "pic", "friend", "firstAt", "lastAt", "logins"],
};
// 試算表分頁的中文名稱（給使用者自己打開試算表時看得懂）
const TAB = { products: "商品", videos: "影片", codes: "折扣碼", orders: "訂單", settings: "設定", traffic: "流量", members: "會員" };
// 寄送只有兩種（使用者 2026-10-31 定）：黑貓宅配（大件、遙控車）／7-11 店到店（商品勾「可超商寄送」的小件才可選）
const SHIP_HOME = "黑貓宅配", SHIP_CVS = "7-11 店到店";
// ordersOpen：全站是否開放下單（2026-11-07 使用者：商品先上架、先不開放下單）
const DEFAULT_SETTINGS = { shipFee: 150, shipFeeCvs: 60, freeShipOver: 2000, lineUrl: "", notice: "", ordersOpen: "FALSE", requireLine: "TRUE", shipBarOn: "TRUE", shipBar: "",
  // LINE 入會禮（2026-11-08）：指定一組折扣碼；LINE 登入＋加好友的會員才能用、每人限一次，加好友時用 LINE 送到對方手機。空白＝不送
  welcomeCode: "",
  // 賣場熱門搜尋關鍵字（逗號分隔）；空白＝前台依品牌與分類自動產生
  hotWords: "",
  // 會員積分（2026-11-08）：已付款訂單每消費 pointRate 元回饋 1 點；1 點折抵 1 元；單筆最多折抵商品金額的 pointMaxPct %
  pointsOn: "TRUE", pointRate: "100", pointMaxPct: "50",
  // 綠界物流（2026-11-08）：寄件人資料、預設材積（0001=60cm…0004=150cm）、付款後自動建寄件單、測試模式
  logiOn: "FALSE", logiStage: "TRUE", logiAuto: "TRUE", senderName: "", senderPhone: "", senderZip: "", senderAddr: "", logiSize: "0001",
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
  if (a === "catalog") return out_(catalog_());
  if (a === "ping") return out_({ ok: true });
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
    if (a === "quote") return out_({ ok: true, quote: quote_(req.items, req.code, req.shipMethod, req.memberToken ? memberOf_(req.memberToken) : null, !!req.usePoints) });
    if (a === "memberCenter") return out_(memberCenter_(req));
    if (a === "order") return out_(placeOrder_(req));
    if (a === "login") return out_(login_(req.user, req.pass));
    if (a === "track") return out_(track_(req));
    if (a === "lineLogin") return out_(lineLoginPost_(req));
    if (a && a.indexOf("admin_") === 0) {
      const me = checkToken_(req.token);
      if (!me) return out_({ ok: false, error: "auth" });
      const fn = ADMIN[a];
      if (!fn) return out_({ ok: false, error: "unknown action" });
      if (!can_(me.role, a)) return out_({ ok: false, error: "此帳號沒有權限" });
      req.me = me;
      return out_(Object.assign({ ok: true }, fn(req) || {}));
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
  return {
    id: String(r.id), name: String(r.name), category: String(r.category || ""),
    price: Number(r.price) || 0, listPrice: Number(r.listPrice) || 0, desc: String(r.desc || ""),
    images: json_(r.images, []), tiers: json_(r.tiers, []),
    stock: r.stock === "" || r.stock === null ? -1 : Number(r.stock),
    active: bool_(r.active), hot: bool_(r.hot), sort: Number(r.sort) || 0, cvsOk: bool_(r.cvsOk), brand: String(r.brand || "").trim(),
    // 代銷：supplier＝供貨商（空白＝自有商品）、commission＝我方抽成 %、preorder＝此商品暫不開放下單（即將開賣）
    supplier: String(r.supplier || "").trim(), commission: Number(r.commission) || 0, preorder: bool_(r.preorder),
    // 包裝：一個 7-11 交貨便／一箱黑貓宅急便各可裝幾件（0＝不限，整單一個包裹）
    cvsPer: Number(r.cvsPer) || 0, homePer: Number(r.homePer) || 0,
  };
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
function catalog_() {
  const bySort = (a, b) => a.sort - b.sort;
  const s = getSettings_();
  return {
    ok: true,
    products: withSold_(rows_("products").map(product_).filter(p => p.active)).sort(bySort),
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
    lines.push({ id: p.id, name: p.name, qty: qty, price: p.price, unit: u, total: u * qty, supplier: p.supplier, commission: p.commission });
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
    if (!pay) lineNotifyOrder_(orderNo, "新訂單"); // 線上付款的單等付款成功才通知
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
const ROLES = { owner: "管理者", staff: "營運", shipper: "出貨", viewer: "報表" };
const ROLE_ACTIONS = {
  staff: ["admin_all", "admin_dashboard", "admin_orders", "admin_logiCreate", "admin_logiPrint", "admin_orderStatus", "admin_saveProduct", "admin_deleteProduct", "admin_saveVideo", "admin_deleteVideo",
          "admin_saveCode", "admin_deleteCode", "admin_upload", "admin_changeLogin", "admin_me"],
  shipper: ["admin_all", "admin_orders", "admin_orderStatus", "admin_logiCreate", "admin_logiPrint", "admin_changeLogin", "admin_me"],
  viewer: ["admin_all", "admin_orders", "admin_changeLogin", "admin_me", "admin_dashboard"],
};
const can_ = (role, action) => role === "owner" || (ROLE_ACTIONS[role] || []).indexOf(action) >= 0;
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
  u[user] = { salt: salt, hash: hash_(salt + ":" + pass), role: role || (u[user] && u[user].role) || "owner" };
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
  const token = Utilities.getUuid() + Utilities.getUuid();
  const props = PropertiesService.getScriptProperties(), now = Date.now();
  Object.keys(props.getProperties()).forEach(k => { if (k.indexOf("SESS_") === 0 && k.indexOf("SESS_REVOKED_") < 0 && Number(String(props.getProperty(k)).split("|")[0]) < now) props.deleteProperty(k); });
  props.setProperty("SESS_" + hash_(token), (now + SESSION_DAYS * 86400000) + "|" + user);
  // 指令碼屬性剛寫入時，下一個請求偶爾讀不到（10-31 實測：登入後第一個動作回 auth），所以同時放快取（最長 6 小時）
  cache.put("tok:" + token, user, 21600);
  return { ok: true, token: token, user: user, role: rec.role, isDefault: pass === "01" };
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
  return rec ? { user: user, role: rec.role } : null;
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
  admin_logiCreate: r => ({ shipments: logiCreate_(String(r.orderNo), !!r.again) }),
  admin_logiPrint: r => logiPrint_(String(r.orderNo)),
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
  admin_users: () => ({ users: Object.keys(users_()).map(n => ({ name: n, role: users_()[n].role })), roles: ROLES }),
  admin_saveUser: r => {
    const name = String(r.name || "").normalize("NFKC").trim(), role = String(r.role || ""), pass = String(r.pass || "").normalize("NFKC").trim();
    if (!/^[\w.@-]{2,20}$/.test(name)) throw new Error("帳號限英數字 2–20 碼");
    if (!ROLES[role]) throw new Error("請選擇權限");
    const u = users_(), isNew = !u[name];
    if (isNew && pass.length < 4) throw new Error("新帳號密碼至少 4 碼");
    if (!isNew && u[name].role === "owner" && role !== "owner" && Object.keys(u).filter(n => u[n].role === "owner").length < 2) throw new Error("至少要保留一個管理者");
    if (name === r.me.user && role !== "owner") throw new Error("不能降低自己的權限");
    if (pass) { setAdmin_(name, pass, role); if (!isNew) revokeUser_(name); }
    else { u[name].role = role; saveUsers_(u); }
  },
  admin_deleteUser: r => {
    const u = users_(), name = String(r.name || "");
    if (!u[name]) return;
    if (name === r.me.user) throw new Error("不能刪除自己");
    if (u[name].role === "owner" && Object.keys(u).filter(n => u[n].role === "owner").length < 2) throw new Error("至少要保留一個管理者");
    delete u[name]; saveUsers_(u); revokeUser_(name);
  },
  admin_orders: () => ({
    orders: rows_("orders").map(o => ({
      orderNo: String(o.orderNo), createdAt: String(o.createdAt), name: String(o.name), phone: String(o.phone),
      line: String(o.line), shipMethod: String(o.shipMethod), address: String(o.address), note: String(o.note),
      items: json_(o.items, []), subtotal: Number(o.subtotal), tierSaving: Number(o.tierSaving), code: String(o.code),
      codeDiscount: Number(o.codeDiscount), shipping: Number(o.shipping), packages: Number(o.packages) || 1, total: Number(o.total),
      status: String(o.status), payStatus: String(o.payStatus), lineName: String(o.lineName || ""), lineUid: String(o.lineUid || ""), payMethod: String(o.payMethod || ""), payFee: Number(o.payFee) || 0,
      paidAt: String(o.paidAt || ""), vaBank: String(o.vaBank || ""), vaAccount: String(o.vaAccount || ""), vaExpire: String(o.vaExpire || ""), pointsUsed: Number(o.pointsUsed) || 0, shipments: json_(o.shipments, []),
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
      preorder: p.preorder ? "TRUE" : "FALSE", cvsPer: String(Math.max(0, Math.floor(Number(p.cvsPer) || 0))), homePer: String(Math.max(0, Math.floor(Number(p.homePer) || 0))),
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
    if (r.field === "payStatus" && r.me.role !== "owner" && r.me.role !== "staff") throw new Error("此帳號沒有權限");
    const nos = r.orderNos || [r.orderNo];
    const sh = sheet_("orders"), col = SHEETS.orders.indexOf(r.field === "payStatus" ? "payStatus" : "status") + 1;
    rows_("orders").forEach(o => { if (nos.indexOf(String(o.orderNo)) >= 0) sh.getRange(o._row, col).setNumberFormat("@").setValue(String(r.value)); });
  },
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
    ["shipFee", "shipFeeCvs", "freeShipOver", "lineUrl", "notice", "ordersOpen", "requireLine", "shipBarOn", "shipBar", "feeCardPct", "feeCardMin", "feeCardOrder", "feeAtmPct", "feeAtmMin", "feeSplit", "welcomeCode", "hotWords", "pointsOn", "pointRate", "pointMaxPct", "logiOn", "logiStage", "logiAuto", "senderName", "senderPhone", "senderZip", "senderAddr", "logiSize"].forEach(k => { if (s[k] !== undefined) setSetting_(k, s[k]); });
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
    if (String(o.payStatus) !== "paid") {
      if (logiCfg_().auto) try { logiCreate_(String(o.orderNo)); } catch (err) {} // 付款成功自動建綠界寄件單，通知裡就有交貨便代號／託運單號
      lineNotifyOrder_(String(o.orderNo), "已付款，請出貨");
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
    linePush_(["【赤貧軍團】" + title, "訂單 " + o.orderNo, items,
      "金額 $" + Number(o.total).toLocaleString() + "（" + pay + "）",
      "寄送：" + o.shipMethod + "・" + (Number(o.packages) || 1) + (cvs ? " 個交貨便" : " 箱宅急便"),
      "收件人：" + o.name + "　" + o.phone, (cvs ? "門市：" : "地址：") + o.address, o.note ? "備註：" + o.note : "",
      shipLines_(o),
      "開啟訂單／列印出貨單：https://linpoyes.github.io/lipo-guide/admin.html#order=" + o.orderNo].filter(Boolean).join("\n"));
  } catch (e) {}
}
function lineWebhook_(e) {
  const ok = ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  let body; try { body = JSON.parse(e.postData.contents); } catch (err) { return ok; }
  const code = CacheService.getScriptCache().get("lineBind");
  (body.events || []).forEach(ev => {
    if (!code || ev.type !== "message" || !ev.message || ev.message.type !== "text") return;
    if (String(ev.message.text).trim() !== code || !ev.source || !ev.source.userId) return;
    const p = PropertiesService.getScriptProperties(), users = json_(p.getProperty("LINE_USERS"), []);
    let name = "";
    try { const r = lineApi_("profile/" + ev.source.userId); if (r && r.getResponseCode() === 200) name = JSON.parse(r.getContentText()).displayName || ""; } catch (err) {}
    if (!users.some(u => u.id === ev.source.userId)) users.push({ id: ev.source.userId, name: name });
    p.setProperty("LINE_USERS", JSON.stringify(users));
    CacheService.getScriptCache().remove("lineBind");
    lineApi_("message/reply", { replyToken: ev.replyToken, messages: [{ type: "text", text: "已綁定！之後有新訂單或付款成功，會在這裡通知你。" }] });
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
    const r = lineExchange_(String(req.code || ""), String(req.state || ""), LOGIN_SHOP);
    return r.mt ? { ok: true, mt: r.mt } : { ok: false, error: "LINE 登入未完成，請再試一次" };
  } catch (e) { return { ok: false, error: "LINE 登入未完成，請再試一次" }; }
}
function lineExchange_(code, state, redirect) {
  const cache = CacheService.getScriptCache(), st = cache.get("lls:" + state); // state 防 CSRF（一次性）
  if (!st) return { err: "state" };
  cache.remove("lls:" + state);
  const secret = PropertiesService.getScriptProperties().getProperty("LINE_LOGIN_SECRET");
  const tok = JSON.parse(UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/token", { method: "post", muteHttpExceptions: true,
    payload: { grant_type: "authorization_code", code: code, redirect_uri: redirect, client_id: LINE_LOGIN_ID, client_secret: secret } }).getContentText());
  if (!tok.id_token) return { err: "token" };
  const idt = JSON.parse(UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", { method: "post", muteHttpExceptions: true,
    payload: { id_token: tok.id_token, client_id: LINE_LOGIN_ID, nonce: st } }).getContentText());
  if (!idt.sub) return { err: "verify" };
  const fr = JSON.parse(UrlFetchApp.fetch("https://api.line.me/friendship/v1/status", { muteHttpExceptions: true, headers: { Authorization: "Bearer " + tok.access_token } }).getContentText());
  const mt = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  const rec = { uid: idt.sub, name: idt.name || "", pic: idt.picture || "", friend: !!fr.friendFlag, at: tok.access_token, exp: Date.now() + 30 * 86400000 };
  PropertiesService.getScriptProperties().setProperty("MEM_" + hash_(mt), JSON.stringify(rec));
  welcomePush_(rec);
  memberLog_(rec, true);
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
    welcome: w ? Object.assign({ code: w.code, used: welcomeUsed_(m.uid) }, { label: w.label, minSpend: w.minSpend }) : null } };
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
    p.setProperty(k, "1");
    lineApi_("message/push", { to: rec.uid, messages: [{ type: "text", text:
      "歡迎加入赤貧軍團會員" + (rec.name ? "，" + rec.name : "") + "！\n\n入會禮：" + w.label + "\n折扣碼：" + w.code +
      (w.minSpend ? "\n使用條件：消費滿 $" + w.minSpend : "") + "\n每位會員限用一次，結帳時輸入折扣碼即可折抵。\n\n" + SHOP_PAGE }] });
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
function pointsOf_(uid, list) {
  const pc = pointCfg_(); let earned = 0, used = 0, pending = 0;
  (list || rows_("orders")).forEach(o => {
    if (String(o.lineUid) !== uid || !orderLive_(o)) return;
    used += Number(o.pointsUsed) || 0;
    const pts = Math.floor(goods_(o) / pc.rate);
    if (String(o.payStatus) === "paid") earned += pts; else pending += pts;
  });
  return { earned: earned, used: used, pending: pending, balance: Math.max(0, earned - used) };
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
  if (w && m.friend) coupons.push({ code: w.code, label: w.label, minSpend: w.minSpend, endAt: "", note: "入會禮・限用一次", used: welcomeUsed_(m.uid) });
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
  return { on: on, auto: on && s.logiAuto !== "FALSE", stage: stage, mid: mid, key: key, iv: iv, sender: sender, size: /^000[1-4]$/.test(s.logiSize) ? s.logiSize : "0001",
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
      sub: cvs ? "UNIMARTC2C" : "TCAT", trade: p.MerchantTradeNo, at: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm"), st: r.RtnMsg || "", stage: cfg.stage });
  }
  setOrderField_(orderNo, { shipments: JSON.stringify(list) });
  return list;
}
function logiPrint_(orderNo) {
  const o = rows_("orders").find(x => String(x.orderNo) === orderNo); if (!o) throw new Error("查無訂單");
  const list = json_(o.shipments, []); if (!list.length) throw new Error("尚未建立寄件單");
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
  const upd = { shipments: JSON.stringify(list) };
  const back = /退|拒收|未取|逾期|異常|遺失|取消/.test(msg);
  const done = !back && /取件成功|已取件|取貨成功|配達完成|已配達|順利送達|簽收/.test(msg);
  const arrived = !back && !done && /到店|配達.*門市|抵達.*門市|已到/.test(msg);
  const shipped = !back && !done && !arrived && /收件|已寄件|配送中|出貨|轉運|集貨|出庫/.test(msg);
  const st = String(o.status), uid = String(o.lineUid || "");
  const push = t => { if (uid) lineApi_("message/push", { to: uid, messages: [{ type: "text", text: t }] }); };
  if (done && st !== "已完成" && st !== "已取消") upd.status = "已完成";
  if ((shipped || arrived) && (st === "新訂單" || st === "已確認")) upd.status = "已出貨";
  setOrderField_(String(o.orderNo), upd);
  try {
    const key = "LGN_" + sh.id + "_" + (done ? "d" : arrived ? "a" : shipped ? "s" : "");
    const pp = PropertiesService.getScriptProperties();
    if ((shipped || arrived || done) && !pp.getProperty(key)) {
      pp.setProperty(key, "1");
      const cvs = sh.sub === "UNIMARTC2C";
      if (shipped) push("【赤貧軍團】您的訂單 " + o.orderNo + " 已出貨\n" + (cvs ? "7-11 交貨便代號：" : "黑貓託運單號：") + sh.no + (cvs ? "\n商品到店後會再通知您取貨" : "\n可至黑貓宅急便官網查詢配送進度"));
      if (arrived) push("【赤貧軍團】您的訂單 " + o.orderNo + " 已送達取貨門市\n" + String(o.address).replace(/（店號.*?）/, "") + "\n請攜帶證件於 7 天內取貨");
      if (done) push("【赤貧軍團】訂單 " + o.orderNo + " 已完成取件，感謝您的支持！");
    }
  } catch (e) {}
  return text("1|OK");
}
function shipLines_(o) {
  const list = json_(o.shipments, []); if (!list.length) return "";
  const cvs = list[0].sub === "UNIMARTC2C";
  return (cvs ? "交貨便代號：" : "黑貓託運單號：") + list.map(s => s.no).join("、") + (list[0].stage ? "（測試）" : "");
}
