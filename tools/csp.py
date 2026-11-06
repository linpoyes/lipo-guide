# 依目前頁面內容產生 CSP（內容安全政策）meta：inline <script> 以 sha256 雜湊放行，不用 'unsafe-inline'。
# deploy.sh 每次部署都會跑，所以改了 inline 程式不必手動更新雜湊。
# 允許的外部來源＝實際用到的那幾個；新增外部服務時要加在這裡，否則會被瀏覽器擋。
import base64, hashlib, re, sys
COMMON = {
  "default-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],  # 版面大量 style 屬性；樣式無法執行程式，風險低
  "img-src": ["'self'", "data:", "https://lh3.googleusercontent.com", "https://i.ytimg.com", "https://drive.google.com"],
  "media-src": ["'self'", "https://drive.usercontent.google.com"],
  "connect-src": ["'self'", "https://script.google.com", "https://script.googleusercontent.com"],
  "frame-src": ["https://www.youtube.com", "https://drive.google.com"],
  "object-src": ["'none'"], "base-uri": ["'self'"], "form-action": ["'self'"],
}
for f in sys.argv[1:]:
    s = open(f).read()
    body = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>\n?', "", s)
    hashes = ["'sha256-%s'" % base64.b64encode(hashlib.sha256(m.encode()).digest()).decode()
              for m in re.findall(r"<script>(.*?)</script>", body, re.S)]
    pol = dict(COMMON, **{"script-src": ["'self'"] + hashes})
    meta = '<meta http-equiv="Content-Security-Policy" content="%s">' % "; ".join(k + " " + " ".join(v) for k, v in pol.items())
    body = body.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + meta, 1)
    open(f, "w").write(body)
    print(f, len(hashes), "inline scripts")
