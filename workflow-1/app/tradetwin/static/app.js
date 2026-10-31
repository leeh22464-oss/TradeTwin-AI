const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NODE_EMBEDDED = window.location.pathname.startsWith("/sales");
const API_BASE = NODE_EMBEDDED ? "/api/workflow1" : "/api";

const SAMPLES = {
  de: "Sehr geehrte Damen und Herren,\n\nwir möchten die Leuchte NL-L24 mit 36 Watt statt 24 Watt und Schutzart IP44 bestellen, da sie im Badezimmer eingesetzt wird. Den Treiber DRV-A würden wir vorerst beibehalten. Menge: 2000 Stück.\n\nMit freundlichen Grüßen\nAnna Becker",
  en: "Hi, can you do the NL-L24 at 28W with the same housing and same driver? We need 1,500 pcs.\n\nThanks, James",
  zh: "客户想把 NL-L24 改成 36W，用在酒店项目，其他参数还没定。",
};
const STATUS_ZH = {
  INPUT_INCOMPLETE: "信息不全 · 先追问",
  NEEDS_MANUAL_REVIEW: "需人工确认",
  READY_FOR_REVIEW: "可审核发送",
};
const FINDING_ZH = {
  COVERED: "证据覆盖",
  NEEDS_RETEST: "需补测",
  MANUAL_REVIEW: "需人工复核",
  NOT_ENOUGH_EVIDENCE: "证据不足",
  DOCUMENT_UPDATE: "文件更新",
};
const CHANGE_ZH = {
  changed: "已变更", unchanged: "不变", tentative: "暂定", unknown: "未说明",
  missing: "缺失", carried: "沿用上一轮", provided: "已提供",
};
const KIND_ZH = { requested: "按买家要求", new_driver: "更换驱动", within_coverage: "落在覆盖区间内" };
const LANG_ZH = { en: "English", de: "Deutsch" };

const state = {
  health: null,
  view: "mail",
  threadId: null,
  sessionId: new URLSearchParams(window.location.search).get("session_id"),
  buyerName: null,
  subject: null,
  sharedCase: null,
  syncRevision: 0,
  syncStatus: "synced",
  pendingSyncResult: null,
  pendingSyncBody: null,
  channel: "email",
  result: null,
  previous: null,
  lang: "en",
  autoTimer: null,
};

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), isError ? 5000 : 2500);
}

