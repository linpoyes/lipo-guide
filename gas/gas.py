# Apps Script REST 小工具（不含任何金鑰；token 由 ~/.clasprc.json 的 refresh_token 現換）
# 用法：python3 gas/gas.py deploy "說明"   → push＋建版本＋更新固定部署
import json, os, sys, urllib.request, urllib.parse
SID = "1l19CVilQxBqdYnpo9etw7ZayS2WfZ0SRKrnewHgCVgnptIh_ucdOyN8q"
DID = "AKfycbxtUHvT661QSFsB8ACP0QSMq-8PCR9GIxFzXRFzArl4vswAy2YBd5ZbaSIrfGtcKls"
HERE = os.path.dirname(os.path.abspath(__file__))
def token():
    d = json.load(open(os.path.expanduser("~/.clasprc.json")))
    t = d["tokens"]["default"] if "tokens" in d else {**d["token"], "client_id": d["oauth2ClientSettings"]["clientId"], "client_secret": d["oauth2ClientSettings"]["clientSecret"]}
    body = urllib.parse.urlencode({"client_id": t["client_id"], "client_secret": t["client_secret"], "refresh_token": t["refresh_token"], "grant_type": "refresh_token"}).encode()
    return json.load(urllib.request.urlopen("https://oauth2.googleapis.com/token", body))["access_token"]
def call(method, path, data=None, tk=None):
    req = urllib.request.Request("https://script.googleapis.com/v1/" + path, method=method,
        data=None if data is None else json.dumps(data).encode(),
        headers={"Authorization": "Bearer " + tk, "Content-Type": "application/json"})
    try: return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e: print(e.read().decode()); raise
if __name__ == "__main__" and sys.argv[1:2] == ["deploy"]:
    tk = token()
    files = [{"name": "Code", "type": "SERVER_JS", "source": open(f"{HERE}/Code.gs").read()},
             {"name": "appsscript", "type": "JSON", "source": open(f"{HERE}/appsscript.json").read()}]
    call("PUT", f"projects/{SID}/content", {"files": files}, tk)
    v = call("POST", f"projects/{SID}/versions", {"description": sys.argv[2] if len(sys.argv) > 2 else "update"}, tk)["versionNumber"]
    call("PUT", f"projects/{SID}/deployments/{DID}", {"deploymentConfig": {"scriptId": SID, "versionNumber": v, "manifestFileName": "appsscript", "description": "shop"}}, tk)
    print("deployed version", v)
