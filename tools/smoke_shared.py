"""B2 浏览器冒烟：按页面加载顺序引入 shared 层，检查 window.LK 字段与 console 错误。

用法：python tools/smoke_shared.py
产物：_work/b2/shared_smoke.html（临时页面，禁止上传）、_work/b2/shared_smoke.json
"""
import json
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(r"D:\上课游戏")
WORK = ROOT / "_work" / "b2"
HARNESS = WORK / "shared_smoke.html"

ORDER = [
    "shared/index.js",
    "shared/contracts.js",
    "shared/storage-keys.js",
    "shared/utils.js",
    "shared/storage.js",
    "shared/bus.js",
    "shared/routes.js",
    "shared/config.js",
    "shared/auth-session.js",
]

JS_CHECK = """() => {
  const LK = window.LK || {};
  const fields = ["version","schemaVersion","contracts","storageKeys","utils","storage","bus","routes","config","auth"];
  const missing = fields.filter(f => !LK[f]);
  const out = { version: LK.version, fields: fields.length, missing, detail: {} };
  try { out.detail.routes = LK.routes.all().length; } catch (e) { out.detail.routes = "ERR:" + e.message; }
  try { out.detail.tokensVar = "n/a"; } catch (e) {}
  try { out.detail.eventCount = Object.keys(LK.contracts.events).length; } catch (e) { out.detail.eventCount = "ERR:" + e.message; }
  try { out.detail.routeUrl = LK.routes.url("game"); } catch (e) { out.detail.routeUrl = "ERR:" + e.message; }
  try { out.detail.escOk = LK.utils.esc("<a>") === "&lt;a&gt;"; } catch (e) { out.detail.escOk = false; }
  try { out.detail.loggedIn = LK.auth.isLoggedIn(); } catch (e) { out.detail.loggedIn = "ERR:" + e.message; }
  return out;
}"""


def main() -> int:
    WORK.mkdir(parents=True, exist_ok=True)
    links = "\n".join(
        '  <script src="../../%s"></script>' % rel for rel in ORDER
    )
    HARNESS.write_text(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        "<title>B2 shared smoke</title></head><body>\n" + links + "\n</body></html>",
        encoding="utf-8",
    )

    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_context(viewport={"width": 1200, "height": 800}).new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
        url = "file:///D:/" + urllib.parse.quote("上课游戏") + "/" + \
              urllib.parse.quote("_work/b2/shared_smoke.html")
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
        except Exception as exc:
            print("goto:", exc.__class__.__name__)
        page.wait_for_timeout(1200)
        data = page.evaluate(JS_CHECK)
        browser.close()

    data["consoleErrors"] = errors
    (WORK / "shared_smoke.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(data, ensure_ascii=False, indent=1))
    return 0 if not data["missing"] and not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
