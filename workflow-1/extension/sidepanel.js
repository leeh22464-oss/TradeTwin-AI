const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_ZH = { INPUT_INCOMPLETE: "信息不全 · 先追问", NEEDS_MANUAL_REVIEW: "需人工确认", READY_FOR_REVIEW: "可审核发送" };
const LEVEL_ZH = { green: "未发现问题", yellow: "有需要注意的地方", red: "高风险，发送前必须修改" };
const state = { backend: "http://127.0.0.1:3001/api/workflow1", sessions: {}, result: null, lang: "en", pageKey: null, tabId: null, identity: null, resultPageKey: null, sourceUrl: null };

function isAlibabaUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && (parsed.hostname === "alibaba.com" || parsed.hostname.endsWith(".alibaba.com"));
  } catch { return false; }
}

function updateCaptureAvailability() {
  $("#btn-capture").disabled = !state.sourceUrl || !isAlibabaUrl(state.sourceUrl) || !$("#input").value.trim();
}
updateCaptureAvailability();

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), isError ? 5000 : 2500);
}

async function api(path, body) {
  const base = state.backend.replace(/\/+$/, "");
  const endpoint = path.replace(/^\/?api\//, "").replace(/^\//, "");
  const prefix = /\/api(?:\/workflow1)?$/.test(base) ? base : base + "/api";
  const res = await fetch(prefix + "/" + endpoint, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || data.message || `请求失败（${res.status}）`);
  return data;
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("没有找到当前标签页");
  return tab;
}

async function sendToPage(message, tab = null) {
  tab = tab || await activeTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function captureIdentity(tab, page) {
  // Unknown identity is intentionally single-use: a buyer switch in an SPA
  // cannot otherwise be distinguished from another turn on the same pathname.
  state.tabId = tab.id;
  state.identity = page?.conversationKey || null;
  state.pageKey = state.identity || `tab=${tab.id}:capture=${crypto.randomUUID()}`;
  return state.pageKey;
}

async function currentPage() {
  const tab = await activeTab();
  const page = await sendToPage({ type: "tt-read" }, tab).catch(() => null);
  return { tab, page };
}

async function verifyReplyPage() {
  const { tab, page } = await currentPage();
  if (!state.identity || state.tabId !== tab.id || page?.conversationKey !== state.identity
    || (state.result && state.resultPageKey !== state.pageKey)) throw new Error("买家身份未确认或已变化，请复制草稿并手动核对后粘贴");
  return { tab, conversationKey: page.conversationKey };
}

async function saveSessions() {
  await chrome.storage.local.set({ sessions: state.sessions, backend: state.backend });
}

async function checkBackend() {
  try {
    const h = await api("/api/health");
    $("#conn").textContent = h.llm_configured ? `已连接 · ${h.llm}` : "已连接 · 规则模板";
    $("#conn").className = "pill ok";
  } catch {
    $("#conn").textContent = "后端未启动";
    $("#conn").className = "pill err";
  }
}

function renderSummary(r) {
  const changes = r.change_order.filter((c) => ["power_w", "ip_rating", "driver", "quantity"].includes(c.field))
    .map((c) => `${esc(c.label)}：${c.from !== null ? esc(c.from) + " → " : ""}<b>${esc(c.to ?? "—")}</b>`).join("<br>");
  const opts = r.quote_options.map((o) => `<div class="opt"><b>方案 ${esc(o.option_id)}</b> ${o.config.power_w}W / ${esc(o.config.ip_rating)} / ${esc(o.config.driver)}
    ${o.option_id === r.selected_option_id ? " · 已选" : ""}${o.fastest ? " · 最快" : ""}<br>
    <span class="muted">€${o.unit_price_eur.toFixed(2)}/件 · 交期 ${o.lead_time_working_days} 工作日 · 补测 €${o.estimated_cost_eur} / +${o.estimated_days} 天</span></div>`).join("");
  const qs = r.questions.length ? `<div class="muted">需追问：</div><ul>${r.questions.map((q) => `<li>${esc(q.zh)}</li>`).join("")}</ul>` : "";
  $("#summary").innerHTML = `<div class="status">${esc(STATUS_ZH[r.status] || r.status)} · 第 ${r.round} 轮</div>
    <div class="muted">${r.extraction.method === "rules" ? "规则抽取" : "模型抽取 + 规则兜底"} · 费用为合成估算，待确认</div>
    <div style="margin-top:6px">${changes}</div>${qs}${opts}`;
  $("#summary").classList.remove("hidden");
}

function renderCheck(check) {
  $("#check").innerHTML = `<span class="level ${check.level}">${esc(LEVEL_ZH[check.level])}</span>
    ${check.annotations.length ? `<ul>${check.annotations.map((a) => `<li class="issue">“${esc(a.text)}” — ${esc(a.message)} <code>${esc(a.category)}</code></li>`).join("")}</ul>` : ""}`;
}

function renderReply() {
  const langs = Object.keys(state.result.replies);
  if (!langs.includes(state.lang)) state.lang = langs[0];
  $("#lang-tabs").innerHTML = langs.map((l) => `<button class="tab ${l === state.lang ? "active" : ""}" data-lang="${l}">${l === "de" ? "Deutsch" : "English"}</button>`).join("");
  const reply = state.result.replies[state.lang];
  $("#reply-body").value = reply.body;
  renderCheck(reply.check);
  $("#reply").classList.remove("hidden");
}

async function show(result, key) {
  state.result = result;
  state.resultPageKey = key;
  if (result.round === 1 && result.replies[result.extraction.language]) state.lang = result.extraction.language;
  if (key) { state.sessions[key] = result.session_id; await saveSessions(); }
  renderSummary(result);
  renderReply();
  await syncResult(result);
}

async function syncResult(result) {
  if (/\/api\/workflow1\/?$/.test(state.backend)) {
    try {
      await api("/sync", result);
      $("#sync-notice").textContent = "已同步到品质队列";
      $("#btn-sync").classList.add("hidden");
    } catch (error) {
      $("#sync-notice").textContent = "分析已保留，同步品质队列失败；可重试同步";
      $("#btn-sync").classList.remove("hidden");
      throw new Error(`同步品质队列失败：${error.message}。请点击重试同步。`);
    }
  } else {
    $("#sync-notice").textContent = "独立开发模式：未同步品质队列";
    $("#btn-sync").classList.add("hidden");
  }
}

$("#btn-sync").addEventListener("click", (e) => busy(e.target, async () => {
  if (!state.result) throw new Error("没有可同步的分析结果");
  await syncResult(state.result);
}));

async function frameSelection(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => String(window.getSelection() || "").trim(),
  });
  return results.map((r) => r.result).find(Boolean) || "";
}