async function api(path, body) {
  const generatesResult = body !== undefined && ["/api/analyze", "/api/instruct", "/api/mail/analyze"].includes(path);
  const revision = generatesResult ? beginSharedSync() : null;
  try {
  const target = path.startsWith("/api/") ? API_BASE + path.slice(4) : path;
  const res = await fetch(target, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (generatesResult && revision !== state.syncRevision) throw new Error("已略过较早请求的结果，请使用当前版本");
  if (!res.ok) {
    const detail = data.detail;
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? "填写格式有误：" + detail.map((d) => d.loc?.slice(-1)[0]).join("、")
      : detail?.message || data.message || data.error || `请求失败（${res.status}）`;
    const err = new Error(message);
    err.payload = detail;
    err.status = res.status;
    throw err;
  }
  return data;
  } catch (error) {
    if (generatesResult && revision === state.syncRevision) publishSyncStatus("error", { message: error.message, retryable: false });
    throw error;
  }
}

function publishSyncStatus(status, extra = {}) {
  state.syncStatus = status;
  if (NODE_EMBEDDED) window.parent.postMessage({ type: "tradetwin:workflow1-result",
    session_id: state.sessionId, shared_case_id: state.sessionId,
    run_id: state.pendingSyncResult?.run_id || null, workflow1QuoteReady: false,
    sync_status: status, sync_revision: state.syncRevision, ...extra }, window.location.origin);
  let box = $("#shared-sync-status");
  if (!box) { box = document.createElement("section"); box.id = "shared-sync-status"; box.className = "card"; $("#center").prepend(box); }
  box.classList.toggle("hidden", status === "synced");
  box.innerHTML = status === "syncing" ? '<p role="status">正在计算并同步当前版本，请稍候…</p>'
    : status === "error" ? `<p role="alert">当前版本尚未同步：${esc(extra.message || "请重试")}</p>${extra.retryable ? '<button id="btn-retry-sync" class="btn primary">重试同步当前结果</button>' : '<p>请重试刚才的分析操作。</p>'}` : "";
  if (status === "error" && extra.retryable) $("#btn-retry-sync").addEventListener("click", (event) => busy(event.target, () => syncSharedCase(state.pendingSyncResult, state.pendingSyncBody)).catch(() => {}));
}

function beginSharedSync(result = null) {
  state.syncRevision += 1;
  state.pendingSyncResult = result;
  state.pendingSyncBody = null;
  publishSyncStatus("syncing");
  return state.syncRevision;
}

async function syncSharedCase(result, retryBody = null) {
  if (!NODE_EMBEDDED) return;
  const revision = beginSharedSync(result);
  state.pendingSyncBody = retryBody || JSON.stringify({ ...result, buyer_name: state.buyerName, subject: state.subject });
  const payload = state.pendingSyncBody;
  try {
    const response = await fetch("/api/workflow1/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const synced = await response.json().catch(() => ({}));
    if (revision !== state.syncRevision || state.sessionId !== result.session_id || state.result?.run_id !== result.run_id) return;
    if (!response.ok) throw new Error(synced.message || `共享案件同步失败（${response.status}）`);
    if (synced.case?.workflow1LastRunId !== result.run_id) throw new Error("案件已有较新版本，请重新载入当前会话");
    state.sharedCase = synced.case;
    publishSyncStatus("synced");
    publishSharedCase(synced.case, Boolean(synced.replay));
    renderSharedHandoff();
  } catch (error) {
    if (revision !== state.syncRevision || state.sessionId !== result.session_id || state.result?.run_id !== result.run_id) return;
    publishSyncStatus("error", { message: error.message, retryable: true });
    toast(error instanceof Error ? error.message : "共享案件同步失败", true);
  }
}

function publishSharedCase(item, replay = false) {
  if (!NODE_EMBEDDED || !item) return;
  window.parent.postMessage({ type: "tradetwin:workflow1-result", session_id: state.sessionId,
    shared_case_id: item.id, run_id: item.workflow1LastRunId,
    sync_status: "synced", sync_revision: state.syncRevision,
    workflow1QuoteReady: item.workflow1QuoteReady === true,
    pending_reason: item.workflow1PendingReason || "", replay }, window.location.origin);
}

function currentResultConfig() {
  const result = state.result;
  if (!result) return null;
  const options = [...result.quote_options, ...(result.candidate_options || [])];
  const option = options.find((o) => o.option_id === result.selected_option_id) || options.find((o) => o.kind === "requested");
  const value = (key) => option && Object.hasOwn(option.config, key) ? option.config[key] : result.change_order.find((row) => row.field === key)?.to;
  return { powerW: value("power_w"), ip: value("ip_rating"), driver: value("driver"),
    quantity: result.change_order.find((row) => row.field === "quantity")?.to ?? option?.quantity };
}

function renderSharedHandoff() {
  const item = state.sharedCase;
  if (!item || item.id !== state.sessionId) { $("#shared-handoff")?.classList.add("hidden"); return; }
  let box = $("#shared-handoff");
  if (!box) {
    box = document.createElement("section"); box.id = "shared-handoff"; box.className = "card";
    $("#center").prepend(box);
  }
  const config = item.requestedConfig;
  const current = currentResultConfig();
  const differs = !current || ["powerW", "ip", "driver"].some((key) => config[key] !== current[key])
    || (current.quantity != null && current.quantity !== item.quantity)
    || config.material !== "original-material" || config.market !== "DE";
  const pending = item.workflow1QuoteReady !== true;
  const editable = differs || pending || !state.result;
  box.classList.remove("hidden");
  box.innerHTML = `<h3>${editable ? (state.result ? "品质配置待应用 / 重新核验" : "确认已有案件配置") : "报价数据已同步"}</h3>
    <p>${esc(pending ? item.workflow1PendingReason || "已同步，等待证据/参数确认" : "报价方案为合成估算，请审核后使用")}</p>
    ${editable ? `<p class="sub">核对以下配置后点击分析；仅打开案件不会创建新一轮买家消息。材料或市场超出当前范围时保持待人工确认。</p>
      <div class="grid2">
      <label class="field">功率 W<input id="handoff-power" type="number" min="0.01" step="any" value="${esc(config.powerW ?? "")}"></label>
      <label class="field">防护等级<input id="handoff-ip" value="${esc(config.ip ?? "")}"></label>
      <label class="field">驱动<input id="handoff-driver" value="${esc(config.driver ?? "")}"></label>
      <label class="field">数量<input id="handoff-quantity" type="number" min="1" value="${esc(item.quantity)}"></label>
      <label class="field">材料<input id="handoff-material" value="${esc(config.material ?? "")}"></label>
      <label class="field">市场<input id="handoff-market" value="${esc(config.market ?? "")}"></label></div>
      <button id="btn-apply-handoff" class="btn primary">${state.result ? "应用配置并重新核验" : "确认配置并分析"}</button>` : ""}`;
  if (editable) $("#btn-apply-handoff").addEventListener("click", (event) => busy(event.target, applySharedHandoff).catch(() => {}));
}

async function applySharedHandoff() {
  const item = state.sharedCase;
  const power = Number($("#handoff-power").value), quantity = Number($("#handoff-quantity").value);
  const ip = $("#handoff-ip").value.trim().toUpperCase(), driver = $("#handoff-driver").value.trim();
  const material = $("#handoff-material").value.trim(), market = $("#handoff-market").value.trim();
  if (!Number.isFinite(power) || power <= 0 || !Number.isInteger(quantity) || quantity < 1 || !/^IP\d{2}$/.test(ip) || !driver) throw new Error("请填写有效功率、IP、驱动及正整数数量");
  beginSharedSync();
  // Persist the user's explicitly confirmed configuration before recomputation.
  // The business workflow supports three technical fields; preserve all others.
  const updated = await fetch(`/api/cases/${encodeURIComponent(item.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: { ...item.requestedConfig, powerW: power, ip, driver, material: material || null, market: market || null }, quantity }) });
  if (!updated.ok) { publishSyncStatus("error", { message: "案件配置保存失败，请重试", retryable: false }); throw new Error("案件配置保存失败，请重试"); }
  state.sharedCase = await updated.json();
  const instruction = `请将配置设为 ${power}W，防护等级 ${ip}，驱动 ${driver}，数量 ${quantity} 件；材料 ${material || "待确认"}；目标市场 ${market || "待确认"}。${item.commitment || ""}`;
  const result = state.result
    ? await api("/api/instruct", { session_id: state.sessionId, instruction })
    : await api("/api/analyze", { session_id: state.sessionId, text: instruction, channel: state.channel,
      buyer_name: state.buyerName, subject: state.subject, source: "quality_handoff" });
  show(result);
}

async function restoreSession() {
  const id = state.sessionId;
  if (!id) return;
  try {
    const session = await api(`/api/session/${encodeURIComponent(id)}`);
    state.buyerName = session.buyer_name; state.subject = session.subject;
    const history = session.history || [];
    const last = session.last_result || history[history.length - 1];
    if (last) {
      if (last.input?.source?.startsWith("email:")) state.threadId = id;
      show(last, false);
      state.previous = history.filter((entry) => entry.run_id !== last.run_id).at(-1) || null;
      renderDiff();
    }
  } catch (error) { if (error.status !== 404) toast(error.message, true); }
  if (!NODE_EMBEDDED) return;
  const response = await fetch(`/api/cases/${encodeURIComponent(id)}`);
  if (!response.ok) return;
  state.sharedCase = await response.json();
  state.buyerName = state.buyerName || state.sharedCase.buyer;
  state.subject = state.subject || state.sharedCase.name;
  state.channel = state.sharedCase.channel === "rfq" ? "alibaba_rfq" : "email";
  $("#manual-buyer").value = state.buyerName || "";
  $("#manual-channel").value = state.channel;
  publishSharedCase(state.sharedCase, true);
  renderSharedHandoff();
}

async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); throw e; } finally { if (btn) btn.disabled = false; }
}

/* ---------- 顶栏 ---------- */
async function loadHealth() {
  const h = await api("/api/health");
  state.health = h;
  const mail = h.mail.mode === "imap" ? `邮箱：${h.mail.address}` : "邮箱：离线演示样例";
  $("#pills").innerHTML = [
    `<span class="pill ${h.mail.mode === "imap" ? "ok" : "warn"}">${esc(mail)}</span>`,
    `<span class="pill ${h.llm_configured ? "ok" : "warn"}">${esc(h.llm_configured ? "模型：" + h.llm : "模型未配置 · 规则模板")}</span>`,
    `<span class="pill ${h.workflow2.ok ? (h.workflow2.provider.startsWith("local") ? "warn" : "ok") : "bad"}" title="${esc(h.workflow2.error || h.workflow2.rule_version || "")}">${esc(
      h.workflow2.ok ? "证据与补测核验：已连接" : "证据与补测核验：暂不可用")}</span>`,
    `<span class="pill">基线 ${esc(h.baseline.model)} ${h.baseline.power_w}W / ${esc(h.baseline.ip_rating)} / ${esc(h.baseline.driver)}</span>`,
  ].join("");
  $("#btn-reset").classList.toggle("hidden", h.mail.mode !== "offline");
}

/* ---------- 邮箱 ---------- */
async function loadThreads(refresh) {
  const data = await api(`/api/mail/threads${refresh ? "?refresh=true" : ""}`);
  state.threads = data.threads;
  const s = data.status;
  $("#mail-status").textContent = s.error ? s.error
    : `${s.mode === "imap" ? "IMAP" : "离线样例"} · 上次同步 ${s.last_sync ? new Date(s.last_sync).toLocaleTimeString() : "—"} · 只读取，不标记已读`;
  $("#threads").innerHTML = data.threads.map((t) => {
    const a = t.analysis;
    const badge = !a ? '<span class="badge new">新询盘</span>'
      : a.up_to_date ? `<span class="badge done">已分析 · 第${a.round}轮</span>`
      : '<span class="badge new">有新回信</span>';
    return `<li class="thread ${t.thread_id === state.threadId ? "active" : ""}" data-id="${esc(t.thread_id)}">
      <div class="meta"><span>${esc(t.buyer_name || t.buyer_addr)}</span>${badge}</div>
      <div class="subj">${esc(t.subject)}</div>
      <div class="prev">${esc(t.preview)}</div>
      <div class="meta"><span>${t.inbound_count} 封来信${t.attachments.length ? " · 附件 " + esc(t.attachments.join(", ")) : ""}</span></div>
    </li>`;
  }).join("") || '<li class="hint">收件箱里没有邮件</li>';
  return data.threads;
}

async function openThread(threadId) {
  state.threadId = threadId;
  state.sessionId = threadId;
  state.channel = "email";
  const thread = state.threads?.find((entry) => entry.thread_id === threadId);
  state.buyerName = thread?.buyer_name || thread?.buyer_addr || null;
  state.subject = thread?.subject || null;
  state.sharedCase = null;
  document.querySelectorAll(".thread").forEach((el) => el.classList.toggle("active", el.dataset.id === threadId));
  const result = await api("/api/mail/analyze", { thread_id: threadId });
  show(result);
  loadThreads(false);
}

/* ---------- 结果渲染 ---------- */
function highlightSource(text, quotes) {
  const ranges = [];
  for (const q of quotes) {
    if (!q) continue;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i >= 0) ranges.push([i, i + q.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "", pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    out += esc(text.slice(pos, s)) + `<mark class="src">${esc(text.slice(s, e))}</mark>`;
    pos = e;
  }
  return out + esc(text.slice(pos));
}

function fmtValue(v) {
  return v === null || v === undefined ? "—" : esc(v);
}

function renderResult(r) {
  const quotes = r.change_order.map((c) => c.source_quote);
  const selected = r.selected_option_id;
  const extractionNote = r.extraction.method === "rules" ? "规则抽取" : "模型抽取 + 规则兜底";

  const changeRows = r.change_order.map((c) => `<tr>
    <td>${esc(c.label)}</td>
    <td>${c.from === null ? "" : fmtValue(c.from) + " → "}<strong>${fmtValue(c.to)}</strong></td>
    <td><span class="st ${esc(c.status)}">${esc(CHANGE_ZH[c.status] || c.status)}</span></td>
    <td class="quote">${c.source_quote ? "“" + esc(c.source_quote) + "”" : ""}</td>
  </tr>`).join("");

  const questions = r.questions.length ? `<div class="card"><h3>需要向买家确认</h3>
    <ol class="questions">${r.questions.map((q) => `<li>${esc(q.zh)}</li>`).join("")}</ol></div>` : "";

  const findings = r.coverage_findings.map((f) => `<div class="finding ${esc(f.status)}">
    <div class="row"><strong>${esc(f.item)}</strong><span class="fs ${esc(f.status)}">${esc(FINDING_ZH[f.status] || f.status)}</span></div>
    <div>${esc(f.reason)}</div>
    ${f.evidence.map((e) => `<div class="ev">证据：<code>${esc(e.document_id)}</code> 第 ${esc(e.page)} 页 · “${esc(e.quote)}”</div>`).join("")}
    <div class="ev">规则：${f.rule_refs.map(esc).join("、")}</div>
  </div>`).join("");

  const opts = r.quote_options.map((o) => `<div class="option ${o.option_id === selected ? "selected" : ""}">
    ${o.fastest ? '<span class="tag">最快</span>' : ""}${o.option_id === selected ? '<span class="tag">买家已选</span>' : ""}
    <h4>方案 ${esc(o.option_id)} · ${esc(KIND_ZH[o.kind] || o.kind)}</h4>
    <div class="cfg">${o.config.power_w}W / ${esc(o.config.ip_rating)} / ${esc(o.config.driver)}</div>
    <div class="big">€${o.unit_price_eur.toFixed(2)}<span class="sub"> /件 × ${o.quantity}</span></div>
    <dl>
      <dt>补测</dt><dd>${o.retest_items.length ? o.retest_items.map((k) => esc(o.findings.find((f) => f.item_key === k)?.item || k)).join("、") : "无"}</dd>
      <dt>合规代价</dt><dd>€${o.estimated_cost_eur.toLocaleString()} · +${o.estimated_days} 工作日</dd>
      <dt>拆分</dt><dd>样品 ${o.days_breakdown.new_driver_sample} + 实验室并行 ${o.days_breakdown.lab_parallel} + 文件 ${o.days_breakdown.document_update}</dd>
      <dt>交期</dt><dd>${o.lead_time_working_days} 工作日</dd>
      <dt>文件</dt><dd>${o.document_updates.map(esc).join("、") || "无"}</dd>
    </dl>
    <div class="sub">${esc(o.assumption)}</div>
    <div class="synthetic">合成估算 · 待人工确认</div>
  </div>`).join("");

  const actions = r.owner_actions.map((a) => `<li><span class="owner">${esc(a.owner_label)}</span><span>${esc(a.action)}</span></li>`).join("");

  $("#result").innerHTML = `
    <div class="result-head">
      <div>
        <h2>${esc(r.input.source.startsWith("email:") ? "邮件询盘" : r.kind === "instruction" ? "业务员修改" : "询盘分析")} · 第 ${r.round} 轮</h2>
        <div class="sub">${esc(r.scope.market)} · ${esc(extractionNote)} · 原文语言 ${esc(r.extraction.language)} · ${esc(r.run_id)}${r.idempotent_replay ? " · 命中缓存（相同输入不重复计算）" : ""}</div>
      </div>
      <span class="status ${esc(r.status)}">${esc(STATUS_ZH[r.status] || r.status)}</span>
    </div>
    <div class="card"><h3>${r.kind === "instruction" ? "本轮指令" : "买家原文"}</h3>
      <div class="source">${r.kind === "instruction" ? esc(r.input.text) : highlightSource(r.input.text, quotes)}</div>
      ${r.extraction.warnings?.length ? `<div class="sub">⚠ ${r.extraction.warnings.map(esc).join("；")}</div>` : ""}
    </div>
    <div class="card"><h3>变更单</h3>
      <table><thead><tr><th>字段</th><th>基线 → 目标</th><th>状态</th><th>原文出处</th></tr></thead><tbody>${changeRows}</tbody></table>
    </div>
    ${questions}
    <div class="card"><h3>证据覆盖与最小补测 <span class="sub">${r.workflow2.rule_version ? " · 规则 " + esc(r.workflow2.rule_version) : ""}</span></h3>
      ${r.workflow2.ok ? "" : `<div class="wf2-error">工作流二暂不可用，本轮不报价，只发过渡回复：${esc(r.workflow2.error)}</div>`}
      ${r.workflow2.warnings.map((w) => `<div class="sub">⚠ ${esc(w)}</div>`).join("")}
      <div class="findings">${findings || '<span class="sub">暂无结论</span>'}</div>
      ${r.consistency_issues.length ? `<h4 style="margin-top:10px">跨文件一致性问题（仅内部可见）</h4>${r.consistency_issues.map((i) => `<div class="finding MANUAL_REVIEW"><div>${esc(i.finding || i.message || JSON.stringify(i))}</div>${(i.evidence || []).map((e) => `<div class="ev"><code>${esc(e.document_id)}</code> 第 ${esc(e.page)} 页 · “${esc(e.quote)}”</div>`).join("")}</div>`).join("")}` : ""}
    </div>
    ${opts ? `<div class="card"><h3>报价方案（合规代价已计入）</h3><div class="options">${opts}</div></div>` : ""}
    ${!opts && r.candidate_options?.length ? `<div class="card"><h3>待核验的候选配置</h3>${r.candidate_options.map((option) => `<p>方案 ${esc(option.option_id)} · ${esc(option.config.power_w)}W / ${esc(option.config.ip_rating)} / ${esc(option.config.driver)} · 等待证据/参数确认后计算费用与交期</p>`).join("")}</div>` : ""}
    <div class="card"><h3>内部待办</h3><ul class="actions">${actions}</ul></div>
    <ul class="assump">${r.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
}

function renderReplyTabs() {
  const langs = Object.keys(state.result.replies);
  if (!langs.includes(state.lang)) state.lang = langs[0];
  $("#lang-tabs").innerHTML = langs.map((l) => {
    const lvl = state.result.replies[l].check.level;
    return `<button class="tab ${l === state.lang ? "active" : ""}" data-lang="${l}">${LANG_ZH[l] || l} <span class="level ${lvl}">${lvl === "green" ? "通过" : lvl === "yellow" ? "注意" : "风险"}</span></button>`;
  }).join("");
  const reply = state.result.replies[state.lang];
  $("#reply-subject").value = reply.subject;
  $("#reply-body").value = reply.body;
  renderCheck(reply.check, reply.body, reply);
  renderDiff();
}

function renderCheck(check, text, reply) {
  const anns = [...check.annotations].sort((a, b) => a.start - b.start);
  let html = "", pos = 0;
  for (const a of anns) {
    if (a.start < pos) continue;
    html += esc(text.slice(pos, a.start)) + `<mark class="${esc(a.severity)}" title="${esc(a.message)}">${esc(text.slice(a.start, a.end))}</mark>`;
    pos = a.end;
  }
  html += esc(text.slice(pos));
  const levelZh = { green: "未发现问题", yellow: "有需要注意的地方", red: "存在高风险问题，发送前必须修改" }[check.level];
  const gen = reply ? `<div class="gen">生成方式：${reply.generator === "llm" ? "模型润色（已通过校验）" : "规则模板"}${reply.fallback_reason ? ` · <span class="warn">${esc(reply.fallback_reason)}</span>` : ""}</div>` : "";
  $("#check-box").innerHTML = `${gen}
    <div class="check-head"><span class="level ${check.level}">${esc(levelZh)}</span>
      <span class="sub">高 ${check.counts.high} · 中 ${check.counts.medium} · 低 ${check.counts.low}</span></div>
    ${anns.length ? `<div class="annotated">${html}</div><ul class="issues">${anns.map((a) => `<li><span class="cat">${esc(a.category)}</span><span>${esc(a.message)}${a.basis ? ` <span class="sub">（${esc(a.basis)}）</span>` : ""}</span></li>`).join("")}</ul>` : ""}`;
}

function lineDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(["same", x[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["del", x[i++]]);
    else out.push(["add", y[j++]]);
  }
  while (i < n) out.push(["del", x[i++]]);
  while (j < m) out.push(["add", y[j++]]);
  return out;
}

function renderDiff() {
  const prev = state.previous?.replies?.[state.lang];
  const box = $("#diff-box");
  if (!prev) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const cur = state.result.replies[state.lang].body;
  const rows = lineDiff(prev.body, cur).filter(([k, t]) => k !== "same" || t.trim());
  $("#diff").innerHTML = rows.map(([k, t]) => `<span class="${k}">${k === "add" ? "+ " : k === "del" ? "- " : "  "}${esc(t)}</span>`).join("");
}

function show(result, synchronize = true) {
  if (state.result && state.result.session_id === result.session_id && state.result.run_id !== result.run_id) {
    state.previous = state.result;
  } else if (!state.result || state.result.session_id !== result.session_id) {
    state.previous = null;
  }
  state.result = result;
  state.sessionId = result.session_id;
  state.channel = result.channel;
  const location = new URL(window.location.href);
  location.searchParams.set("session_id", state.sessionId);
  window.history.replaceState(null, "", location);
  const detected = result.extraction.language;
  if (result.round === 1 && result.replies[detected]) state.lang = detected;

  $("#empty").classList.add("hidden");
  $("#result").classList.remove("hidden");
  $("#reply-empty").classList.add("hidden");
  $("#reply").classList.remove("hidden");
  renderResult(result);
  renderReplyTabs();

  const isMail = Boolean(state.threadId) && result.session_id === state.threadId;
  $("#btn-draft").classList.toggle("hidden", !isMail);
  $("#btn-simulate").classList.toggle("hidden", !(isMail && state.health?.mail.mode === "offline"));
  if (synchronize) void syncSharedCase(result);
}

/* ---------- 事件 ---------- */
document.querySelectorAll(".left .tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".left .tab").forEach((b) => b.classList.toggle("active", b === btn));
  state.view = btn.dataset.tab;
  $("#tab-mail").classList.toggle("hidden", state.view !== "mail");
  $("#tab-manual").classList.toggle("hidden", state.view !== "manual");
}));

$("#threads").addEventListener("click", (e) => {
  const li = e.target.closest(".thread");
  if (li) busy(null, () => openThread(li.dataset.id)).catch(() => {});
});

$("#btn-sync").addEventListener("click", (e) => busy(e.target, () => loadThreads(true)).catch(() => {}));
$("#btn-reset").addEventListener("click", (e) => busy(e.target, async () => {
  await api("/api/mail/reset", {});
  state.threadId = null; state.sessionId = null; state.result = null; state.previous = null;
  state.sharedCase = null; state.buyerName = null; state.subject = null;
  $("#shared-handoff")?.classList.add("hidden");
  $("#result").classList.add("hidden"); $("#empty").classList.remove("hidden");
  $("#reply").classList.add("hidden"); $("#reply-empty").classList.remove("hidden");
  await loadThreads(false);
  toast("演示已重置");
}).catch(() => {}));

$("#auto-sync").addEventListener("change", (e) => {
  clearInterval(state.autoTimer);
  if (e.target.checked) state.autoTimer = setInterval(() => loadThreads(true).catch(() => {}), 30000);
});

document.querySelectorAll("[data-sample]").forEach((b) => b.addEventListener("click", () => {
  $("#manual-text").value = SAMPLES[b.dataset.sample];
}));

$("#btn-manual").addEventListener("click", (e) => busy(e.target, async () => {
  state.threadId = null;
  const result = await api("/api/analyze", {
    session_id: state.sessionId,
    text: $("#manual-text").value,
    channel: $("#manual-channel").value,
    buyer_name: $("#manual-buyer").value || null,
    subject: state.subject,
    source: "manual",
  });
  state.buyerName = $("#manual-buyer").value || state.buyerName;
  show(result);
}).catch(() => {}));

$("#lang-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-lang]");
  if (!btn) return;
  state.lang = btn.dataset.lang;
  renderReplyTabs();
});

