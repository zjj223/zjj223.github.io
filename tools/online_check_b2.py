"""B2 线上巡检：核心页面 200 + shared/css/tests 新文件 200 + 内容首行核对。

用法：python tools/online_check_b2.py [releaseId]
产物：_baseline/<releaseId>/online_check.json
"""
import json
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(r"D:\上课游戏")
BASE = "https://zjj223.github.io/"
RID = sys.argv[1] if len(sys.argv) > 1 else time.strftime("R%Y%m%d-%H%M%S")

PAGES = ["index.html?game=1", "首页.html", "学习台.html", "练习题库.html", "排行榜.html", "预览_DevC布局.html"]

NEW_FILES = [
    "shared/index.js",
    "shared/contracts.js",
    "shared/storage-keys.js",
    "shared/storage.js",
    "shared/bus.js",
    "shared/routes.js",
    "shared/config.js",
    "shared/auth-session.js",
    "shared/utils.js",
    "css/tokens.css",
    "tests/contract/run.js",
    "tools/smoke_shared.py",
]


def url_of(rel: str) -> str:
    parts = rel.split("/")
    return BASE + "/".join(quote(p) for p in parts)


def fetch(rel: str) -> dict:
    u = url_of(rel.split("?")[0]) + ("?" + rel.split("?", 1)[1] if "?" in rel else "")
    rec = {"path": rel, "url": u}
    try:
        r = requests.get(u, timeout=25, headers={"Cache-Control": "no-cache"})
        rec["status"] = r.status_code
        rec["bytes"] = len(r.content)
        rec["firstLine"] = r.text.split("\n", 1)[0][:120] if r.text else ""
    except Exception as exc:
        rec["status"] = 0
        rec["error"] = f"{exc.__class__.__name__}: {exc}"
    return rec


def main() -> int:
    out_dir = ROOT / "_baseline" / RID
    out_dir.mkdir(parents=True, exist_ok=True)
    results = {"releaseId": RID, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"), "pages": [], "newFiles": []}

    print("PAGES")
    for p in PAGES:
        rec = fetch(p)
        results["pages"].append(rec)
        print(f"  {rec.get('status')}  {rec.get('bytes', 0):>7} B  {p}")

    print("NEW FILES")
    for f in NEW_FILES:
        rec = fetch(f)
        results["newFiles"].append(rec)
        print(f"  {rec.get('status')}  {rec.get('bytes', 0):>7} B  {f}  | {rec.get('firstLine', '')[:60]}")

    pages_bad = [p for p in results["pages"] if p.get("status") != 200]
    files_bad = [f for f in results["newFiles"] if f.get("status") != 200]
    results["summary"] = {
        "pagesOk": len(PAGES) - len(pages_bad),
        "pagesTotal": len(PAGES),
        "filesOk": len(NEW_FILES) - len(files_bad),
        "filesTotal": len(NEW_FILES),
        "pagesBad": [p["path"] for p in pages_bad],
        "filesBad": [f["path"] for f in files_bad],
    }
    (out_dir / "online_check.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nSUMMARY", json.dumps(results["summary"], ensure_ascii=False))
    return 0 if not pages_bad and not files_bad else 1


if __name__ == "__main__":
    sys.exit(main())
