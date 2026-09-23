#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""博客文章 -> 知乎 App 深色风长图卡片（多页）。

规格自 2026-09-23 用户样张（孙宇晨_A暗色）逐像素反推，并按三轮反馈修订：
  画布宽 1600；左边距 72 / 右边距 83（列宽 1445）；背景 #1A1A1A
  标题 48px 粗 #F0F0F0（y=72，每页都出现，模拟知乎顶部问题条）
  仅第 1 页额外露：圆头像 90px + 「焦羽」+ 简介「博客 👉 waiwei.top」+ 右上分享图标
                + 互动行「N 人赞同了该回答 › 🎧 M 人听过」+ 胶囊「内容包含虚构创作 ∨」
  第 2 页起只留「问题标题 + 正文」（模拟页面往上翻，署名/互动/胶囊都不露）
  正文 33px #D1D5DB，行距 58，段距 +20；正文起 y=503（首页）/ y=180（续页）
  页底 = 正文最后一行墨迹底 + 40（页脚「转载于」/页码/分隔线/底部操作栏已全部去掉）
  分页按页高目标 2900 反推页数（2000~3000 字约 3 页），段落不跨页拆
  标题默认调模型生成"宽泛的知乎提问"（如「如何评价孙宇晨？」），失败回退「如何评价<主体>？」

用法：
  python zhihu_cards.py <文章md> [--out 目录] [--qtitle 标题] [--avatar 图] [--no-ai]