$("#btn-check").addEventListener("click", (e) => busy(e.target, async () => {
  const text = $("#reply-body").value;
  const check = await api("/api/check", { text, session_id: state.sessionId, channel: state.channel });
  renderCheck(check, text, null);
  toast(check.level === "green" ? "校验通过" : "已标出需要修改的地方");
}).catch(() => {}));

$("#btn-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#reply-body").value);
  toast("已复制正文");
});

$("#btn-draft").addEventListener("click", (e) => busy(e.target, async () => {
  try {
    const saved = await api("/api/mail/draft", {
      thread_id: state.threadId, language: state.lang,
      subject: $("#reply-subject").value, body: $("#reply-body").value,
    });
    toast(saved.mode === "imap" ? `已存入邮箱草稿箱「${saved.saved_to}」，请在邮箱中检查后发送` : "离线模式：草稿已保存到 runtime/outbox");
  } catch (err) {
    if (err.payload?.check) renderCheck(err.payload.check, $("#reply-body").value, null);
    throw err;
  }
}).catch(() => {}));

$("#btn-r2").addEventListener("click", (e) => busy(e.target, async () => {
  const text = $("#r2-text").value.trim();
  if (!text) throw new Error("请输入内容");
  const kind = document.querySelector("input[name=r2kind]:checked").value;
  const result = kind === "instruction"
    ? await api("/api/instruct", { session_id: state.sessionId, instruction: text })
    : await api("/api/analyze", { text, session_id: state.sessionId, channel: state.channel, source: "manual_followup" });
  $("#r2-text").value = "";
  show(result);
  $("#diff-box").open = true;
}).catch(() => {}));

