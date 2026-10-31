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
  products: ["id", "name", "category", "price", "listPrice", "desc", "images", "tiers", "stock", "active", "hot", "sort", "updatedAt", "cvsOk"],
  videos:   ["id", "title", "src", "poster", "productId", "active", "sort", "updatedAt"],
  codes:    ["code", "type", "value", "minSpend", "startAt", "endAt", "limit", "used", "active", "note"],
  orders:   ["orderNo", "createdAt", "name", "phone", "line", "shipMethod", "address", "note", "items", "subtotal", "tierSaving", "code", "codeDiscount", "shipping", "total", "status", "payStatus", "clientId"],
  settings: ["key", "value"],
};
// 試算表分頁的中文名稱（給使用者自己打開試算表時看得懂）
const TAB = { products: "商品", videos: "影片", codes: "折扣碼", orders: "訂單", settings: "設定" };
// 寄送只有兩種（使用者 2026-10-31 定）：黑貓宅配（大件、遙控車）／7-11 店到店（商品勾「可超商寄送」的小件才可選）
const SHIP_HOME = "黑貓宅配", SHIP_CVS = "7-11 店到店";
const DEFAULT_SETTINGS = { shipFee: 150, shipFeeCvs: 60, freeShipOver: 2000, lineUrl: "", notice: "" };
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
  if (a === "store") { // 賣場輪詢：選門市的結果（sk 是賣場產生的一次性亂數）
    const v = CacheService.getScriptCache().get("store:" + String((e.parameter || {}).sk || ""));
    return out_({ ok: true, store: v ? JSON.parse(v) : null });
  }
  return out_({ ok: false, error: "unknown action" });
}

function doPost(e) {
  // 7-11 電子地圖選完門市後，會把門市資料以表單 POST 回這裡（?cb=711），轉交回賣場
  if (e.parameter && e.parameter.cb === "711") return storeReturn_(e.parameter);
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "格式錯誤" }); }
  try {
    const a = req.action;
    if (a === "quote") return out_({ ok: true, quote: quote_(req.items, req.code, req.shipMethod) });
    if (a === "order") return out_(placeOrder_(req));
    if (a === "login") return out_(login_(req.user, req.pass));
    if (a && a.indexOf("admin_") === 0) {
      if (!checkToken_(req.token)) return out_({ ok: false, error: "auth" });
      const fn = ADMIN[a];
      if (!fn) return out_({ ok: false, error: "unknown action" });
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
function sheet_(k) {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID")).getSheetByName(TAB[k]);
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
  const vals = [cols.map(c => String(obj[c] === undefined ? (found ? found[c] : "") : obj[c] === null ? "" : obj[c]))];
  const row = found ? found._row : sh.getLastRow() + 1;
  const rg = sh.getRange(row, 1, 1, cols.length);
  rg.setNumberFormat("@");
  rg.setValues(vals);
}
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
    active: bool_(r.active), hot: bool_(r.hot), sort: Number(r.sort) || 0, cvsOk: bool_(r.cvsOk),
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
           active: bool_(r.active), note: String(r.note || "") };
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
    settings: { shipFee: s.shipFee, shipFeeCvs: s.shipFeeCvs, freeShipOver: s.freeShipOver, lineUrl: s.lineUrl, notice: s.notice },
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
function quote_(items, codeStr, shipMethod) {
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
    lines.push({ id: p.id, name: p.name, qty: qty, price: p.price, unit: u, total: u * qty });
    subtotal += u * qty;
    tierSaving += (p.price - u) * qty;
  });
  let code = "", codeDiscount = 0, codeError = "";
  if (codeStr) {
    const c = rows_("codes").map(code_).find(x => x.code.toUpperCase() === String(codeStr).trim().toUpperCase());
    codeError = codeCheck_(c, subtotal);
    if (!codeError) {
      code = c.code;
      codeDiscount = c.type === "amount" ? Math.min(c.value, subtotal) : Math.round(subtotal * c.value / 100);
    }
  }
  const s = getSettings_();
  const cvs = shipMethod === SHIP_CVS;
  if (cvs) lines.forEach(l => { if (!prods[l.id].cvsOk) errors.push(l.name + " 僅限黑貓宅配"); });
  const after = subtotal - codeDiscount;
  const shipping = !lines.length || (s.freeShipOver > 0 && after >= s.freeShipOver) ? 0 : cvs ? s.shipFeeCvs : s.shipFee;
  return { lines: lines, subtotal: subtotal, tierSaving: tierSaving, code: code, codeDiscount: codeDiscount,
           codeError: codeError, shipping: shipping, total: after + shipping, errors: errors };
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
  if (c.shipMethod !== SHIP_HOME && c.shipMethod !== SHIP_CVS) return { ok: false, error: "請選擇寄送方式" };
  if (!c.address) return { ok: false, error: c.shipMethod === SHIP_CVS ? "請選擇 7-11 門市" : "請填寫收件地址" };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 冪等：同一個 clientId 只成立一張單（前端重送不會重複下單）
    const dup = req.clientId && rows_("orders").find(o => String(o.clientId) === String(req.clientId));
    if (dup) return { ok: true, orderNo: String(dup.orderNo), total: Number(dup.total) };
    const q = quote_(req.items, req.code, c.shipMethod);
    if (!q.lines.length) return { ok: false, error: "購物車是空的" };
    if (q.errors.length) return { ok: false, error: q.errors.join("；") };
    if (req.code && q.codeError) return { ok: false, error: q.codeError };
    const orderNo = "CP" + Utilities.formatDate(new Date(), "Asia/Taipei", "yyMMddHHmmss") + Math.floor(Math.random() * 90 + 10);
    upsert_("orders", "orderNo", {
      orderNo: orderNo, createdAt: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm"),
      name: c.name, phone: c.phone, line: c.line || "", shipMethod: c.shipMethod, address: c.address || "", note: c.note || "",
      items: JSON.stringify(q.lines), subtotal: q.subtotal, tierSaving: q.tierSaving, code: q.code, codeDiscount: q.codeDiscount,
      shipping: q.shipping, total: q.total, status: "新訂單", payStatus: "unpaid", clientId: req.clientId || "",
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
    return { ok: true, orderNo: orderNo, total: q.total };
  } finally {
    lock.releaseLock();
  }
}

