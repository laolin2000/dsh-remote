// ============================================================================
// dsh-remote-panel · 客户端半边（DSH 页面内）
//
// 注册进 `shell.overlay` 槽位 → DSH 界面里一个「手机链接」按钮。
// 形态与守卫注入版一致：**一条当前链接 + 三个按钮**（复制 / 只读 / 重置）+ 设备列表。
// 数据走同源的 /dsh-remote/*（由本插件的服务端半边提供）。
//
// 列表槽位注册必须带 id（漏了会报：list slot "..." requires options.id）。
// 面板是自成一体的浮层，用原生 DOM 建（React 只用来接槽位的生命周期）。
// ============================================================================
window.__ModuleLoader__.load({
	id: "dsh-remote-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		const CSS = {
			// 与「EAC监控」悬浮按钮（dsh-eac-monitor 的 .em-quick）同一套大小与配色：
			// 同样的内边距/圆角/阴影，背景与描边用同一批 DSH 主题变量（跟随主题），文字 11px 同色。
			btn: "position:fixed;right:14px;bottom:56px;z-index:2147483000;display:flex;align-items:center;gap:6px;" +
				"padding:6px 12px;border-radius:999px;cursor:pointer;font:11px/1 -apple-system,'Microsoft YaHei',sans-serif;" +
				"background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#101828) 92%,transparent);" +
				"border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));" +
				"box-shadow:0 4px 14px rgba(0,0,0,.35);user-select:none",
			dot: "width:8px;height:8px;border-radius:50%;flex:none;background:#22c55e",
			hoverBorder: "var(--dsw-alias-state-business-primary,#4d6bfe)",   // 与 EAC 按钮一致的悬停描边
			normalBorder: "var(--dsw-alias-border-l1,rgba(255,255,255,.12))",
			text: "color:var(--dsw-alias-label-secondary,#b8c5ea)",
			mask: "position:fixed;inset:0;background:rgba(0,0,0,.45)",
			panel: "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(94vw,560px);" +
				"max-height:86vh;overflow:auto;padding:16px 18px;border-radius:14px;background:#12161f;border:1px solid #262d3b;" +
				"color:#e6e9f0;font:13px/1.6 -apple-system,'Microsoft YaHei',sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.6)",
			h1: "font-size:15px;font-weight:600;margin:0;color:#e6e9f0",
			sub: "font-size:11px;color:#8b96ad;margin:2px 0 10px",
			card: "background:#151a24;border:1px solid #1e2532;border-radius:10px;padding:11px 12px;margin-bottom:10px",
			row: "display:flex;align-items:center;gap:8px;flex-wrap:wrap",
			box: "font:12px/1.6 Consolas,monospace;color:#cfe3ff;word-break:break-all;background:#0b0f16;border:1px solid #243044;" +
				"border-radius:8px;padding:9px;margin:6px 0;user-select:text;-webkit-user-select:text;cursor:text",
			b: "padding:8px 13px;border-radius:8px;border:1px solid #3b82f6;background:#1d4ed8;color:#fff;font-size:12.5px;cursor:pointer",
			g: "padding:8px 13px;border-radius:8px;border:1px solid #2a3240;background:#1b2130;color:#cfd7e6;font-size:12.5px;cursor:pointer",
			warn: "padding:8px 13px;border-radius:8px;border:1px solid #6b4a1f;background:#2a1f12;color:#ffd166;font-size:12.5px;cursor:pointer",
			del: "padding:4px 9px;border-radius:14px;border:1px solid #4a2a2a;background:#241a1a;color:#e08a8a;font-size:11px;cursor:pointer",
			ok: "color:#3ddc84", bad: "color:#e05252", mut: "color:#8b96ad", warn: "color:#f0b429",
			step: "display:flex;align-items:flex-start;gap:7px;padding:4px 0;border-bottom:1px solid #1e2532;font-size:11px;line-height:1.5",
			stepDot: "width:8px;height:8px;border-radius:50%;flex:none;margin-top:4px",
			dev: "display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e2532"
		};

		function el(tag, css, text) {
			const e = document.createElement(tag);
			if (css) e.setAttribute("style", css);
			if (text != null) e.textContent = text;
			return e;
		}

		/** 复制：优先 clipboard API，失败退到 execCommand，并**如实返回是否成功**。 */
		function copyText(text) {
			return new Promise((resolve) => {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(legacy()));
					return;
				}
				resolve(legacy());
				function legacy() {
					try {
						const ta = el("textarea");
						ta.value = text;
						ta.setAttribute("style", "position:fixed;left:-9999px;top:0");
						document.body.appendChild(ta);
						ta.focus();
						ta.select();
						let ok = false;
						try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
						ta.remove();
						return ok;
					} catch (e) { return false; }
				}
			});
		}
		function jget(url) {
			return fetch(url, { headers: { accept: "application/json" }, cache: "no-store" })
				.then((r) => r.ok ? r.json() : null).catch(() => null);
		}
		function jpost(url, body) {
			return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
				.then((r) => r.ok ? r.json() : null).catch(() => null);
		}

		// ---- 兜底：插件自己的服务端路由不可用时，直连本机守卫 ----
		// 场景：插件服务端半边是旧版（新路由 404）或没配 guardPath。守卫对「本机直连」
		// 按可信处理（回环且没有 X-Forwarded-*/Cf-* 头），所以这里带上凭据直接问它。
		const GUARD_BASE = "http://127.0.0.1:8443";
		const FALLBACK_MAP = {
			"/dsh-remote/status": "/__guard/status",
			"/dsh-remote/links": "/__guard/links",
			"/dsh-remote/devices": "/__guard/devices",
			"/dsh-remote/link": "/__guard/link",
			"/dsh-remote/reset": "/__guard/reset",
			"/dsh-remote/qr": "/__guard/qr",
			"/dsh-remote/whoami": "/__guard/whoami",
			"/dsh-remote/revoke": "/__guard/revoke"
		};
		let usedFallback = false;
		function direct(url, options) {
			const mapped = FALLBACK_MAP[url.split("?")[0].replace(/\/$/, "")];
			if (!mapped) return Promise.resolve(null);
			const full = GUARD_BASE + mapped + (url.includes("?") ? "?" + url.split("?")[1] : "");
			return fetch(full, { ...(options || {}), credentials: "include", cache: "no-store" })
				.then((r) => {
					if (!r.ok) return null;
					usedFallback = true;
					return r.json();
				})
				.catch(() => null);
		}
		function apiGet(url) {
			return jget(url).then((d) => d || direct(url));
		}
		function apiPost(url, body) {
			return jpost(url, body).then((d) => d || direct(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }));
		}
		function selectAll(node) {
			try {
				const r = document.createRange();
				r.selectNodeContents(node);
				const sel = window.getSelection();
				sel.removeAllRanges();
				sel.addRange(r);
			} catch (e) { /* 老浏览器忽略 */ }
		}

		// 遮罩与面板共用一个容器：关闭时一起移除。
		// （反面教材：只 remove 面板、留下遮罩 → 页面整体变暗且点不动，用户只能刷新。）
		let panel = null;
		let layer = null;
		function closePanel() {
			if (layer) { layer.remove(); layer = null; }
			panel = null;
			document.removeEventListener("keydown", onEsc);
		}
		function onEsc(e) { if (e.key === "Escape") closePanel(); }

		function openPanel() {
			closePanel();
			layer = el("div", "position:fixed;inset:0;z-index:2147483001");
			layer.id = "__dsh_remote_layer";
			const mask = el("div", CSS.mask);
			mask.addEventListener("click", closePanel);
			layer.appendChild(mask);
			panel = el("div", CSS.panel);

			const head = el("div", CSS.row);
			head.setAttribute("style", CSS.row + ";justify-content:space-between");
			head.appendChild(el("div", CSS.h1, "手机链接"));
			const x = el("button", CSS.g, "关闭");
			x.addEventListener("click", closePanel);
			head.appendChild(x);
			panel.appendChild(head);
			// 自己是谁要写在面板上：多台设备/多条链接下，"我在用哪条"是排查第一问
			const identityLine = el("div", CSS.sub, "当前设备：…");
			panel.appendChild(identityLine);
			apiGet("/dsh-remote/whoami").then((me) => {
				if (me && me.ok) identityLine.textContent = "当前设备：" + me.name + "（" + (me.readonly ? "只读" : "owner · 全权") + "）";
			});
			panel.appendChild(el("div", CSS.sub, "这条链接长期有效——改之前一直是它。手机点开即自动配对进入 DSH。"));

			const card = el("div", CSS.card);
			card.appendChild(el("div", null, "当前链接"));
			const box = el("div", CSS.box, "正在读取…");
			box.title = "点一下可全选";
			box.addEventListener("click", () => selectAll(box));
			card.appendChild(box);

			const btns = el("div", CSS.row);
			const copyBtn = el("button", CSS.b, "复制");
			const qrBtn = el("button", CSS.g, "二维码");
			const roBtn = el("button", CSS.g, "只读");
			const resetBtn = el("button", CSS.warn, "重置");
			btns.appendChild(copyBtn);
			btns.appendChild(qrBtn);
			btns.appendChild(roBtn);
			btns.appendChild(resetBtn);
			card.appendChild(btns);

			// 二维码：电脑屏幕上显示，手机相机扫一下即进（省去复制粘贴）
			const qrWrap = el("div", null, "");
			qrWrap.setAttribute("style", "display:none;margin-top:8px;text-align:center");
			card.appendChild(qrWrap);

			const roWrap = el("div", null, "");
			roWrap.setAttribute("style", "display:none");
			roWrap.appendChild(el("div", CSS.sub, "只读分享链接（给对方看会话与图片；写入在服务端被拦）"));
			const roBox = el("div", CSS.box, "");
			roBox.addEventListener("click", () => selectAll(roBox));
			roWrap.appendChild(roBox);
			const roCopy = el("button", CSS.g, "复制只读链接");
			roWrap.appendChild(roCopy);
			card.appendChild(roWrap);

			const status = el("div", CSS.sub, "");
			card.appendChild(status);
			panel.appendChild(card);

			const devCard = el("div", CSS.card);
			devCard.appendChild(el("div", null, "已授权设备"));
			const devList = el("div", null, "…");
			devCard.appendChild(devList);
			panel.appendChild(devCard);
			panel.appendChild(el("div", CSS.sub, "吊销设备会立刻让它掉线（该设备的会话 cookie 同时失效）。"));

			// ---- 运行状态：哪一段没起来，一键拉起来 ----
			const healthCard = el("div", CSS.card);
			healthCard.appendChild(el("div", null, "运行状态"));
			const healthLine = el("div", CSS.sub, "正在体检…");
			healthCard.appendChild(healthLine);
			const healthSteps = el("div", null, "");
			healthSteps.setAttribute("style", "margin:6px 0 2px");
			healthCard.appendChild(healthSteps);
			const fixRow = el("div", CSS.row);
			const fixBtn = el("button", CSS.b, "启动 / 修复");
			fixBtn.setAttribute("style", "display:none");
			const recheckBtn = el("button", CSS.g, "重新体检");
			fixRow.appendChild(fixBtn);
			fixRow.appendChild(recheckBtn);
			healthCard.appendChild(fixRow);
			panel.appendChild(healthCard);

			const foot = el("div", CSS.sub, "");
			panel.appendChild(foot);

			layer.appendChild(panel);
			document.body.appendChild(layer);
			document.addEventListener("keydown", onEsc);

			let state = { owner: "", readonly: "" };
			const say = (text, cls) => { status.textContent = text; status.setAttribute("style", CSS.sub + ";" + (cls || "")); };
			const nowText = () => new Date().toLocaleTimeString();

			function doCopy(text, btn, label) {
				if (!text) { say("还没有链接可取", CSS.bad); return; }
				const original = btn.textContent;
				copyText(text).then((ok) => {
					if (ok) {
						btn.textContent = "已复制 ✓";
						setTimeout(() => { btn.textContent = original; }, 2500);
						say("已复制" + label + "到剪贴板 · " + nowText() + "　（也可以点链接框手动选中）", CSS.ok);
					} else {
						btn.textContent = "复制失败";
						setTimeout(() => { btn.textContent = original; }, 2500);
						say("自动复制被浏览器拦下了：请点上面的链接框（会全选）后长按/右键复制", CSS.bad);
					}
				});
			}

			copyBtn.addEventListener("click", () => doCopy(state.owner, copyBtn, "主链接"));
			roCopy.addEventListener("click", () => doCopy(state.readonly, roCopy, "只读链接"));
			qrBtn.addEventListener("click", () => {
				const hidden = qrWrap.getAttribute("style").indexOf("none") >= 0;
				if (!hidden) { qrWrap.setAttribute("style", "display:none"); qrBtn.textContent = "二维码"; return; }
				qrWrap.setAttribute("style", "display:block;margin-top:8px;text-align:center");
				qrWrap.textContent = "正在生成…";
				qrBtn.textContent = "收起二维码";
				const mapped = FALLBACK_MAP["/dsh-remote/qr"];
				fetch("/dsh-remote/qr?role=owner", { headers: { accept: "image/svg+xml" }, cache: "no-store" })
					.then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
					.catch(() => fetch(GUARD_BASE + mapped + "?role=owner", { credentials: "include", cache: "no-store" })
						.then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); usedFallback = true; return r.text(); }))
					.then((svg) => {
						if (!svg || svg.trim().startsWith("{")) throw new Error("守卫没有返回二维码");
						qrWrap.innerHTML = svg.replace("<svg ", '<svg style="width:min(70vw,240px);height:auto;background:#fff;border-radius:8px;padding:6px" ');
						qrWrap.appendChild(el("div", CSS.sub, "手机相机对准这张码 → 直接进入 DSH（链接长期有效）"));
						say("二维码已生成 · " + nowText() + (usedFallback ? "（插件路由不可用，已直连守卫）" : ""), CSS.ok);
					})
					.catch((e) => { qrWrap.textContent = ""; qrWrap.appendChild(el("div", CSS.bad, "二维码生成失败：" + e.message)); });
			});
			roBtn.addEventListener("click", () => {
				// 单纯的开/关切换（之前的写法一旦打开就再也收不起来）
				const open = roWrap.getAttribute("style").indexOf("none") < 0;
				if (open) { roWrap.setAttribute("style", "display:none"); roBtn.textContent = "只读"; return; }
				roWrap.setAttribute("style", "display:block;margin-top:6px;padding-top:8px;border-top:1px solid #1e2532");
				roBtn.textContent = "收起只读";
				if (!state.readonly) { say("还没取到只读链接", CSS.bad); return; }
				roBox.textContent = state.readonly;
				doCopy(state.readonly, roCopy, "只读链接");
			});

			resetBtn.addEventListener("click", () => {
				if (!window.confirm("重置链接？\n\n当前链接会立即作废（已配对设备不受影响），需要把新链接重新发到手机。")) return;
				say("正在重置…", CSS.mut);
				apiPost("/dsh-remote/reset", {}).then((r) => {
					if (!r || !r.ok) { say("重置失败：" + ((r && r.error) || "守卫或配置有问题"), CSS.bad); return; }
					loadLinks();
					const url = (r.owner && r.owner.url) || "";
					const original = resetBtn.textContent;
					copyText(url).then((ok) => {
						resetBtn.textContent = ok ? "已重置并复制 ✓" : "已重置";
						setTimeout(() => { resetBtn.textContent = original; }, 2500);
						say(ok ? "已重置，新链接已复制 · " + nowText() : "已重置，自动复制失败——请点链接框手动选中", ok ? CSS.ok : CSS.bad);
					});
				});
			});

			function loadLinks() {
				apiGet("/dsh-remote/links").then((d) => {
					if (!d || !d.ok) { box.textContent = "（读不到链接：守卫没在运行，或插件路由/配置有问题）"; say("读取失败：可先在 DSH 里点设置→通用→手机链接 重试；仍失败请查看 ~/.dsh/remote/guard.log", CSS.bad); return; }
					state = { owner: (d.owner && d.owner.url) || "", readonly: (d.readonly && d.readonly.url) || "" };
					box.textContent = state.owner || "（无）";
					roBox.textContent = state.readonly || "（无）";
					const when = d.owner && d.owner.createdAt ? new Date(d.owner.createdAt).toLocaleString() : "";
					const isLocal = !!(d.owner && d.owner.local) || !!d.local;
					if (when) say("链接创建于 " + when + " · 长期有效" + (usedFallback ? "（插件路由不可用，已直连守卫）" : ""), CSS.mut);
					// 没有公网入口时必须说清楚，否则用户以为链接坏了（实测踩到过：只显示 "/?t=..."）
					if (isLocal) say("⚠ 这还不是公网链接：当前是本机入口（只有这台电脑能打开）。手机要用，先在电脑上跑 " +
						"node guard/guard.mjs tunnel up --cloudflared <cloudflared 路径>", CSS.bad);
				});
			}

			function loadDevices() {
				apiGet("/dsh-remote/devices").then((d) => {
					devList.textContent = "";
					if (!d || !d.devices || !d.devices.length) { devList.appendChild(el("div", CSS.mut, "（还没有设备）")); return; }
					d.devices.forEach((dev) => {
						const row = el("div", CSS.dev);
						const left = el("div", null);
						left.appendChild(el("div", null, dev.name));
						left.appendChild(el("span", dev.role === "owner" ? CSS.ok : CSS.mut,
							dev.role === "owner" ? "owner · 可发指令 / 看图 / 审批" : "只读 · 只能看"));
						left.appendChild(el("div", CSS.sub, "最近活跃 " + (dev.lastSeenAt ? new Date(dev.lastSeenAt).toLocaleString() : "从未")));
						const del = el("button", CSS.del, "吊销");
						del.addEventListener("click", () => {
							if (!window.confirm("吊销设备「" + dev.name + "」？它会立刻掉线。")) return;
							apiPost("/dsh-remote/revoke", { id: dev.id }).then((r) => {
								if (r && r.ok) { say("已吊销 " + dev.name, CSS.ok); loadDevices(); }
								else say("吊销失败：" + ((r && r.error) || "未知原因"), CSS.bad);
							});
						});
						row.appendChild(left);
						row.appendChild(del);
						devList.appendChild(row);
					});
				});
			}

			loadLinks();
			loadDevices();

			/** 逐环节渲染：每行一个环节，带状态点 + 原因 + 修法（快速定位到"哪一段没起来"） */
			function renderSteps(list) {
				healthSteps.textContent = "";
				const color = { ok: "#22c55e", warn: "#f0b429", fail: "#e05252" };
				const mark = { ok: "✓", warn: "!", fail: "✗" };
				(list || []).forEach((st) => {
					const row = el("div", CSS.step);
					const dot = el("span", CSS.stepDot);
					dot.setAttribute("style", CSS.stepDot + ";background:" + (color[st.status] || "#8b96ad"));
					dot.textContent = mark[st.status] === "✓" ? "" : "";
					const body = el("div", null);
					const head = el("div", null, `${st.label}　`);
					const tag = el("span", "color:" + (color[st.status] || "#8b96ad"), st.status === "ok" ? "正常" : st.status === "warn" ? "注意" : "失败");
					head.appendChild(tag);
					body.appendChild(head);
					body.appendChild(el("div", CSS.mut, st.detail || ""));
					if (st.hint && st.status !== "ok") body.appendChild(el("div", CSS.warn, "↳ " + st.hint));
					row.appendChild(dot);
					row.appendChild(body);
					healthSteps.appendChild(row);
				});
			}

			/** 体检 + 需要时给出一键修复（守卫掉了就把它拉起来、隧道掉了就拉隧道）。 */
			function loadHealth() {
				healthLine.textContent = "正在体检…";
				healthSteps.textContent = "";
				fixBtn.setAttribute("style", "display:none");
				apiGet("/dsh-remote/health").then((h) => {
					if (!h || !h.ok) {
						healthLine.textContent = "体检失败：插件服务端半边可能是旧版（重启一次 DSH 即可）；当前进程里没有 /dsh-remote/health";
						healthLine.setAttribute("style", CSS.bad);
						return;
					}
					const list = h.steps || [];
					renderSteps(list);
					const fails = list.filter((s) => s.status === "fail").length;
					const warns = list.filter((s) => s.status === "warn").length;
					const bad = fails > 0 || warns > 0;
					healthLine.textContent = list.length
						? `逐环节体检：${list.length} 项 · 正常 ${list.length - fails - warns} · 注意 ${warns} · 失败 ${fails}`
						: "体检完成（这一版插件还没有逐环节数据，重启一次 DSH 即可）";
					healthLine.setAttribute("style", fails ? CSS.bad : (warns ? CSS.warn : CSS.ok));
					fixBtn.setAttribute("style", bad ? CSS.b.replace("display:none", "") + ";display:inline-block" : "display:none");
				});
			}
			fixBtn.addEventListener("click", () => {
				fixBtn.textContent = "正在启动…";
				fixBtn.setAttribute("style", "display:inline-block;opacity:.6");
				apiPost("/dsh-remote/start", {}).then((r) => {
					fixBtn.textContent = "启动 / 修复";
					if (!r) { say("启动失败：插件服务端半边可能是旧版（重启一次 DSH）", CSS.bad); loadHealth(); return; }
					say(r.ok ? "已把没起来的环节拉起来了 · " + nowText() : ("部分成功：" + [r.guard?.error, r.tunnel?.error].filter(Boolean).join("；")), r.ok ? CSS.ok : CSS.bad);
					loadHealth();
					loadLinks();
				});
			});
			recheckBtn.addEventListener("click", loadHealth);
			loadHealth();

			apiGet("/dsh-remote/status").then((st) => {
				if (!st || !st.ok) return;
				const t = st.tunnel || {};
				foot.textContent = "隧道：" + (t.url || "未启动") + "　自愈重启 " + (t.restarts || 0) + " 次　在线设备会话 " + (st.sessions || 0);
			});
		}

		let mounted = false;
		// 和「EAC监控」的悬浮按钮排成一列：贴着它的正上方（同一列 = 相同的 right）。
		// EAC 按钮的位置不归我们管，所以挂载时动态测量，测不到就用缺省位置；
		// EAC 可能比我们后挂载，所以短促重试几次。
		function placeAboveEac(btn, attempt = 0) {
			const divs = document.querySelectorAll("div");
			let target = null;
			for (const e of divs) {
				if (e.id === "__dsh_remote_button" || !e.firstChild) continue;
				const t = (e.textContent || "").replace(/\s+/g, "");
				if (t.indexOf("EAC监控") === 0 || t.indexOf("EAC监") === 0) {
					try { if (getComputedStyle(e).position === "fixed") { target = e; break; } } catch { /* 忽略 */ }
				}
			}
			if (target) {
				const r = target.getBoundingClientRect();
				if (r.width > 0 || r.height > 0) {
					btn.style.right = Math.max(8, window.innerWidth - r.right) + "px";
					btn.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
					return;
				}
			}
			if (attempt < 10) setTimeout(() => placeAboveEac(btn, attempt + 1), 500);
		}

		function mountButton() {
			if (mounted || document.getElementById("__dsh_remote_button")) return;
			mounted = true;
			const btn = el("div", CSS.btn);
			btn.id = "__dsh_remote_button";
			btn.title = "dsh-remote · 手机链接";
			btn.appendChild(el("span", CSS.dot));                    // 8px 状态点，与 EAC 的 .em-dot 同规格同色
			btn.appendChild(el("span", CSS.text, "手机链接"));        // 11px，与 .em-quickText 同规格同色
			// EAC 按钮悬停时描边会变成主题蓝；用同样规则保持一致（内联样式模拟 :hover）
			btn.addEventListener("mouseenter", () => { btn.style.borderColor = CSS.hoverBorder; });
			btn.addEventListener("mouseleave", () => { btn.style.borderColor = CSS.normalBorder; });
			btn.addEventListener("click", openPanel);
			document.body.appendChild(btn);
			placeAboveEac(btn);
		}

		function RemotePanelSlot() {
			React.useEffect(() => { mountButton(); }, []);
			return null;
		}

		// 设置页里也放一个入口（DSH 设置 → 通用 → 「手机链接」）
		function RemoteSettingsItem() {
			return React.createElement("div", {
				style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "10px 0" }
			},
				React.createElement("div", null,
					React.createElement("div", { style: { fontSize: "13px", color: "#e6e9f0" } }, "手机链接"),
					React.createElement("div", { style: { fontSize: "11px", color: "#8b96ad" } },
						"显示当前链接（长期有效）、复制、只读分享、重置与设备管理")
				),
				React.createElement("button", {
					type: "button",
					onClick: () => openPanel(),
					style: {
						padding: "7px 12px", borderRadius: "8px", border: "1px solid #3b82f6",
						background: "#1d4ed8", color: "#fff", fontSize: "12px", cursor: "pointer", flex: "none"
					}
				}, "打开")
			);
		}

		const inject = ["slots"];
		function apply(ctx) {
			try {
				ctx.slots.register({ name: "shell.overlay", id: "dsh-remote-panel", order: 100 }, RemotePanelSlot);
			} catch (err) {
				console.warn("[dsh-remote-panel] 浮层按钮注册失败：", err);
			}
			try {
				ctx.slots.register({
					name: "settings.general.item", id: "dsh-remote-panel", order: 30,
					label: () => "手机链接"
				}, RemoteSettingsItem);
			} catch (err) {
				console.warn("[dsh-remote-panel] 设置项注册失败：", err);
			}
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
