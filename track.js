// 流量追蹤（2026-11-08）：shop.html／index.html 載入，事件批次送到 Apps Script（action:"track"），後台「儀表板」彙總。
// 不收個資：vid＝這台瀏覽器的隨機碼、sid＝工作階段（30 分鐘沒動作換新）。自動化瀏覽器（截圖測試、爬蟲）不送。
(() => {
  const noop = () => {};
  window.cpTrack = noop;
  if (navigator.webdriver || /bot|crawl|spider|preview/i.test(navigator.userAgent)) return;
  try { if (localStorage.getItem("cp-notrack")) return; } catch (e) {} // 登入過後台的裝置＝自己人，不算流量
  const API = "https://script.google.com/macros/s/AKfycbxtUHvT661QSFsB8ACP0QSMq-8PCR9GIxFzXRFzArl4vswAy2YBd5ZbaSIrfGtcKls/exec";
  const rnd = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const get = (st, k) => { try { return st.getItem(k); } catch (e) { return null; } };
  const set = (st, k, v) => { try { st.setItem(k, v); } catch (e) {} };
  let vid = get(localStorage, "cp-vid"); if (!vid) { vid = rnd(); set(localStorage, "cp-vid", vid); }
  const last = Number(get(localStorage, "cp-sid-at")) || 0;
  let sid = get(localStorage, "cp-sid");
  if (!sid || Date.now() - last > 30 * 60000) { sid = rnd(); set(localStorage, "cp-sid", sid); }
  // 來源：utm_source 優先；其次 App 內建瀏覽器；再來看 referrer 網域
  const ua = navigator.userAgent, u = new URLSearchParams(location.search);
  let ref = ""; try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch (e) {}
  if (ref === location.hostname) ref = "";
  const src = u.get("utm_source") || (/\bLine\//.test(ua) ? "LINE" : /FBAN|FBAV|FB_IAB/.test(ua) ? "Facebook" : /Instagram/.test(ua) ? "Instagram" : /Threads/.test(ua) ? "Threads" :
    /line\.me|lin\.ee/.test(ref) ? "LINE" : /facebook|fb\.com/.test(ref) ? "Facebook" : /instagram/.test(ref) ? "Instagram" : /google\./.test(ref) ? "Google" :
    /youtube|youtu\.be/.test(ref) ? "YouTube" : /threads/.test(ref) ? "Threads" : /bing|yahoo|duckduckgo/.test(ref) ? "搜尋引擎" : ref ? "其他網站" : "直接造訪");
  const dev = /iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "平板" : /Mobi|Android|iPhone/i.test(ua) ? "手機" : "電腦";
  const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : "其他";
  const page = location.pathname.split("/").pop() || "index.html";
  let q = [], timer = null;
  function flush() {
    clearTimeout(timer); timer = null;
    if (!q.length) return;
    const body = JSON.stringify({action: "track", vid, sid, src, ref, dev, os, sent: Date.now(), ev: q.splice(0, 40)});
    let ok = false;
    try { ok = navigator.sendBeacon(API, new Blob([body], {type: "text/plain;charset=utf-8"})); } catch (e) {}
    if (!ok) fetch(API, {method: "POST", body, keepalive: true, headers: {"Content-Type": "text/plain;charset=utf-8"}}).catch(noop);
    if (q.length) flush();
  }
  window.cpTrack = (t, o) => {
    set(localStorage, "cp-sid-at", String(Date.now()));
    q.push(Object.assign({t, page, at: Date.now()}, o || {}));
    if (!timer) timer = setTimeout(flush, 4000);
  };
  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  addEventListener("pagehide", flush);
  cpTrack("view");
})();