/* ───────────── 後台登入 ───────────── */
function hash_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}
function setAdmin_(user, pass) {
  const salt = Utilities.getUuid(), p = PropertiesService.getScriptProperties();
  p.setProperties({ ADMIN_USER: user, ADMIN_SALT: salt, ADMIN_HASH: hash_(salt + ":" + pass) });
}
function login_(user, pass) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("loginFails") || 0);
  if (fails >= 8) return { ok: false, error: "嘗試次數過多，請 10 分鐘後再試" };
  const p = PropertiesService.getScriptProperties();
  user = String(user || "").normalize("NFKC").trim(); pass = String(pass || "").normalize("NFKC").trim(); // 全形「０１」也能登入
  const okUser = user === p.getProperty("ADMIN_USER");
  const okPass = hash_(p.getProperty("ADMIN_SALT") + ":" + pass) === p.getProperty("ADMIN_HASH");
  if (!okUser || !okPass) {
    cache.put("loginFails", String(fails + 1), 600);
    return { ok: false, error: "帳號或密碼錯誤" };
  }
  const token = Utilities.getUuid() + Utilities.getUuid();
  const props = PropertiesService.getScriptProperties(), now = Date.now();
  Object.keys(props.getProperties()).forEach(k => { if (k.indexOf("SESS_") === 0 && k.indexOf("SESS_REVOKED_") < 0 && Number(props.getProperty(k)) < now) props.deleteProperty(k); });
  props.setProperty("SESS_" + hash_(token), String(now + SESSION_DAYS * 86400000));
  // 指令碼屬性剛寫入時，下一個請求偶爾讀不到（10-31 實測：登入後第一個動作回 auth），所以同時放快取（最長 6 小時）
  cache.put("tok:" + token, "1", 21600);
  return { ok: true, token: token, isDefault: String(pass) === "01" };
}
function checkToken_(t) {
  if (!t) return false;
  if (CacheService.getScriptCache().get("tok:" + t) === "1" &&
      PropertiesService.getScriptProperties().getProperty("SESS_REVOKED_" + hash_(t)) !== "1") return true;
  const exp = Number(PropertiesService.getScriptProperties().getProperty("SESS_" + hash_(t)) || 0);
  return exp > Date.now();
}

