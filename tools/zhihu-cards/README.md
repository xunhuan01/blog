# zhihu-cards · 博客文章 → 知乎 App 暗色风长图

把 Markdown 文章渲染成「知乎 App 深色模式」风格的多页长图（1600px 宽），可自动发到 Telegram。
最初为 [waiwei.top](https://waiwei.top) 的博客做，但任何带 frontmatter 的 Markdown 都能用。

## 效果

- 1600px 宽竖版长图，深色底 `#1A1A1A`，正文 33px、行距 58
- 第 1 页带「问题标题 + 头像 + 署名 + 互动行 + 虚构创作胶囊」，第 2 页起只有「问题标题 + 正文」（模拟知乎里往上翻）
- 正文中间偏右盖一枚半透明印章水印
- 2000~3000 字的文章自动压到约 3 页

## 依赖

```bash
pip install pillow requests
```

字体（Linux 上必须自备，Windows 直接用系统雅黑）：

| 文件 | 放哪 |
|---|---|
| `msyh.ttc`（微软雅黑） | Windows `C:\Windows\Fonts`；Linux `/root/.fonts/` |
| `msyhbd.ttc`（雅黑粗体） | 同上 |
| `seguiemj.ttf`（Segoe UI Emoji，渲染正文里的 emoji） | 同上 |

字体目录可用环境变量 `ZHIHU_FONT_DIR` 覆盖。

## 文件

| 文件 | 作用 |
|---|---|
| `zhihu_cards.py` | 渲染器。所有可调参数（画布/字号/行距/水印大小与透明度/底部留白）都在文件顶部常量区 |
| `send_tg.py` | 用 Telegram Bot API 把 PNG 按 `sendDocument` 发出（不压缩），带限流间隔 |
| `zhihu_cards_watch.py` | 看门狗：扫文章 → 出图 → 发 TG，带「已处理」台账，发失败不记账、下轮重试 |
| `assets/avatar.png` | 署名栏头像（圆裁） |
| `assets/watermark.png` | 印章水印（黑底图会按红色通道自动抠掉黑底） |

## 用法

```bash
# 单篇出图
python zhihu_cards.py article.md --out ./out
python zhihu_cards.py article.md --out ./out --title "如何评价某某？" --no-ai   # 跳过 AI 起标题

# 看门狗（定时任务用）
python zhihu_cards_watch.py            # 有新文章才出图（没新文章时 stdout 为空，方便挂 cron/watchdog）
python zhihu_cards_watch.py --seed     # 把当前所有文章标记为「已处理」，不做图（首次部署必跑，否则会刷屏）
python zhihu_cards_watch.py --force <slug>   # 忽略台账强制重出某篇
```

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `ZHIHU_FONT_DIR` | 字体目录 | Windows `C:\Windows\Fonts` / Linux `/root/.fonts` |
| `ZHIHU_ASSETS` | 头像、印章目录 | 脚本同级 `assets/` |
| `ZHIHU_POSTS` | 文章目录 | Windows `D:\myblog\src\content\posts` / Linux `/root/blog-repo/src/content/posts` |
| `ZHIHU_OUTROOT` | 出图根目录 | 同上风格 |
| `ZHIHU_REPO` | 文章所在的 git 仓库，设了会先 `git pull` | 空（不拉） |
| `ZHIHU_GIT_PROXY` | `git pull` 走的代理 | 空 |
| `TELEGRAM_BOT_TOKEN` | 机器人 token | 读 `~/.hermes/.env` |
| `TELEGRAM_ENV_FILE` | .env 路径 | `~/.hermes/.env` |
| `TG_CHAT_ID` | 发送目标 chat id | `1235290208` |
| `TELEGRAM_PROXY` | 发 TG 走的代理 | `http://127.0.0.1:7897` |
| `COMMANDCODE_API_KEY` | 生成「知乎问题体标题」用的模型 key，没有就走回退标题 | 读 `~/.hermes/.env` |

## 定时任务示例（Linux，每 30 分钟）

```cron
*/30 * * * * cd /root/zhihu_cards && ZHIHU_REPO=/root/blog-repo \
  ZHIHU_GIT_PROXY=http://127.0.0.1:7892 TELEGRAM_PROXY=http://127.0.0.1:7892 \
  /usr/bin/python3 zhihu_cards_watch.py >> /root/zhihu_cards/watch.log 2>&1
```

## 渲染规则（约定）

- frontmatter 带 `password:`（加密）或 `draft: true` 的文章跳过
- 互动数据（赞同/收藏/评论/听过）按 slug 哈希固定生成，同一篇文章多次出图数字不变
- 标题：默认调模型生成「宽泛的知乎问题体」，如 `如何评价孙宇晨？`；模型不可用时回退 `如何评价<文章标题主体>？`
