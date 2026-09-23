#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把生成的图片按顺序发到焦羽 Telegram（用 document 发，避免 Telegram 压缩掉细节）。

用法：python send_tg.py 文件或目录 [更多文件...]
环境：TELEGRAM_BOT_TOKEN 从 hermes .env 读；代理 127.0.0.1:7897（国内必走）。
"""
import glob, os, re, sys, time
import requests

ENV = os.environ.get("TELEGRAM_ENV_FILE") or (
    os.path.join(os.path.expanduser("~"), "AppData", "Local", "hermes", ".env") if os.name == "nt"
    else os.path.expanduser("~/.hermes/.env"))
CHAT_ID = os.environ.get("TG_CHAT_ID", "1235290208")
_PX = os.environ.get("TELEGRAM_PROXY", "http://127.0.0.1:7897")
PROXIES = {"http": _PX, "https": _PX}


def token():
    tk = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if tk:
        return tk
    d = open(ENV, encoding="utf-8", errors="ignore").read()
    m = re.search(r"TELEGRAM_BOT_TOKEN=(.+?)(?:\n|$)", d)
    return m.group(1).strip().strip('"').strip("'") if m else ""


def collect(args):
    out = []
    for a in args:
        a = a.replace("/", os.sep) if os.name == "nt" else a
        if os.path.isdir(a):
            out += sorted(glob.glob(os.path.join(a, "*.png")))
        else:
            out.append(a)
    return out


def send_text(text):
    """发一条纯文字消息（用于失败告警）。"""
    tk = token()
    if not tk:
        return False
    try:
        r = requests.post("https://api.telegram.org/bot%s/sendMessage" % tk,
                          data={"chat_id": CHAT_ID, "text": text}, proxies=PROXIES, timeout=60)
        return bool(r.json().get("ok"))
    except Exception:
        return False


def send(files, caption_prefix=""):
    tk = token()
    if not tk:
        print("ERROR: 没读到 TELEGRAM_BOT_TOKEN"); return 1
    ok = 0
    total = len(files)
    for i, f in enumerate(files, 1):
        f = os.path.abspath(f)
        url = "https://api.telegram.org/bot%s/sendDocument" % tk
        cap = "%s（%d/%d）" % (caption_prefix, i, total) if caption_prefix else ""
        try:
            with open(f, "rb") as fh:
                r = requests.post(url, data={"chat_id": CHAT_ID, "caption": cap},
                                  files={"document": (os.path.basename(f), fh, "image/png")},
                                  proxies=PROXIES, timeout=180)
            j = r.json()
            print(("OK  " if j.get("ok") else "FAIL"), os.path.basename(f), j.get("description", ""))
            if j.get("ok"):
                ok += 1
            else:
                break
        except Exception as e:
            print("ERR ", os.path.basename(f), repr(e)); break
        time.sleep(1.5)          # 防 TG 限流（约 20 条/分钟）
    print("已发 %d/%d" % (ok, total))
    return 0 if ok == total else 2


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    cap = ""
    for a in sys.argv[1:]:
        if a.startswith("--caption="):
            cap = a.split("=", 1)[1]
    send(collect(args), cap)
