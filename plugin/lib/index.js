// ============================================================================
// dsh-remote-panel · 服务端半边
//
// 在 DSH 自己的 HTTP 服务器上挂 /dsh-remote/* 路由，供同源的客户端面板调用。
// 它只做三件事：读守卫的状态文件、调守卫 CLI 生成链接、调守卫 CLU 吊销设备。
//
// 为什么要有这一半：客户端面板跑在 DSH 页面里（同源 = DSH 的端口），
// 而守卫在另一个端口上；让它跨源调守卫要处理 CORS 与凭据，得不偿失。
// 插件本来就跑在 DSH 进程里、本来就是本机可信方，直接读文件/调 CLI 最干净。
//
// 权限：这些路由是"控制面"，必须只有 owner 能用。两道闸——
//   ① 守卫侧：/dsh-remote/* 在守卫里按 owner-only 处理（只读设备到不了这里）；
//   ② 本插件侧：经守卫来的请求必须带 x-dsh-remote-role: owner；本机直连必须 Host 是回环。
// ============================================================================
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "dsh-remote-panel";
export const inject = ["webServer"];

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const CONF_DIR = path.join(HOME, "remote");
const GUARD_CONF = path.join(CONF_DIR, "guard.json");
const TUNNEL_STATE = path.join(CONF_DIR, "tunnel.json");

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function isLoopbackHost(req) {
	const host = String(req.headers.host || "").replace(/^\[|\]$/g, "");
	return /^(127\.0\.0\.1|localhost|::1)(:\d+)?$/i.test(host);
}

/** 控制面准入：经守卫来的看角色头；本机直连（桌面壳）看 Host 是否回环。 */
function ownerAllowed(req) {
	const role = req.headers["x-dsh-remote-role"];
	if (role !== undefined) return String(role) === "owner";
	return isLoopbackHost(req);
}

function runGuard(guardPath, args) {
	return new Promise((resolve) => {
		if (!guardPath || !fs.existsSync(guardPath)) {
			resolve({ ok: false, error: "找不到守卫脚本：请在插件配置里填 config.guardPath，或设 DSH_REMOTE_GUARD" });
			return;
		}
		const child = spawn(process.execPath, [guardPath, ...args], { windowsHide: true });
		let out = "";
		child.stdout.on("data", (c) => { out += String(c); });
		child.stderr.on("data", (c) => { out += String(c); });
		child.on("error", (e) => resolve({ ok: false, error: e.message }));
		child.on("close", (code) => resolve({ ok: code === 0, out, code }));
	});
}

function json(res, code, value) {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
	res.end(body);
}

async function readBody(req) {
	return new Promise((resolve) => {
		let size = 0, chunks = [];
		req.on("data", (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); return; } chunks.push(c); });
		req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); } });
		req.on("error", () => resolve(null));
	});
}


/** 从守卫的状态文件里拼出当前两条链接的 URL（不解析 CLI 输出，稳定）。
 *  链接长期有效；要换新的必须走 /dsh-remote/reset。 */
function linksFromState() {
	const conf = readJson(GUARD_CONF) || {};
	const tun = readJson(TUNNEL_STATE) || {};
	let base = "";
	try {
		if (conf.urlFile && fs.existsSync(conf.urlFile)) base = fs.readFileSync(conf.urlFile, "utf8").trim();
	} catch { /* 读不到就用隧道状态里的域名 */ }
	if (!base) base = tun.url || "";
	base = base.replace(/\/+$/, "");
	const mk = (l) => (l && l.token ? { url: base + "/?t=" + l.token, role: l.role, name: l.name, createdAt: l.createdAt, longLived: true } : null);
	return { owner: mk(conf.links && conf.links.owner), readonly: mk(conf.links && conf.links.readonly) };
}

function guardSnapshot() {
	const conf = readJson(GUARD_CONF) || {};
	const tunnel = readJson(TUNNEL_STATE) || {};
	let urlFileEntry = "";
	try {
		const urlFile = conf.urlFile;
		if (urlFile && fs.existsSync(urlFile)) urlFileEntry = fs.readFileSync(urlFile, "utf8").trim();
	} catch { /* 读不到就算了 */ }
	return {
		entry: urlFileEntry || tunnel.url || "",
		tunnel: { url: tunnel.url || "", pid: tunnel.pid || null, restarts: tunnel.restarts || 0 },
		devices: (conf.devices || []).map((d) => ({ id: d.id, name: d.name, role: d.role, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt })),
		links: linksFromState(),
		pendingLinks: (conf.pairings || []).length,
		sessions: (conf.sessions || []).filter((s) => s.expiresAt > Date.now()).length
	};
}