$("#btn-simulate").addEventListener("click", (e) => busy(e.target, async () => {
  const r = await api("/api/mail/simulate-reply", { thread_id: state.threadId });
  toast(`收到买家回信：${r.subject}`);
  await openThread(state.threadId);
  $("#diff-box").open = true;
}).catch(() => {}));

/* ---------- 邮箱设置 ---------- */
const PRESETS = {
  qq: { imap_host: "imap.qq.com", domains: ["qq.com", "foxmail.com"],
    help: "QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP 服务，按提示验证后生成授权码。回复仅保存为草稿。" },
  163: { imap_host: "imap.163.com", domains: ["163.com"],
    help: "163 网页版 → 设置 → 客户端服务 → 开启 IMAP 服务 → 新增授权密码。" },
  126: { imap_host: "imap.126.com", domains: ["126.com"],
    help: "126 网页版 → 设置 → 客户端服务 → 开启 IMAP 服务 → 新增授权密码。" },
  exmail: { imap_host: "imap.exmail.qq.com", domains: [],
    help: "腾讯企业邮 → 设置 → 客户端设置 → 开启 IMAP；如开启了安全登录，需生成“客户端专用密码”。" },
  aliyun: { imap_host: "imap.qiye.aliyun.com", domains: [],
    help: "阿里企业邮 → 设置 → 客户端设置 → 开启 IMAP（可能需要管理员允许），使用邮箱密码或三方客户端安全密码。" },
  gmail: { imap_host: "imap.gmail.com", domains: ["gmail.com", "googlemail.com"],
    help: "Gmail 设置中启用 IMAP；Google 账号先开启两步验证，再到“安全性 → 应用专用密码”生成 16 位密码。" },
};
const DEFAULT_HELP = "先在邮箱网页版的设置里开启 IMAP 服务，生成授权码。回复仅存为草稿，请在邮箱中检查后发送。";
const form = $("#mail-form");
const fieldNames = ["user", "password", "imap_host", "imap_port", "drafts_folder", "signature"];