$("#btn-read").addEventListener("click", (e) => busy(e.target, async () => {
  const { tab, page } = await currentPage();
  const selection = page?.selection || await frameSelection(tab.id).catch(() => "");
  const text = selection || page?.recent || "";
  if (!text) throw new Error("没读到可确认的买家消息：请选中消息或手动粘贴");
  $("#input").value = text;
  captureIdentity(tab, page);
  $("#channel").value = /^https:\/\/([^/]+\.)?alibaba\.com\//i.test(tab.url || "") ? "alibaba_rfq" : "email";
  const notice = `已读取${selection ? "选中文字" : "最近一条可确认的买家消息"}；请核对或编辑，再点击分析`;
  state.sourceUrl = tab.url;
  $("#source-notice").textContent = notice;
  updateCaptureAvailability();
  toast(notice);
}));

$("#input").addEventListener("input", updateCaptureAvailability);

$("#btn-capture").addEventListener("click", (e) => busy(e.target, async () => {
  const text = $("#input").value.trim();
  if (!text || !state.sourceUrl || !isAlibabaUrl(state.sourceUrl)) throw new Error("请先从 HTTPS Alibaba 页面读取或确认询盘文本");
  const { tab, page } = await currentPage();
  if (tab.url !== state.sourceUrl || (state.identity && page?.conversationKey !== state.identity)) throw new Error("来源页面或买家会话已变化，请重新读取并核对后提交");
  const backend = new URL(state.backend);
  if (backend.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(backend.hostname)
    || !/\/api\/workflow1\/?$/.test(backend.pathname)) throw new Error("提交捕获需要连接本机 TradeTwin Node 服务");
  const response = await fetch(`${backend.origin}/api/extension/captures`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source_url: state.sourceUrl, ...(state.identity ? { conversation_key: state.identity } : {}), ...(state.pageKey ? { page_key: state.pageKey } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `提交失败（${response.status}）`);
  $("#input").value = "";
  state.sourceUrl = null;
  updateCaptureAvailability();
  $("#source-notice").textContent = `已提交到新建询盘待选列表 · ${data.id || "等待导入"}`;
  toast("已提交；请在新建询盘中预览并导入");
}));

$("#btn-analyze").addEventListener("click", (e) => busy(e.target, async () => {
  const text = $("#input").value.trim();
  if (!text) throw new Error("请先读取页面或粘贴买家消息");
  const { tab, page } = await currentPage();
  if (state.pageKey && (state.tabId !== tab.id || (state.identity && page?.conversationKey !== state.identity))) {
    throw new Error("当前买家或标签页已变化，请重新读取并核对消息后分析");
  }
  const key = captureIdentity(tab, page);
  const result = await api("/api/analyze", {
    text, channel: $("#channel").value, session_id: state.sessions[key] || null, source: "extension",
  });
  await show(result, key);
}));

$("#btn-new").addEventListener("click", async () => {
  if (!state.pageKey) { const { tab, page } = await currentPage(); captureIdentity(tab, page); }
  delete state.sessions[state.pageKey];
  await saveSessions();
  state.result = null;
  $("#summary").classList.add("hidden");
  $("#reply").classList.add("hidden");
  $("#input").value = "";
  $("#source-notice").textContent = "已清空；读取或粘贴后可编辑，点击分析才会处理";
  toast("已开始新会话");
});

$("#lang-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lang]");
  if (!b) return;
  state.lang = b.dataset.lang;
  renderReply();
});

