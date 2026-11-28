#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""题库目录（data/catalog.js）字段引用统计。

只做只读扫描，不联网、不改文件。口径写在 PATTERNS 里，可逐条复核：
每个字段用「变量名 + 字段名」的正则匹配，所以统计的是显式访问，
不含解构、方括号取值（`p["pid"]`）这类写法；这类写法本轮全库为 0 处。

用法：python tests/problems/catalog_usage.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 只扫运行面：根 HTML、根 JS、data/*.js、skills/*.js；不扫 _archive/_work/_baseline/供应商文件
SCAN_GLOBS = ["*.html", "*.js", "data/*.js", "skills/*.js"]
SKIP_NAMES = {"supabase.js", "skillpack.js"}
SKIP_DIRS = {"_archive", "_baseline", "_work", "_test_auth", "artifacts", "node_modules", "dist", ".git"}

# 字段 -> (对象, 正则)。正则里变量名用常见命名，口径原样打印在报告里。
PATTERNS: dict[str, tuple[str, str]] = {
    "brand": ("目录", r"CATALOG\s*\.\s*brand"),
    "chapters": ("目录", r"\.\s*chapters\b"),
    "id": ("章", r"\bg\s*\.\s*id\b"),
    "name.chapter": ("章", r"\bg\s*\.\s*name\b"),
    "lessons": ("章", r"\.\s*lessons\b"),
    "no": ("课", r"\b(?:l|les)\s*\.\s*no\b"),
    "name.lesson": ("课", r"\b(?:l|les)\s*\.\s*name\b"),
    "kp": ("课", r"\.\s*kp\b"),
    "problems": ("课", r"\.\s*problems\b"),
    "pid": ("题", r"\bp\s*\.\s*pid\b"),
    "title": ("题", r"\bp\s*\.\s*title\b"),
    "kind": ("题", r"\bp\s*\.\s*kind\b"),
    "ac": ("题", r"\bp\s*\.\s*ac\b"),
    "sub": ("题", r"\bp\s*\.\s*sub\b"),
    "time": ("题", r"\bp\s*\.\s*time\b"),
    "mem": ("题", r"\bp\s*\.\s*mem\b"),
    "open": ("题", r"\bp\s*\.\s*open\b"),
}

STORAGE_PATTERNS = {
    "studypage.done（题库进度）": r"studypage\.done",
    "studypage.last（上次做题）": r"studypage\.last",
    "studypage.random.last（随机题）": r"studypage\.random\.last",
}


def iter_files() -> list[Path]:
    out: list[Path] = []
    for g in SCAN_GLOBS:
        for p in ROOT.glob(g):
            if p.is_dir() or p.name in SKIP_NAMES:
                continue
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            out.append(p)
    return sorted(set(out))


def scan(files: list[Path], pattern: str) -> list[tuple[str, int, str]]:
    rx = re.compile(pattern)
    hits: list[tuple[str, int, str]] = []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            n = len(rx.findall(line))
            if n:
                rel = f.relative_to(ROOT).as_posix()
                hits.extend([(rel, i, line.strip())] * n)
    return hits


def main() -> None:
    files = iter_files()
    print(f"扫描文件数 {len(files)}")
    print("文件清单：" + "、".join(f.relative_to(ROOT).as_posix() for f in files))
    print()
    print("字段 | 对象 | 口径正则 | 命中次数 | 涉及文件")
    print("-" * 100)
    zero: list[str] = []
    for field, (obj, pattern) in PATTERNS.items():
        hits = scan(files, pattern)
        where = sorted({h[0] for h in hits})
        if not hits:
            zero.append(f"{obj}.{field}")
        print(f"{field} | {obj} | {pattern} | {len(hits)} | {', '.join(where) if where else '—'}")
    print()
    print("零引用字段：" + ("、".join(zero) if zero else "无"))
    print()
    for field, (obj, pattern) in PATTERNS.items():
        hits = scan(files, pattern)
        if not hits:
            continue
        print(f"### {obj}.{field}（{len(hits)} 处）")
        for rel, line_no, code in hits:
            print(f"  {rel}:{line_no}: {code}")
        print()
    print("### 题库相关 localStorage 键")
    for label, pattern in STORAGE_PATTERNS.items():
        hits = scan(files, pattern)
        print(f"  {label}：{len(hits)} 处；文件 {', '.join(sorted({h[0] for h in hits})) or '—'}")
        for rel, line_no, code in hits:
            print(f"    {rel}:{line_no}: {code}")


if __name__ == "__main__":
    main()
