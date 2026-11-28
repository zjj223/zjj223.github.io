"""生成 B2 批次的变更集 JSON（写入 _work/b2/，不上传）。

用法：python tools/gen_b2_changeset.py <sharedIndexBaseSha>
"""
import json
import sys
from pathlib import Path

ROOT = Path(r"D:\上课游戏")
OUT = ROOT / "_work" / "b2"

CREATE_SHARED = [
    "shared/contracts.js",
    "shared/storage-keys.js",
    "shared/storage.js",
    "shared/bus.js",
    "shared/routes.js",
    "shared/config.js",
    "shared/auth-session.js",
    "shared/utils.js",
    "tests/contract/run.js",
    "tests/contract/contracts.test.js",
    "tests/contract/storage-keys.test.js",
    "tests/contract/bus.test.js",
    "tools/smoke_shared.py",
]


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else ""
    if not base:
        print("缺少 shared/index.js 的 baseSha")
        return 2
    OUT.mkdir(parents=True, exist_ok=True)

    shared = {
        "changeId": "B2-shared-01",
        "owner": "architect",
        "baseRelease": "R20261128-B1-0940",
        "files": [{"path": "shared/index.js", "action": "update", "baseSha": base}]
        + [{"path": p, "action": "create"} for p in CREATE_SHARED],
        "verify": ["node --check <每个 js>", "node tests/contract/run.js", "python tools/smoke_shared.py"],
        "summary": "B2 共享层：契约/键名/存储/总线/路由/配置/只读会话/纯函数 + 契约测试 + tokens 变量层",
    }
    tokens = {
        "changeId": "B2-tokens-01",
        "owner": "ui",
        "baseRelease": "R20261128-B1-0940",
        "files": [{"path": "css/tokens.css", "action": "create"}],
        "verify": ["node tests/contract/run.js 中含 tokens 断言"],
        "summary": "B2 变量层骨架：--lk-* 变量，仅定义不覆盖既有规则（架构师代建，后续归 ui）",
    }
    (OUT / "B2-shared-01.json").write_text(json.dumps(shared, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "B2-tokens-01.json").write_text(json.dumps(tokens, ensure_ascii=False, indent=1), encoding="utf-8")
    print("written:", OUT / "B2-shared-01.json", len(shared["files"]), "files")
    print("written:", OUT / "B2-tokens-01.json", len(tokens["files"]), "files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