$("#btn-insert").addEventListener("click", (e) => busy(e.target, async () => {
  const text = $("#reply-body").value;
  const r = await verifyReplyPage().then(({ tab, conversationKey }) =>
    sendToPage({ type: "tt-insert", text, expectedConversationKey: conversationKey }, tab)).catch(() => null);
  if (r?.ok) return toast("已填入回复框，请检查后自己点击发送");
  await navigator.clipboard.writeText(text);
  toast("无法确认当前买家或聊天回复框，已复制到剪贴板，请核对后手动粘贴");
}));

$("#btn-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#reply-body").value);
  toast("已复制");
});

$("#btn-check").addEventListener("click", (e) => busy(e.target, async () => {
  const check = await api("/api/check", { text: $("#reply-body").value, session_id: state.result?.session_id, channel: $("#channel").value });
  renderCheck(check);
}));

$("#btn-review-mine").addEventListener("click", (e) => busy(e.target, async () => {
  const r = await sendToPage({ type: "tt-read-draft" });
  if (!r?.text?.trim()) throw new Error("回复框是空的，先在页面上写好你的回复");
  $("#reply-body").value = r.text;
  $("#reply").classList.remove("hidden");
  const check = await api("/api/check", { text: r.text, session_id: state.result?.session_id, channel: $("#channel").value });
  renderCheck(check);
  toast(check.level === "green" ? "你的回复没有发现问题" : "已标出需要修改的地方");
}));

$("#btn-instruct").addEventListener("click", (e) => busy(e.target, async () => {
  if (!state.result) throw new Error("请先分析一条买家消息");
  const instruction = $("#instruction").value.trim();
  if (!instruction) throw new Error("请输入修改指令");
  await verifyReplyPage();
  await show(await api("/api/instruct", { session_id: state.result.session_id, instruction }), state.resultPageKey);
  $("#instruction").value = "";
}));

$("#backend").addEventListener("change", async (e) => {
  state.backend = e.target.value.replace(/\/$/, "");
  await saveSessions();
  checkBackend();
});

(async () => {
  const saved = await chrome.storage.local.get(["sessions", "backend"]);
  state.sessions = saved.sessions || {};
  if (saved.backend) { state.backend = saved.backend; $("#backend").value = saved.backend; }
  checkBackend();
})();
