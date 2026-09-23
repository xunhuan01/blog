#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""博客新文章 → 知乎风暗色长图 → 发焦羽 TG（给 cron 用的看门狗脚本）。

逻辑：
  1. 扫 D:\\myblog\\src\\content\\posts\\*.md（带 password 的加密文章直接跳过）
  2. 已在 state 里的 slug 跳过；再确认线上 https://waiwei.top/posts/<slug>/ 返回 200（没发布的不做）
  3. 生成图片到 D:\\作家系统\\知乎问答图输出\\自动\\<文章名>\\ ，用 send_tg 发 TG
  4. 记 state；有新增才输出摘要（没活干 stdout 为空 → cron 不打扰）

用法：
  python zhihu_cards_watch.py            # 正常跑（有新文章才出图）
  python zhihu_cards_watch.py --seed     # 把当前已上线的文章标记为"已处理"，不生成图
  python zhihu_cards_watch.py --force <slug>   # 忽略 state 强制重出一篇
"""
import contextlib, glob, io, json, os, sys, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zhihu_cards as zc
import send_tg as tg

POSTS = os.environ.get("ZHIHU_POSTS") or (r"D:\myblog\src\content\posts" if os.name == "nt"
                                          else "/root/blog-repo/src/content/posts")
OUTROOT = os.environ.get("ZHIHU_OUTROOT") or (r"D:\作家系统\知乎问答图输出\自动" if os.name == "nt"
                                              else "/root/作家系统/知乎问答图输出/自动")
REPO = os.environ.get("ZHIHU_REPO", "")          # 设了就每轮先 git pull（VPS 上必设）
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "zhihu_cards_state.json")
LIVE = "https://waiwei.top/posts/%s/"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def git_pull():
    """更新博客仓库（国内 VPS 走本机代理，proxy 从 ZHIHU_GIT_PROXY 读）。"""
    if not REPO or not os.path.isdir(os.path.join(REPO, ".git")):
        return ""
    import subprocess
    px = os.environ.get("ZHIHU_GIT_PROXY", "")
    cmd = ["git", "-C", REPO]
    if px:
        cmd += ["-c", "http.proxy=" + px]
    cmd += ["pull", "--ff-only", "-q"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        return "" if p.returncode == 0 else ("git pull 失败: " + (p.stderr or p.stdout)[:200])
    except Exception as e:
        return "git pull 异常: %r" % (e,)


def load_state():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except Exception:
        return {}


def save_state(s):
    json.dump(s, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def live_ok(slug):
    """线上是否已可访问（必须直连，博客测试禁走代理）。超时按"没上线"处理。"""
    import requests
    s = requests.Session()
    s.trust_env = False
    try:
        r = s.get(LIVE % slug, timeout=10, headers=UA)
        return r.status_code == 200
    except Exception:
        return False


def main():
    args = sys.argv[1:]
    seed = "--seed" in args
    force = args[args.index("--force") + 1] if "--force" in args else None
    pull_warn = git_pull()                        # VPS 上先更新博客仓库
    state = load_state()
    done, skipped_not_live, lines = [], [], []
    for path in sorted(glob.glob(os.path.join(POSTS, "*.md"))):
        meta, _ = zc.load_article(path)
        slug = (meta.get("slug") or "").strip()
        title = meta.get("title") or os.path.splitext(os.path.basename(path))[0]
        if not slug:
            continue
        if meta.get("password"):
            continue                                  # 加密文章不出图（会等于全文公开）
        if str(meta.get("draft", "")).lower() in ("true", "yes"):
            continue                                  # 草稿不做
        if slug in state and slug != force:
            continue
        if not seed and not live_ok(slug):
            skipped_not_live.append(title)
            continue
        if seed:
            state[slug] = {"seeded": True, "at": datetime.datetime.now().isoformat(timespec="seconds"),
                           "title": title}
            lines.append("SEED  %s" % title)
            continue
        outdir = os.path.join(OUTROOT, os.path.splitext(os.path.basename(path))[0])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            files = zc.build(path, outdir)
        log = buf.getvalue()
        if not files:
            lines.append("SKIP  %s（未生成）" % title)
            continue
        qtitle = ""
        for ln in log.splitlines():
            if ln.startswith("问题体标题:"):
                qtitle = ln.split(":", 1)[1].strip()
        sent = tg.send(files, caption=title)
        # send_tg.send 返回 0=全部成功 / 2=有失败；发失败就不记账，下一轮重试
        if sent != 0:
            lines.append("⚠️ TG 发送失败，未记账，下轮重试：%s" % title)
            tg.send_text("⚠️ 博客出图：TG 发送失败，会在下一轮重试\n《%s》" % title)
            continue
        state[slug] = {"pages": len(files), "dir": outdir, "qtitle": qtitle,
                       "at": datetime.datetime.now().isoformat(timespec="seconds"),
                       "title": title, "tg": "ok", "files": files}
        done.append((title, qtitle, len(files)))
        lines.append("出图并已发TG  %s → 《%s》%d 页" % (title, qtitle, len(files)))
    if lines:
        save_state(state)
    if not lines:
        return                                        # 没活干：stdout 留空
    if skipped_not_live and not done:
        return                                        # 只有未发布的新文：不打扰
    print("焦羽博客 → 知乎暗色图")
    if pull_warn:
        print("⚠️ " + pull_warn)
    for i, (title, qtitle, n) in enumerate(done, 1):
        print("%d. 《%s》%d 页（问题：%s）已发送到你的 Telegram" % (i, title, n, qtitle))
    if not done:
        print("\n".join(lines[:5]))


if __name__ == "__main__":
    main()
