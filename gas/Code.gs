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
  products: ["id", "name", "category", "price", "listPrice", "desc", "images", "tiers", "stock", "active", "hot", "sort", "updatedAt"],
  videos:   ["id", "title", "src", "poster", "productId", "active", "sort", "updatedAt"],
  codes:    ["code", "type", "value", "minSpend", "startAt", "endAt", "limit", "used", "active", "note"],
  orders:   ["orderNo", "createdAt", "name", "phone", "line", "shipMethod", "address", "note", "items", "subtotal", "tierSaving", "code", "codeDiscount", "shipping", "total", "status", "payStatus", "clientId"],
  settings: ["key", "value"],
};
// 試算表分頁的中文名稱（給使用者自己打開試算表時看得懂）
const TAB = { products: "商品", videos: "影片", codes: "折扣碼", orders: "訂單", settings: "設定" };
const DEFAULT_SETTINGS = { shipFee: 100, freeShipOver: 2000, lineUrl: "", notice: "" };
const SESSION_HOURS = 6;

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
  return out_({ ok: false, error: "unknown action" });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "格式錯誤" }); }
  try {
    const a = req.action;
    if (a === "quote") return out_({ ok: true, quote: quote_(req.items, req.code) });
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
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => o[c] = r[j]);
    return o;
  });
}
// 依主鍵寫入一列（有就覆蓋、沒有就新增）。只寫 SHEETS 定義的欄位，多送的欄位不會被靜靜丟掉以外的方式處理。
function upsert_(k, keyCol, obj) {
  const cols = SHEETS[k], sh = sheet_(k);
  const found = rows_(k).find(r => String(r[keyCol]) === String(obj[keyCol]));
  const vals = [cols.map(c => obj[c] === undefined ? (found ? found[c] : "") : obj[c])];
  if (found) sh.getRange(found._row, 1, 1, cols.length).setValues(vals);
  else sh.appendRow(vals[0]);
}
function remove_(k, keyCol, key) {
  const r = rows_(k).find(x => String(x[keyCol]) === String(key));
  if (r) sheet_(k).deleteRow(r._row);
}
function getSettings_() {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  rows_("settings").forEach(r => s[r.key] = r.value);
  s.shipFee = Number(s.shipFee) || 0;
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
    active: bool_(r.active), hot: bool_(r.hot), sort: Number(r.sort) || 0,
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
function catalog_() {
  const bySort = (a, b) => a.sort - b.sort;
  const s = getSettings_();
  return {
    ok: true,
    products: rows_("products").map(product_).filter(p => p.active).sort(bySort),
    videos: rows_("videos").map(video_).filter(v => v.active && v.src).sort(bySort),
    settings: { shipFee: s.shipFee, freeShipOver: s.freeShipOver, lineUrl: s.lineUrl, notice: s.notice },
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
function quote_(items, codeStr) {
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
  const after = subtotal - codeDiscount;
  const shipping = !lines.length || (s.freeShipOver > 0 && after >= s.freeShipOver) ? 0 : s.shipFee;
  return { lines: lines, subtotal: subtotal, tierSaving: tierSaving, code: code, codeDiscount: codeDiscount,
           codeError: codeError, shipping: shipping, total: after + shipping, errors: errors };
}

/* ───────────── 公開：送出訂單 ───────────── */
function placeOrder_(req) {
  const c = req.customer || {};
  if (!c.name || !c.phone) return { ok: false, error: "請填寫姓名與電話" };
  if (!c.shipMethod) return { ok: false, error: "請選擇取貨方式" };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 冪等：同一個 clientId 只成立一張單（前端重送不會重複下單）
    const dup = req.clientId && rows_("orders").find(o => String(o.clientId) === String(req.clientId));
    if (dup) return { ok: true, orderNo: String(dup.orderNo), total: Number(dup.total) };
    const q = quote_(req.items, req.code);
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
      if (l && r.stock !== "" && Number(r.stock) >= 0) sh.getRange(r._row, stockCol).setValue(String(Number(r.stock) - l.qty));
    });
    if (q.code) {
      const cr = rows_("codes").find(x => String(x.code) === q.code);
      if (cr) sheet_("codes").getRange(cr._row, SHEETS.codes.indexOf("used") + 1).setValue(String((Number(cr.used) || 0) + 1));
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
  const okUser = String(user || "") === p.getProperty("ADMIN_USER");
  const okPass = hash_(p.getProperty("ADMIN_SALT") + ":" + String(pass || "")) === p.getProperty("ADMIN_HASH");
  if (!okUser || !okPass) {
    cache.put("loginFails", String(fails + 1), 600);
    return { ok: false, error: "帳號或密碼錯誤" };
  }
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put("tok:" + token, "1", SESSION_HOURS * 3600);
  return { ok: true, token: token, isDefault: String(pass) === "01" };
}
function checkToken_(t) { return !!t && CacheService.getScriptCache().get("tok:" + t) === "1"; }

/* ───────────── 後台動作 ───────────── */
const ADMIN = {
  admin_all: () => ({
    products: rows_("products").map(product_).sort((a, b) => a.sort - b.sort),
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
      updatedAt: new Date().toISOString(),
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
    rows_("orders").forEach(o => { if (nos.indexOf(String(o.orderNo)) >= 0) sh.getRange(o._row, col).setValue(r.value); });
  },
  admin_saveSettings: r => {
    const s = r.settings || {};
    ["shipFee", "freeShipOver", "lineUrl", "notice"].forEach(k => { if (s[k] !== undefined) setSetting_(k, s[k]); });
  },
  admin_changeLogin: r => {
    const p = PropertiesService.getScriptProperties();
    if (hash_(p.getProperty("ADMIN_SALT") + ":" + String(r.oldPass || "")) !== p.getProperty("ADMIN_HASH")) throw new Error("目前密碼錯誤");
    if (!r.newUser || String(r.newPass || "").length < 4) throw new Error("新密碼至少 4 碼");
    setAdmin_(String(r.newUser), String(r.newPass));
  },
  // 上傳圖片／影片到雲端硬碟資料夾，設為「知道連結者可檢視」，回傳檔案 id
  admin_upload: r => {
    const bytes = Utilities.base64Decode(r.data);
    if (bytes.length > 40 * 1024 * 1024) throw new Error("檔案超過 40MB");
    const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty("MEDIA_FOLDER"));
    const f = folder.createFile(Utilities.newBlob(bytes, r.mime || "application/octet-stream", r.name || "upload"));
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return { fileId: f.getId() };
  },
};