function formData() {
  const data = {};
  for (const n of fieldNames) data[n] = form.elements[n].value.trim();
  data.imap_port = Number(data.imap_port) || 993;
  return data;
}

function applyPreset(key) {
  const p = PRESETS[key];
  $("#mail-help").textContent = p ? p.help : DEFAULT_HELP;
  if (!p) return;
  form.elements.imap_host.value = p.imap_host;
  form.elements.imap_port.value = 993;
}

function showTest(result, error) {
  const box = $("#mail-test");
  if (error) { box.innerHTML = `<div class="fail">${esc(error)}</div>`; return; }
  const rows = [];
  const imap = result.imap;
  rows.push(`<div class="${imap.ok ? "ok" : "fail"}">收信：${esc(imap.message)}${imap.drafts ? ` · 草稿箱「${esc(imap.drafts)}」` : ""}</div>`);
  if (imap.drafts_error || imap.warning) rows.push(`<div class="warn">${esc(imap.warning || imap.drafts_error)}</div>`);
  box.innerHTML = rows.join("");
}

async function openSettings() {
  const data = await api("/api/settings/mail");
  const s = data.settings;
  for (const n of fieldNames) if (n !== "password") form.elements[n].value = s[n] ?? "";
  form.elements.password.value = "";
  form.elements.password.placeholder = s.has_password ? "已保存（留空表示不修改）" : "邮箱生成的授权码";
  const preset = Object.entries(PRESETS).find(([, p]) => p.imap_host === s.imap_host);
  $("#mail-preset").value = preset ? preset[0] : "";
  $("#mail-help").textContent = preset ? preset[1].help : DEFAULT_HELP;
  $("#mail-source").textContent = { ui: "当前：界面设置", env: "当前：.env 配置", none: "当前：离线演示样例" }[s.source];
  $("#mail-test").innerHTML = "";
  $("#mail-dialog").showModal();
}

