// 賣場前台 shop.html 與後台 admin.html 共用：後端呼叫、計價、媒體網址。
// 計價邏輯必須跟 gas/Code.gs 的 unitPrice_／quote_ 一致——前端只是預覽，成交金額一律以後端為準。

const API = "https://script.google.com/macros/s/AKfycbxtUHvT661QSFsB8ACP0QSMq-8PCR9GIxFzXRFzArl4vswAy2YBd5ZbaSIrfGtcKls/exec";

const CATEGORIES = [
  ["battery", "鋰電池"], ["car", "遙控車"], ["parts", "改裝配件"], ["wheel", "輪胎輪框"], ["motor", "馬達電變"],
  ["radio", "遙控器"], ["tool", "工具周邊"], ["body", "車殼外觀"], ["charger", "充電設備"],
];
const catName = id => (CATEGORIES.find(c => c[0] === id) || [, "其他"])[1];

// Apps Script /exec 會間歇回 404 或 HTML（冷啟動、併發），所以：
// 一定要解析得出 JSON 才算成功；tries > 1 只給冪等的動作用。
async function api(body, {tries = 1, timeout = 60000} = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
      const res = body
        ? await fetch(API, {method: "POST", body: JSON.stringify(body), headers: {"Content-Type": "text/plain;charset=utf-8"}, signal: ctl.signal})
        : await fetch(API + "?action=catalog&_=" + Date.now(), {signal: ctl.signal});
      clearTimeout(t);
      const data = JSON.parse(await res.text());
      if (data.ok === false && data.error) { const e = new Error(data.error); e.server = true; throw e; }
      return data;
    } catch (e) {
      last = e;
      if (e.server) throw e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(last && last.name === "AbortError" ? "連線逾時，請再試一次" : "連線失敗，請再試一次");
}

const money = n => "$" + Math.round(n).toLocaleString("en-US");

function unitPrice(p, qty) {
  let u = p.price;
  for (const t of p.tiers || []) if (qty >= t.qty && t.price > 0 && t.price < u) u = t.price;
  return u;
}

// 折數顯示：單價 / 原價 → 9 折、85 折
function zhe(part, whole) {
  if (!whole || part >= whole) return "";
  const r = Math.round(part / whole * 100);
  return (r % 10 === 0 ? r / 10 : r) + " 折";
}

// 媒體：後台上傳存 "drive:<fileId>"，也可直接貼網址（mp4／圖片／YouTube）
function imgUrl(src, w = 800) {
  if (!src) return "";
  if (src.startsWith("drive:")) return `https://lh3.googleusercontent.com/d/${src.slice(6)}=w${w}`;
  return src;
}
function videoInfo(src) {
  if (!src) return null;
  const yt = src.match(/(?:youtube\.com\/(?:shorts\/|watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return {kind: "youtube", id: yt[1], thumb: `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`};
  if (src.startsWith("drive:")) {
    const id = src.slice(6);
    return {kind: "drive", id, url: `https://drive.google.com/file/d/${id}/preview`, thumb: `https://lh3.googleusercontent.com/d/${id}=w600`};
  }
  return {kind: "file", url: src};
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

// 按鈕在等待時變灰、擋連點（使用者的固定要求）
async function busy(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true; btn.setAttribute("aria-busy", "true");
  try { return await fn(); } finally { btn.disabled = false; btn.removeAttribute("aria-busy"); }
}
