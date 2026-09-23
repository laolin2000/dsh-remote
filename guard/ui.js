// ============================================================================
// guard/ui.js —— 注入到 DSH 页面里的「手机链接」面板
//
// 形态：**一条当前链接 + 三个按钮**（复制 / 只读 / 重置），下面是已授权设备。
//   · 链接长期有效，只有「重置」才换；
//   · 「只读」= 把只读分享链接显示出来并可复制（服务端另发一个只读 token，角色由服务端强制）；
//   · 复制有明确反馈：按钮变成「已复制 ✓」+ 状态行带时间；失败会告诉你要手动长按选中。
//
// 为什么不写 DSH 插件：DSH 的 Extension SDK 只能给 agent 加工具，没有界面能力。
// 守卫本来就在链路上、本来就要改写发出去的 HTML，所以由它注入最稳。
// 面板只在 owner 设备上出现（只读设备拿 403 就静默不渲染）。
// ============================================================================
(function () {
  "use strict";
  if (window.__dshRemoteUi) return;
  window.__dshRemoteUi = true;

  var API = { status: "/__guard/status", links: "/__guard/links", link: "/__guard/link", devices: "/__guard/devices", revoke: "/__guard/revoke", reset: "/__guard/reset", qr: "/__guard/qr" };

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.setAttribute("style", css);
    if (text != null) e.textContent = text;
    return e;
  }

  /** 复制：优先 clipboard API，失败退到 execCommand，并**如实返回是否成功**。 */
  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(legacy()); });
        return;
      }
      resolve(legacy());
      function legacy() {
        try {
          var ta = el("textarea");
          ta.value = text;
          ta.setAttribute("style", "position:fixed;left:-9999px;top:0");
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          var ok = false;
          try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
          ta.remove();
          return ok;
        } catch (e) { return false; }
      }
    });
  }
  function jget(url) {
    return fetch(url, { headers: { accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function jpost(url, body) {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  var CSS = {
    btn: "position:fixed;right:14px;bottom:56px;z-index:2147483000;display:flex;align-items:center;gap:6px;" +
         "padding:9px 13px;border-radius:999px;cursor:pointer;font:13px/1 -apple-system,'Microsoft YaHei',sans-serif;" +
         "color:#d7f5e3;background:#10231b;border:1px solid #1f5c3f;box-shadow:0 4px 14px rgba(0,0,0,.45);user-select:none",
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
    ok: "color:#3ddc84", bad: "color:#e05252", mut: "color:#8b96ad",
    dev: "display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e2532",
    tag: "font-size:10px;padding:2px 7px;border-radius:10px;border:1px solid #1f5c3f;color:#3ddc84;margin-left:6px"
  };

  var layer = null, panel = null;

  // 遮罩与面板共用一个容器：关闭时一起移除。
  // （反面教材：只 remove 面板、留下遮罩 → 页面整体变暗且点不动，用户只能刷新。）
  function close() {
    if (layer) { layer.remove(); layer = null; }
    panel = null;
    document.removeEventListener("keydown", onEsc);
  }
  function onEsc(e) { if (e.key === "Escape") close(); }

  function open() {
    close();
    layer = el("div", "position:fixed;inset:0;z-index:2147483001");
    layer.id = "__dsh_remote_layer";
    var mask = el("div", CSS.mask);
    mask.addEventListener("click", close);
    layer.appendChild(mask);
    panel = el("div", CSS.panel);
    panel.id = "__dsh_remote_panel";

    var head = el("div", CSS.row);
    head.setAttribute("style", CSS.row + ";justify-content:space-between");
    head.appendChild(el("div", CSS.h1, "手机链接"));
    var x = el("button", CSS.g, "关闭");
    x.addEventListener("click", close);
    head.appendChild(x);
    panel.appendChild(head);
    panel.appendChild(el("div", CSS.sub, "这条链接长期有效——改之前一直是它。手机点开即自动配对进入 DSH。"));

    // ---- 当前链接（一条 + 三个按钮）----
    var card = el("div", CSS.card);
    card.appendChild(el("div", null, "当前链接"));
    var box = el("div", CSS.box, "正在读取…");
    box.title = "点一下可全选";
    box.addEventListener("click", function () {
      try {
        var r = document.createRange();
        r.selectNodeContents(box);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      } catch (e) {}
    });
    card.appendChild(box);

    var btns = el("div", CSS.row);
    var copyBtn = el("button", CSS.b, "复制");
    var qrBtn = el("button", CSS.g, "二维码");
    var roBtn = el("button", CSS.g, "只读");
    var resetBtn = el("button", CSS.warn, "重置");
    btns.appendChild(copyBtn);
    btns.appendChild(qrBtn);
    btns.appendChild(roBtn);
    btns.appendChild(resetBtn);
    card.appendChild(btns);

    // 二维码：在电脑屏幕上显示，手机相机扫一下就进 DSH（省去复制粘贴）
    var qrWrap = el("div", null, "");
    qrWrap.setAttribute("style", "display:none;margin-top:8px;text-align:center");
    card.appendChild(qrWrap);

    var roWrap = el("div", null, "");
    roWrap.setAttribute("style", "display:none");
    roWrap.appendChild(el("div", CSS.sub, "只读分享链接（给对方看会话与图片；写入在服务端被拦）"));
    var roBox = el("div", CSS.box, "");
    roBox.addEventListener("click", function () {
      try {
        var r = document.createRange(); r.selectNodeContents(roBox);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      } catch (e) {}
    });
    roWrap.appendChild(roBox);
    var roCopy = el("button", CSS.g, "复制只读链接");
    roWrap.appendChild(roCopy);
    card.appendChild(roWrap);

    var status = el("div", CSS.sub, "");
    card.appendChild(status);
    panel.appendChild(card);

    // ---- 设备 ----
    var devCard = el("div", CSS.card);
    devCard.appendChild(el("div", null, "已授权设备"));
    var devList = el("div", null, "…");
    devCard.appendChild(devList);
    panel.appendChild(devCard);
    panel.appendChild(el("div", CSS.sub, "吊销设备会立刻让它掉线（该设备的会话 cookie 同时失效）。"));
    var foot = el("div", CSS.sub, "");
    panel.appendChild(foot);

    layer.appendChild(panel);
    document.body.appendChild(layer);
    document.addEventListener("keydown", onEsc);

    var state = { owner: "", readonly: "" };
    function say(text, cls) { status.textContent = text; status.setAttribute("style", CSS.sub + ";" + (cls || "")); }
    function nowText() { return new Date().toLocaleTimeString(); }

    /** 复制 + 明确反馈：按钮改成「已复制 ✓」，状态行带时间；失败则提示手动选中。 */
    function doCopy(text, btn, label) {
      if (!text) { say("还没有链接可取", CSS.bad); return; }
      var original = btn.textContent;
      copyText(text).then(function (ok) {
        if (ok) {
          btn.textContent = "已复制 ✓";
          setTimeout(function () { btn.textContent = original; }, 2500);
          say("已复制" + label + "到剪贴板 · " + nowText() + "　（也可以点链接框手动选中）", CSS.ok);
        } else {
          btn.textContent = "复制失败";
          setTimeout(function () { btn.textContent = original; }, 2500);
          say("自动复制被浏览器拦下了：请点上面的链接框（会全选）后长按/右键复制", CSS.bad);
        }
      });
    }

    copyBtn.addEventListener("click", function () { doCopy(state.owner, copyBtn, "主链接"); });
    roCopy.addEventListener("click", function () { doCopy(state.readonly, roCopy, "只读链接"); });
    qrBtn.addEventListener("click", function () {
      var hidden = qrWrap.getAttribute("style").indexOf("none") >= 0;
      if (!hidden) { qrWrap.setAttribute("style", "display:none"); qrBtn.textContent = "二维码"; return; }
      qrWrap.setAttribute("style", "display:block;margin-top:8px;text-align:center");
      qrWrap.textContent = "正在生成…";
      qrBtn.textContent = "收起二维码";
      // 守卫给的是 SVG（矢量，缩放不糊），直接内联；失败要说清楚原因，别只显示空白
      fetch(API.qr + "?role=owner", { headers: { accept: "image/svg+xml" }, cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
        .then(function (svg) {
          qrWrap.innerHTML = svg.replace("<svg ", '<svg style="width:min(70vw,240px);height:auto;background:#fff;border-radius:8px;padding:6px" ');
          var tip = el("div", CSS.sub, "手机相机对准这张码 → 直接进入 DSH（链接长期有效）");
          qrWrap.appendChild(tip);
          say("二维码已生成 · " + nowText(), CSS.ok);
        })
        .catch(function (e) { qrWrap.textContent = ""; qrWrap.appendChild(el("div", CSS.bad, "二维码生成失败：" + e.message)); });
    });
    roBtn.addEventListener("click", function () {
      // 单纯的开/关切换：第一次点开并复制，再点收起（之前的写法一旦打开就再也收不起来）
      var open = roWrap.getAttribute("style").indexOf("none") < 0;
      if (open) { roWrap.setAttribute("style", "display:none"); roBtn.textContent = "只读"; return; }
      roWrap.setAttribute("style", "display:block;margin-top:6px;padding-top:8px;border-top:1px solid #1e2532");
      roBtn.textContent = "收起只读";
      if (!state.readonly) { say("还没取到只读链接", CSS.bad); return; }
      roBox.textContent = state.readonly;
      doCopy(state.readonly, roCopy, "只读链接");
    });

    resetBtn.addEventListener("click", function () {
      if (!confirm("重置链接？\n\n当前链接会立即作废（已配对设备不受影响），需要把新链接重新发到手机。")) return;
      say("正在重置…", CSS.mut);
      jpost(API.reset, {}).then(function (r) {
        if (!r || !r.ok) { say("重置失败（需要 owner 权限）", CSS.bad); return; }
        loadLinks();
        var url = (r.owner && r.owner.url) || "";
        var original = resetBtn.textContent;
        copyText(url).then(function (ok) {
          resetBtn.textContent = ok ? "已重置并复制 ✓" : "已重置";
          setTimeout(function () { resetBtn.textContent = original; }, 2500);
          say(ok ? "已重置，新链接已复制 · " + nowText() : "已重置，自动复制失败——请点链接框手动选中", ok ? CSS.ok : CSS.bad);
        });
      });
    });

    function loadLinks() {
      jget(API.links).then(function (d) {
        if (!d || !d.ok) { box.textContent = "（读不到链接：守卫没在运行？）"; say("读取失败", CSS.bad); return; }
        state.owner = (d.owner && d.owner.url) || "";
        state.readonly = (d.readonly && d.readonly.url) || "";
        box.textContent = state.owner || "（无）";
        roBox.textContent = state.readonly || "（无）";
        var when = d.owner && d.owner.createdAt ? new Date(d.owner.createdAt).toLocaleString() : "";
        if (when) say("链接创建于 " + when + " · 长期有效", CSS.mut);
      });
    }

    function loadDevices() {
      jget(API.devices).then(function (d) {
        devList.textContent = "";
        if (!d || !d.devices || !d.devices.length) { devList.appendChild(el("div", CSS.mut, "（还没有设备）")); return; }
        d.devices.forEach(function (dev) {
          var row = el("div", CSS.dev);
          var left = el("div", null);
          left.appendChild(el("div", null, dev.name));
          left.appendChild(el("span", dev.role === "owner" ? CSS.ok : CSS.mut,
            dev.role === "owner" ? "owner · 可发指令 / 看图 / 审批" : "只读 · 只能看"));
          left.appendChild(el("div", CSS.sub, "最近活跃 " + (dev.lastSeenAt ? new Date(dev.lastSeenAt).toLocaleString() : "从未")));
          var del = el("button", CSS.del, "吊销");
          del.addEventListener("click", function () {
            if (!confirm("吊销设备「" + dev.name + "」？它会立刻掉线。")) return;
            jpost(API.revoke, { id: dev.id }).then(function (r) {
              if (r && r.ok) { say("已吊销 " + dev.name, CSS.ok); loadDevices(); }
              else { say("吊销失败：" + ((r && r.error) || "未知原因"), CSS.bad); }
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
    jget(API.status).then(function (st) {
      if (!st || !st.ok) return;
      var t = st.tunnel || {};
      foot.textContent = "隧道：" + (t.url || "未启动") + "　自愈重启 " + (t.restarts || 0) + " 次　在线设备会话 " + (st.sessions || 0);
    });
  }

  /** 和「EAC监控」的悬浮按钮排成一列：贴着它的正上方（同一列 = 相同的 right）。
   *  EAC 按钮的位置不归我们管，所以挂载时动态测量，测不到就用缺省位置；
   *  EAC 可能比我们后挂载，所以短促重试几次。 */
  function placeAboveEac(btn, attempt) {
    attempt = attempt || 0;
    var target = null;
    var divs = document.querySelectorAll("div");
    for (var i = 0; i < divs.length; i++) {
      var e = divs[i];
      if (e.id === "__dsh_remote_button" || !e.firstChild) continue;
      var t = (e.textContent || "").replace(/\s+/g, "");
      if (t.indexOf("EAC监控") === 0 || t.indexOf("EAC监") === 0) {
        try { if (getComputedStyle(e).position === "fixed") { target = e; break; } } catch (err) {}
      }
    }
    if (target) {
      var r = target.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        btn.style.right = Math.max(8, window.innerWidth - r.right) + "px";
        btn.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
        return;
      }
    }
    if (attempt < 10) setTimeout(function () { placeAboveEac(btn, attempt + 1); }, 500);
  }

  function mount() {
    // 插件版（dsh-remote-panel）已经挂过按钮就不要再挂一个，否则手机端会出现两个
    if (document.getElementById("__dsh_remote_button")) return;
    var btn = el("div", CSS.btn, null);
    btn.id = "__dsh_remote_button";
    btn.title = "dsh-remote · 手机链接";
    btn.appendChild(el("span", "width:7px;height:7px;border-radius:50%;background:#3ddc84;display:inline-block"));
    btn.appendChild(el("span", null, "手机链接"));
    btn.addEventListener("click", open);
    document.body.appendChild(btn);
    placeAboveEac(btn);
  }

  function boot() {
    jget(API.status).then(function (st) { if (st && st.ok) mount(); });   // 只读设备拿 403 → 不渲染
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