"""
import argparse, hashlib, math, os, random, re
from PIL import Image, ImageDraw, ImageFont

W = 1600
ML, MR = 72, 83
COL = W - ML - MR
BG = (26, 26, 26)
C_TITLE = (240, 240, 240)
C_WHITE = (255, 255, 255)
C_SIGN = (133, 144, 166)
C_ENGAGE = (123, 136, 155)
C_BLUE = (0, 132, 255)
C_CHIP_TXT = (76, 154, 255)
C_CHIP_BG = (23, 34, 52)
C_BODY = (209, 213, 219)
C_FOOT = (154, 154, 154)
C_LINE = (38, 38, 38)

S_TITLE, S_AUTHOR, S_SIGN, S_ENGAGE, S_CHIP = 48, 30, 22, 24, 26
S_BODY, LH, PGAP, S_FOOT, S_BAR = 33, 58, 20, 26, 26
S_NUM = 24
TITLE_Y, TITLE_LH = 72, 63
AUTHOR_Y, SIGN_Y, ENGAGE_Y, CHIP_Y = 176, 232, 304, 392
BODY_TOP_P1 = 503          # 首页正文起点（标题+署名+互动+胶囊之下）
BODY_TOP_N = 180           # 续页正文起点（上方只有问题标题）
FOOT_GAP, TAIL_P1, TAIL_N = 0, 120, 120
BOT_PAD = 120               # 正文最后一行的墨迹底 + 120 = 页底（页脚/页码/底栏已全去掉，底部留白舒服些）
H_TARGET = 2900            # 页高目标，用来反推该分几页
SITE = "waiwei.top"

FONT_DIR = os.environ.get("ZHIHU_FONT_DIR") or (r"C:\Windows\Fonts" if os.name == "nt" else "/root/.fonts")
FDIR = FONT_DIR
F_REG = os.path.join(FDIR, "msyh.ttc")
F_BOLD = os.path.join(FDIR, "msyhbd.ttc")
F_EMOJI = os.path.join(FDIR, "seguiemj.ttf")
_D = os.path.dirname(os.path.abspath(__file__))
ASSETS = next((p for p in (os.environ.get("ZHIHU_ASSETS"), os.path.join(_D, "assets"),
                           r"D:\作家系统\知乎问答图输出\assets",
                           "/root/作家系统/知乎问答图输出/assets") if p and os.path.isdir(p)),
              os.path.join(_D, "assets"))
AVATAR = os.path.join(ASSETS, "avatar.png")
WATERMARK = os.path.join(ASSETS, "watermark.png")
WM_H = 300           # 水印高度（像素，可调）
WM_ALPHA = 0.5       # 水印透明度
WM_XR = 0.72         # 水印横向中心（占画布宽比例，0.5=正中，>0.5 偏右）
AV_D = 90            # 署名栏头像直径（照样张）
AV_D_BAR = 48        # 底栏小头像
SHOW_V = False       # 绿色认证标：用户说"蓝V不用加"，留开关
AI_MODEL = "deepseek/deepseek-v4-flash-fast"   # v4-flash/v4.1-flash 是推理模型，content 常为空，用 -fast
_cache, _avatar_cache = {}, {}


def font(size, bold=False):
    k = (size, bold)
    if k not in _cache:
        _cache[k] = ImageFont.truetype(F_BOLD if bold else F_REG, size)
    return _cache[k]


def _emoji(size=22):
    if (F_EMOJI, size) not in _cache:
        try:
            _cache[(F_EMOJI, size)] = ImageFont.truetype(F_EMOJI, size)
        except Exception:
            _cache[(F_EMOJI, size)] = None
    return _cache[(F_EMOJI, size)]


def _is_emoji(ch):
    """只判真 emoji（CJK 汉字也 >0x2500，不能拿码位大小当判据）。"""
    cp = ord(ch)
    return (0x1F000 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF or
            0x2B00 <= cp <= 0x2BFF or 0x2190 <= cp <= 0x21FF or cp == 0xFE0F or cp == 0x20E3)


def draw_mixed(d, xy, parts, size=24):
    """parts = [(text, color, bold)]；emoji 走 Segoe UI Emoji，缺字体就跳过不留豆腐块。"""
    x, y = xy
    for text, color, bold in parts:
        f = font(size, bold)
        buf = ""
        for ch in text:
            if _is_emoji(ch):
                if buf:
                    d.text((x, y), buf, font=f, fill=color); x += f.getlength(buf); buf = ""
                ef = _emoji(int(size * 1.15))
                if ef:
                    try:
                        d.text((x, y), ch, font=ef, fill=color, embedded_color=True)
                        x += ef.getlength(ch) + 2
                    except Exception:
                        pass
            else:
                buf += ch
        if buf:
            d.text((x, y), buf, font=f, fill=color); x += f.getlength(buf)
    return x, y


def avatar_circle(d, xy, d_px, path=None):
    """把头像裁圆贴到 (xy)。"""
    path = path or AVATAR
    key = (path, d_px)
    if key not in _avatar_cache:
        im = Image.open(path).convert("RGBA")
        s = min(im.size)
        im = im.crop(((im.width - s) // 2, (im.height - s) // 2,
                      (im.width + s) // 2, (im.height + s) // 2)).resize((d_px * 4, d_px * 4), Image.LANCZOS)
        mask = Image.new("L", im.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, im.size[0] - 1, im.size[1] - 1), fill=255)
        im.putalpha(mask)
        _avatar_cache[key] = im.resize((d_px, d_px), Image.LANCZOS)
    d._image.paste(_avatar_cache[key], (int(xy[0]), int(xy[1])), _avatar_cache[key])


def load_watermark(path=None, target_h=WM_H, alpha=WM_ALPHA):
    """印章水印：黑底抠掉（用红通道当覆盖度），缩到 target_h 高，整体 alpha 乘 alpha。"""
    path = path or WATERMARK
    key = ("wm", path, target_h, alpha)
    if key in _avatar_cache:
        return _avatar_cache[key]
    im = Image.open(path).convert("RGB")
    r = im.split()[0]
    box = r.point(lambda v: 255 if v > 25 else 0).getbbox()
    if box:
        im = im.crop(box); r = r.crop(box)
    w = max(1, int(round(im.width * target_h / im.height)))
    im = im.resize((w, target_h), Image.LANCZOS)
    mask = r.resize((w, target_h), Image.LANCZOS).point(lambda v: int(v * alpha))
    im = im.convert("RGBA"); im.putalpha(mask)
    _avatar_cache[key] = im
    return im


def paste_watermark(im, top_y, bottom_y, path=None):
    """水印贴在 [top_y, bottom_y] 的正中偏右。"""
    try:
        wm = load_watermark(path)
    except FileNotFoundError:
        print("  (水印文件不存在，跳过)", WATERMARK); return
    x = int(W * WM_XR) - wm.width // 2
    y = int((top_y + bottom_y) / 2) - wm.height // 2
    im.paste(wm, (x, y), wm)


def _v_badge(d, xy, r=13):
    x, y = xy
    d.ellipse([x, y, x + 2 * r, y + 2 * r], fill=(16, 185, 129))
    d.line([(x + 7, y + r), (x + 11, y + r + 5), (x + 18, y + 6)], fill=(255, 255, 255), width=3)


def _share_icon(d, right_x, y, color=C_SIGN, size=34):
    d.rounded_rectangle([right_x - size, y, right_x, y + size - 12], radius=4, outline=color, width=2)
    cx = right_x - size // 2
    d.line([(cx, y + size - 16), (cx, y + 2)], fill=color, width=2)
    d.line([(cx - 7, y + 9), (cx, y + 2), (cx + 7, y + 9)], fill=color, width=2)


# ---- 底栏（2026-09-23 定稿：无头像；右侧＝赞同/反对（蓝色实心＋浅蓝块）+ 评论 + 收藏 灰色实心图标） ----
C_ICON = (232, 232, 232)
C_NUM = (154, 154, 154)
C_VOTE = (30, 128, 255)      # 知乎蓝 #1E80FF
C_VOTE_BG = (23, 34, 52)     # 浅蓝块在暗色下的等价物（与胶囊同色）
C_MUTE = (133, 144, 166)     # #8590A6


def _tri_solid(d, cx, cy, up=True, w=10, h=8, color=C_VOTE):
    s = -1 if up else 1
    d.polygon([(cx - w, cy + s * -h), (cx + w, cy + s * -h), (cx, cy + s * h)], fill=color)


def _star_solid(d, cx, cy, ro=11, ri=4.6, color=C_MUTE):
    import math as _m
    pts = []
    for i in range(10):
        ang = -_m.pi / 2 + i * _m.pi / 5
        rr = ro if i % 2 == 0 else ri
        pts.append((cx + rr * _m.cos(ang), cy + rr * _m.sin(ang)))
    d.polygon(pts, fill=color)


def _bubble_solid(d, cx, cy, w=11, h=9, color=C_MUTE):
    d.rounded_rectangle([cx - w, cy - h, cx + w, cy + h - 3], radius=4, fill=color)
    d.polygon([(cx - 5, cy + h - 4), (cx + 2, cy + h - 4), (cx - 6, cy + h + 4)], fill=color)


def bottom_bar(d, eng, author, avatar, bar_y):
    """底栏：左＝用户名（无头像）；右＝赞同(蓝实心▲+浅蓝块)、反对(▽)、评论(气泡)、收藏(★)。"""
    up, fav, com, hear = eng
    d.text((40, bar_y + 28), author, font=font(S_BAR), fill=C_WHITE)
    cy = bar_y + 41
    f = font(S_BAR)
    x = 1556
    # 收藏
    t = f"{fav:,}"
    w = 22 + 9 + f.getlength(t)
    x -= w
    _star_solid(d, x + 11, cy)
    d.text((x + 31, cy - 17), t, font=f, fill=C_MUTE)
    # 评论
    x -= 28
    t = f"{com} 条评论"
    w = 22 + 9 + f.getlength(t)
    x -= w
    _bubble_solid(d, x + 11, cy)
    d.text((x + 31, cy - 17), t, font=f, fill=C_MUTE)
    # 反对（小蓝块）
    x -= 24
    x -= 44
    d.rounded_rectangle([x, cy - 20, x + 44, cy + 20], radius=8, fill=C_VOTE_BG)
    _tri_solid(d, x + 22, cy, up=False)
    # 赞同（蓝块 + 文字）
    t = f"赞同 {up:,}"
    w = 12 + 20 + 10 + f.getlength(t) + 14
    x -= 8 + w
    d.rounded_rectangle([x, cy - 20, x + w, cy + 20], radius=8, fill=C_VOTE_BG)
    _tri_solid(d, x + 22, cy, up=True)
    d.text((x + 42, cy - 17), t, font=f, fill=C_VOTE)


def strip_md(s):
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"__(.+?)__", r"\1", s)
    s = re.sub(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)", r"\1", s)
    s = re.sub(r"^\s{0,3}#{1,6}\s*", "", s)
    s = re.sub(r"^\s{0,3}>\s?", "", s)
    s = re.sub(r"^\s{0,3}[-*+]\s+", "", s)
    return s.strip()


def load_article(path):
    raw = open(path, encoding="utf-8").read()
    meta, body = {}, raw
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", raw, re.S)
    if m:
        head, body = m.group(1), m.group(2)
        for line in head.split("\n"):
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
    paras = [strip_md(p).replace("\n", "") for p in re.split(r"\n\s*\n", body)]
    return meta, [p for p in paras if p.strip()]


def wrap(text, f, maxw):
    lines, cur = [], ""
    for ch in text:
        if f.getlength(cur + ch) <= maxw:
            cur += ch
        else:
            lines.append(cur); cur = ch
    if cur:
        lines.append(cur)
    return lines or [""]


def fake_engagement(slug):
    r = random.Random(hashlib.md5(slug.encode("utf-8")).hexdigest())
    up = r.randint(1000, 2000)
    return up, int(up * r.uniform(0.45, 0.75)), r.randint(20, 99), r.randint(10, 99)


# ---------------- 知乎问题体标题（调模型，失败回退） ----------------
def _env_key(name):
    v = os.environ.get(name, "").strip()
    if v:
        return v
    p = os.environ.get("HERMES_ENV_FILE") or (
        r"C:\Users\Administrator\AppData\Local\hermes\.env" if os.name == "nt"
        else os.path.expanduser("~/.hermes/.env"))
    try:
        for line in open(p, encoding="utf-8", errors="ignore"):
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        return ""
    return ""


def make_qtitle(title, tags, first_para, model=AI_MODEL):
    """宽泛的知乎提问标题：只写主体对象，绝不把文章观点/结论/比喻写进去。"""
    import requests
    ask = ("下面是一篇中文文章的信息。请为它生成一个知乎风格的**宽泛**提问标题。\n"
           "要求：①格式类似「如何评价XXX？」「如何客观评价XXX？」；"
           "②主体对象必须是名词性的人 / 事 / 物 / 行业 / 现象（如「如何评价孙宇晨？」「如何评价皮条客这一行？」)；"
           "③绝不把文章的观点、结论、比喻、副标题写进标题（例如文章观点是「做自己的上帝」，标题里就不能出现这个词），"
           "也不要出现第一人称「我/我的」，不要照抄文章标题；"
           "④不超过 20 个字；⑤只输出标题本身，不要引号、不要解释、不要句号。\n"
           "文章标题：%s\n标签：%s\n正文开头：%s" % (title, tags, first_para[:120]))
    try:
        r = requests.post("https://api.commandcode.ai/provider/v1/chat/completions",
                          headers={"Authorization": "Bearer " + _env_key("COMMANDCODE_API_KEY")},
                          json={"model": model, "max_tokens": 300,
                                "messages": [{"role": "user", "content": ask}]}, timeout=90)
        msg = (r.json().get("choices") or [{}])[0].get("message") or {}
        t = (msg.get("content") or "").strip()
        if not t:      # 推理模型把话写在 reasoning 里，兜底从里面捞一个问句
            m = re.findall(r"[「\"']?(如何[^？\n「」\"']{1,20}？|怎样[^？\n「」\"']{1,20}？)", msg.get("reasoning") or "")
            t = m[-1] if m else ""
        t = re.sub(r"[。.]+$", "", t.strip().strip('"').strip("「」").split("\n")[0]).strip()
        if 4 <= len(t) <= 30 and ("？" in t or "?" in t):
            return t
        print("  (模型给的标题不可用，回退)", repr(t))
    except Exception as e:
        print("  (生成标题失败，回退)", repr(e))
    core = re.split(r"[：:（(—-]", title)[0].strip()
    return "如何评价%s？" % core


# ---------------- 渲染 ----------------
def header_full(d, eng, qtitle, author, avatar):
    up, fav, com, hear = eng
    tl = wrap(qtitle, font(S_TITLE, True), COL)
    shift = (len(tl) - 1) * TITLE_LH
    for i, ln in enumerate(tl):
        d.text((ML, TITLE_Y + i * TITLE_LH), ln, font=font(S_TITLE, True), fill=C_TITLE)
    avatar_circle(d, (ML, AUTHOR_Y + 2 + shift), AV_D, avatar)
    nx = ML + AV_D + 28
    d.text((nx, AUTHOR_Y + 4 + shift), author, font=font(S_AUTHOR, True), fill=C_WHITE)
    if SHOW_V:
        _v_badge(d, (nx + int(font(S_AUTHOR, True).getlength(author)) + 10, AUTHOR_Y + 13 + shift))
    draw_mixed(d, (nx, SIGN_Y + shift), [("博客 ", C_SIGN, False), ("👉", C_SIGN, False),
                                         (" " + SITE, C_SIGN, False)], size=S_SIGN)
    _share_icon(d, W - MR, AUTHOR_Y + 16 + shift)
    draw_mixed(d, (ML, ENGAGE_Y + shift), [("%s 人赞同了该回答 " % f"{up:,}", C_ENGAGE, False),
                                           ("›", C_ENGAGE, False),
                                           ("   🎧 %d 人听过" % hear, C_BLUE, False)], size=S_ENGAGE)
    y = CHIP_Y + shift
    chip = "内容包含虚构创作 ∨"
    cf = font(S_CHIP)
    d.rounded_rectangle([ML, y, ML + cf.getlength(chip) + 36, y + 52], radius=26, fill=C_CHIP_BG)
    d.text((ML + 18, y + 9), chip, font=cf, fill=C_CHIP_TXT)


def header_title_only(d, qtitle):
    for i, ln in enumerate(wrap(qtitle, font(S_TITLE, True), COL)):
        d.text((ML, TITLE_Y + i * TITLE_LH), ln, font=font(S_TITLE, True), fill=C_TITLE)


def body_height(wrapped_page):
    return sum(len(p) * LH for p in wrapped_page) + PGAP * (len(wrapped_page) - 1)


def page_image(page, page_no, total, eng, qtitle, author, avatar):
    first = page_no == 1
    top = BODY_TOP_P1 if first else BODY_TOP_N
    ink_bottom = top + body_height(page) - (LH - 34)
    H = ink_bottom + BOT_PAD
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    if first:
        header_full(d, eng, qtitle, author, avatar)
    else:
        header_title_only(d, qtitle)
    y = top
    for lines in page:
        for ln in lines:
            d.text((ML, y), ln, font=font(S_BODY), fill=C_BODY)
            y += LH
        y += PGAP
    # 页脚「转载于」+页码、分隔线、底部操作栏：2026-09-23 用户要求全部去掉，以后都不出现
    paste_watermark(im, top, ink_bottom)          # 印章水印：正文中间偏右、50% 透明
    return im


def paginate(wrapped, h_target=H_TARGET):
    """按页高目标反推页数，再按每页可用高度贪心装段落（段落不跨页拆）。"""
    total_h = body_height(wrapped)
    t = max(1, math.ceil((total_h + BODY_TOP_P1 + TAIL_P1) / h_target))
    while (h_target - BODY_TOP_P1 - TAIL_P1) + (t - 1) * (h_target - BODY_TOP_N - TAIL_N) < total_h:
        t += 1
    pages, cur, cur_h, cap = [], [], 0, h_target - BODY_TOP_P1 - TAIL_P1
    for p in wrapped:
        ph = len(p) * LH + (PGAP if cur else 0)
        if cur and cur_h + ph > cap:
            pages.append(cur)
            cur, cur_h = [], 0
            cap = h_target - BODY_TOP_N - TAIL_N
            ph = len(p) * LH
        cur.append(p); cur_h += ph
    if cur:
        pages.append(cur)
    return pages


def build(path, outdir, qtitle=None, author="焦羽", avatar=None, use_ai=True):
    meta, paras = load_article(path)
    slug = meta.get("slug") or os.path.splitext(os.path.basename(path))[0]
    title = meta.get("title") or slug
    if meta.get("password"):
        print("SKIP(加密文章):", title); return []
    if not qtitle:
        qtitle = make_qtitle(title, meta.get("tags", ""), paras[0]) if use_ai else title
    print("问题体标题:", qtitle)
    eng = fake_engagement(slug)
    wrapped = [wrap(p, font(S_BODY), COL) for p in paras]
    pages = paginate(wrapped)
    os.makedirs(outdir, exist_ok=True)
    base = re.sub(r'[\\/:*?"<>|]', "_", os.path.splitext(os.path.basename(path))[0])
    outs = []
    for i, pg in enumerate(pages, 1):
        im = page_image(pg, i, len(pages), eng, qtitle, author, avatar)
        fp = os.path.join(outdir, "%s_暗色_%d.png" % (base, i))
        im.save(fp)
        outs.append(fp)
    print("段落:", len(paras), "页数:", len(pages), "互动数字:", eng)
    for fp in outs:
        print("  ", fp, Image.open(fp).size)
    return outs


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--out", default=r"D:\作家系统\知乎问答图输出")
    ap.add_argument("--qtitle", default=None)
    ap.add_argument("--author", default="焦羽")
    ap.add_argument("--avatar", default=None)
    ap.add_argument("--no-ai", action="store_true")
    a = ap.parse_args()
    build(a.path, a.out, a.qtitle, a.author, a.avatar, not a.no_ai)
