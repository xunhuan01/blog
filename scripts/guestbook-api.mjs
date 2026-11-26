#!/usr/bin/env node
/**
 * 留言板后端 —— 零依赖 Node（>= 18），单文件。
 *
 * 本机预览：  node scripts/guestbook-api.mjs        → http://127.0.0.1:4401
 * 换端口：    GB_PORT=4500 node scripts/guestbook-api.mjs
 * 换数据盘：  GB_DATA_DIR=/var/lib/guestbook node scripts/guestbook-api.mjs
 * 开删除钥匙：GB_ADMIN_TOKEN=xxxx 后，DELETE /api/guestbook/:id 带 x-admin-token 才能删
 *
 * 数据：<repo>/.guestbook/messages.json（已在 .gitignore，不进版本库）
 *
 * ID 自动分配：文件里存一个单调递增的 seq，POST 进来就 seq += 1 当编号。
 * 因此删掉中间某条，编号也不会被复用；并发提交排队写入，不会撞号。
 *
 * 接口：
 *   GET    /api/guestbook?limit=200   → { total, seq, items:[{id,name,text,ts}] }
 *   POST   /api/guestbook  {name,text} → { ok:true, item:{...} }
 *   DELETE /api/guestbook/:id          → { ok:true, total }（需 x-admin-token）
 *   GET    /healthz                    → { ok:true }
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DATA_DIR = process.env.GB_DATA_DIR || path.join(REPO, ".guestbook");
const DATA_FILE = path.join(DATA_DIR, "messages.json");
const PORT = Number(process.env.GB_PORT || 4401);
const HOST = process.env.GB_HOST || "127.0.0.1";
const ADMIN_TOKEN = process.env.GB_ADMIN_TOKEN || "";

const NAME_MAX = 16;
const TEXT_MAX = 500;
const LIST_MAX = 500;

// ── 存储 ────────────────────────────────────────────────────────────────
let db = { seq: 0, items: [] };
let loaded = false;

async function load() {
  if (loaded) return;
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) {
      db = { seq: Number(parsed.seq) || 0, items: parsed.items };
      // 老文件没有 seq 字段时按现有最大 id 兜底
      const maxId = db.items.reduce((m, it) => Math.max(m, Number(it.id) || 0), 0);
      if (db.seq < maxId) db.seq = maxId;
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("[guestbook] 读取失败，按空库启动：", e.message);
  }
  loaded = true;
}

// 写盘串行队列：两次 POST 同时到，也必须一条一条落盘，否则会覆盖
let writeChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify({ seq: db.seq, items: db.items }, null, 2);
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await writeFile(tmp, snapshot, "utf8");
    await rename(tmp, DATA_FILE); // 原子替换，断电不会留下半个文件
  }).catch(err => console.error("[guestbook] 写盘失败：", err.message));
  return writeChain;
}

// ── 工具 ────────────────────────────────────────────────────────────────
function clean(v, max) {
  return String(v ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") // 控制字符
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

/**
 * 2026-11-26 用户定：昵称不给访客自定义，一律随机分配。
 * 客户端传来的 name 直接丢弃（用 curl 硬塞也没用），保证墙上的人名不可能被拿来冒充。
 */
function randomName() {
  const n = 1000 + Math.floor(Math.random() * 9000);
  return "访客" + n;
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-admin-token",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 简易防刷：同一 IP 20 秒内最多 3 条
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 20_000);
  if (arr.length >= 3) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // 防内存无限增长
  return false;
}

// ── 路由 ────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    await load();

    if (p === "/healthz") return json(res, 200, { ok: true, total: db.items.length, seq: db.seq });

    if (p === "/api/guestbook" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || LIST_MAX, LIST_MAX);
      // 老留言在前，前端自己决定倒序展示 —— 这样"第几条"永远和编号对得上
      const items = db.items.slice(-limit).map(({ id, name, text, ts }) => ({ id, name, text, ts }));
      return json(res, 200, { total: db.items.length, seq: db.seq, items });
    }

    if (p === "/api/guestbook" && req.method === "POST") {
      const ip = (req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] ||
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket.remoteAddress || "?").toString();
      if (rateLimited(ip)) return json(res, 429, { error: "太快了，歇 20 秒再来" });

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "请求格式不对" });
      }
      const text = clean(body.text, TEXT_MAX);
      if (!text) return json(res, 400, { error: "先写点什么吧" });
      const name = randomName(); // 昵称由服务端随机分配，忽略客户端传值

      db.seq += 1; // ← 编号在这里分发，全站唯一、删了不复用
      const item = { id: db.seq, name, text, ts: Date.now() };
      db.items.push(item);
      await persist();
      console.log(`[guestbook] #${item.id} ${name}: ${text.slice(0, 40)}`);
      return json(res, 201, { ok: true, item });
    }

    if (p.startsWith("/api/guestbook/") && req.method === "DELETE") {
      if (!ADMIN_TOKEN) return json(res, 403, { error: "未配置删除钥匙" });
      if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return json(res, 401, { error: "钥匙不对" });
      const id = Number(p.split("/").pop());
      const before = db.items.length;
      db.items = db.items.filter(it => Number(it.id) !== id);
      if (db.items.length === before) return json(res, 404, { error: "没有这条" });
      await persist();
      return json(res, 200, { ok: true, total: db.items.length });
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[guestbook] 500:", err);
    return json(res, 500, { error: "服务端出错了" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[guestbook] listening http://${HOST}:${PORT}  data=${DATA_FILE}`);
});