/* ───────────── 後台動作 ───────────── */
const ADMIN = {
  admin_all: () => ({
    products: withSold_(rows_("products").map(product_)).sort((a, b) => a.sort - b.sort),
    videos: rows_("videos").map(video_).sort((a, b) => a.sort - b.sort),
    codes: rows_("codes").map(code_),
    settings: getSettings_(),
    user: PropertiesService.getScriptProperties().getProperty("ADMIN_USER"),
  }),
  admin_orders: () => ({
    orders: rows_("orders").map(o => ({
      orderNo: String(o.orderNo), createdAt: String(o.createdAt), name: String(o.name), phone: String(o.phone),
      line: String(o.line), shipMethod: String(o.shipMethod), address: String(o.address), note: String(o.note),
      items: json_(o.items, []), subtotal: Number(o.subtotal), tierSaving: Number(o.tierSaving), code: String(o.code),
      codeDiscount: Number(o.codeDiscount), shipping: Number(o.shipping), total: Number(o.total),
      status: String(o.status), payStatus: String(o.payStatus),
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
      updatedAt: new Date().toISOString(), cvsOk: p.cvsOk ? "TRUE" : "FALSE",
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
      limit: String(Number(c.limit) || 0), active: c.active ? "TRUE" : "FALSE", note: c.note || "" });
    if (c.renamedFrom && String(c.renamedFrom).toUpperCase() !== code) remove_("codes", "code", c.renamedFrom);
    return { code: code };
  },
  admin_deleteCode: r => { remove_("codes", "code", r.code); },
  admin_orderStatus: r => {
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
  admin_saveSettings: r => {
    const s = r.settings || {};
    ["shipFee", "shipFeeCvs", "freeShipOver", "lineUrl", "notice"].forEach(k => { if (s[k] !== undefined) setSetting_(k, s[k]); });
  },
  admin_changeLogin: r => {
    const p = PropertiesService.getScriptProperties();
    const nf = v => String(v || "").normalize("NFKC").trim(); // 跟登入一樣正規化，否則全形新密碼改完會登不進去
    r.oldPass = nf(r.oldPass); r.newUser = nf(r.newUser); r.newPass = nf(r.newPass);
    if (hash_(p.getProperty("ADMIN_SALT") + ":" + String(r.oldPass || "")) !== p.getProperty("ADMIN_HASH")) throw new Error("目前密碼錯誤");
    if (!r.newUser || String(r.newPass || "").length < 2) throw new Error("新密碼至少 2 碼");
    setAdmin_(String(r.newUser), String(r.newPass));
    // 改密碼後，其他裝置的登入全部失效，只保留目前這台
    const keep = "SESS_" + hash_(r.token);
    const all = p.getProperties();
    Object.keys(all).forEach(k => {
      if (k.indexOf("SESS_REVOKED_") === 0) { if (Number(all[k + "_AT"] || 0) < Date.now() - 86400000) { p.deleteProperty(k); p.deleteProperty(k + "_AT"); } return; }
      if (k.indexOf("SESS_") === 0 && k.indexOf("_AT") < 0 && k !== keep) {
        p.deleteProperty(k);
        p.setProperty("SESS_REVOKED_" + k.slice(5), "1"); p.setProperty("SESS_REVOKED_" + k.slice(5) + "_AT", String(Date.now()));
      }
    });
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
function storeReturn_(p) {
  const pick = keys => { for (const k in p) if (keys.indexOf(k.toLowerCase()) >= 0 && p[k]) return String(p[k]); return ""; };
  const store = { id: pick(["storeid", "cvsstoreid"]), name: pick(["storename", "cvsstorename"]), addr: pick(["storeaddress", "cvsaddress"]) };
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