export function apply(ctx, config) {
	const guardPath = (config && config.guardPath) || process.env.DSH_REMOTE_GUARD || "";

	ctx.webServer.register({
		kind: "prefix",
		path: "/dsh-remote",
		handler: async (req, res) => {
			const pathname = new URL(req.url || "/", "http://dsh.internal").pathname;
			const method = String(req.method || "GET").toUpperCase();

			if (!ownerAllowed(req)) {
				json(res, 403, { ok: false, error: "只允许 owner 设备（或本机）使用手机链接控制面" });
				return;
			}

			if (pathname === "/dsh-remote/status" && method === "GET") {
				json(res, 200, { ok: true, guardPath, configured: Boolean(guardPath), ...guardSnapshot() });
				return;
			}

			if (pathname === "/dsh-remote/devices" && method === "GET") {
				json(res, 200, { ok: true, devices: guardSnapshot().devices });
				return;
			}

			// 当前长期链接（两条）：不改动任何东西，纯读取
			if (pathname === "/dsh-remote/links" && method === "GET") {
				json(res, 200, { ok: true, ...linksFromState() });
				return;
			}

			// 重置：换新链接（旧链接立即作废）
			if (pathname === "/dsh-remote/reset" && method === "POST") {
				const out = await runGuard(guardPath, ["pair", "--reset"]);
				if (!out.ok) { json(res, 500, { ok: false, error: out.error || "重置失败", detail: out.out }); return; }
				const state = linksFromState();
				json(res, 200, { ok: true, ...state });
				return;
			}

			if (pathname === "/dsh-remote/link" && method === "GET") {
				const q = new URL(req.url || "/", "http://dsh.internal").searchParams;
				const role = q.get("role") === "readonly" ? "readonly" : "owner";
				const reset = q.get("reset") === "1";
				const args = ["pair", "--ttl", "3600", "--name", role === "readonly" ? "只读设备" : "我的手机"];
				if (role === "readonly") args.push("--role", "readonly");
				if (reset) args.push("--reset");
				const out = await runGuard(guardPath, args);
				if (!out.ok) { json(res, 500, { ok: false, error: out.error || "生成失败", detail: out.out }); return; }
				const url = (out.out.match(/https?:\/\/\S+\?t=[A-Za-z0-9_-]+/) || [])[0] || "";
				const code = (out.out.match(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/) || [])[0] || "";
				if (!url) { json(res, 500, { ok: false, error: "守卫没有返回链接", detail: out.out }); return; }
				json(res, 200, { ok: true, url, code, role, ttlSeconds: 3600, expiresAt: Date.now() + 3600 * 1000 });
				return;
			}

			// 手机二维码（SVG）：面板里点「二维码」时显示，手机相机扫一下即进
			if (pathname === "/dsh-remote/qr" && method === "GET") {
				const q = new URL(req.url || "/", "http://dsh.internal").searchParams;
				const role = q.get("role") === "readonly" ? "readonly" : "owner";
				const out = await runGuard(guardPath, ["qr", "--svg", "--role", role]);
				if (!out.ok || !out.out.includes("<svg")) {
					json(res, 500, { ok: false, error: out.error || "守卫没有返回二维码", detail: (out.out || "").slice(-300) });
					return;
				}
				const svg = out.out.slice(out.out.indexOf("<svg")).trim();
				const body = Buffer.from(svg, "utf8");
				res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
				res.end(body);
				return;
			}

			if (pathname === "/dsh-remote/revoke" && method === "POST") {
				const body = await readBody(req);
				const id = body && typeof body.id === "string" ? body.id : "";
				if (!id) { json(res, 400, { ok: false, error: "缺少 id" }); return; }
				const out = await runGuard(guardPath, ["revoke", id]);
				json(res, out.ok ? 200 : 500, { ok: out.ok, error: out.ok ? undefined : (out.error || "吊销失败"), detail: out.ok ? undefined : out.out });
				return;
			}

			json(res, 404, { ok: false, error: "unknown dsh-remote endpoint" });
		}
	});
}