async function dialogAction(btn, fn) {
  btn.disabled = true;
  $("#mail-test").innerHTML = '<div class="warn">处理中…</div>';
  try { await fn(); } catch (e) { showTest(e.payload?.test, e.payload?.test ? null : e.message); if (e.payload?.test) $("#mail-test").insertAdjacentHTML("afterbegin", `<div class="fail">${esc(e.message)}</div>`); }
  finally { btn.disabled = false; }
}

$("#btn-settings").addEventListener("click", () => openSettings().catch((e) => toast(e.message, true)));
$("#mail-preset").addEventListener("change", (e) => applyPreset(e.target.value));
form.elements.user.addEventListener("change", (e) => {
  const domain = e.target.value.split("@")[1]?.toLowerCase();
  const hit = Object.entries(PRESETS).find(([, p]) => p.domains.includes(domain));
  if (hit && !form.elements.imap_host.value) { $("#mail-preset").value = hit[0]; applyPreset(hit[0]); }
});
$("#mail-test-btn").addEventListener("click", (e) => dialogAction(e.target, async () => {
  showTest(await api("/api/settings/mail/test", formData()));
}));
$("#mail-save").addEventListener("click", (e) => dialogAction(e.target, async () => {
  const r = await api("/api/settings/mail", formData());
  showTest(r.test);
  $("#mail-source").textContent = "当前：界面设置";
  await loadHealth();
  await loadThreads(false);
  $("#mail-test").insertAdjacentHTML("beforeend", `<div class="ok">已保存，收件箱已同步。可以关闭窗口了。</div>`);
}));
$("#mail-clear").addEventListener("click", (e) => dialogAction(e.target, async () => {
  if (!confirm("清除界面里保存的邮箱设置？（.env 中的配置不受影响）")) { $("#mail-test").innerHTML = ""; return; }
  await api("/api/settings/mail/clear", {});
  await loadHealth();
  await loadThreads(true).catch(() => {});
  $("#mail-dialog").close();
  toast("已清除邮箱设置");
}));
$("#mail-close").addEventListener("click", () => $("#mail-dialog").close());

(async () => {
  await loadHealth().catch((e) => toast("后端未启动：" + e.message, true));
  await loadThreads(false).catch(() => {});
  await restoreSession().catch((error) => toast(error.message, true));
})();
