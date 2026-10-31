const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  sessionId: null,
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
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? "填写格式有误：" + detail.map((d) => d.loc?.slice(-1)[0]).join("、")
      : detail?.message || `请求失败（${res.status}）`;
    const err = new Error(message);
    err.payload = detail;
    throw err;
  }
  return data;
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
      h.workflow2.ok ? "工作流二：" + (h.workflow2.provider.startsWith("local") ? "本地参考实现" : h.workflow2.provider) : "工作流二不可用")}</span>`,
    `<span class="pill">基线 ${esc(h.baseline.model)} ${h.baseline.power_w}W / ${esc(h.baseline.ip_rating)} / ${esc(h.baseline.driver)}</span>`,
  ].join("");
  $("#btn-reset").classList.toggle("hidden", h.mail.mode !== "offline");
}

/* ---------- 邮箱 ---------- */
async function loadThreads(refresh) {
  const data = await api(`/api/mail/threads${refresh ? "?refresh=true" : ""}`);
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
    <div class="card"><h3>证据覆盖与最小补测 <span class="sub">· 来自工作流二 ${esc(r.workflow2.provider)}${r.workflow2.rule_version ? " · " + esc(r.workflow2.rule_version) : ""}</span></h3>
      ${r.workflow2.ok ? "" : `<div class="wf2-error">工作流二暂不可用，本轮不报价，只发过渡回复：${esc(r.workflow2.error)}</div>`}
      ${r.workflow2.warnings.map((w) => `<div class="sub">⚠ ${esc(w)}</div>`).join("")}
      <div class="findings">${findings || '<span class="sub">暂无结论</span>'}</div>
      ${r.consistency_issues.length ? `<h4 style="margin-top:10px">跨文件一致性问题（仅内部可见）</h4>${r.consistency_issues.map((i) => `<div class="finding MANUAL_REVIEW"><div>${esc(i.finding || i.message || JSON.stringify(i))}</div>${(i.evidence || []).map((e) => `<div class="ev"><code>${esc(e.document_id)}</code> 第 ${esc(e.page)} 页 · “${esc(e.quote)}”</div>`).join("")}</div>`).join("")}` : ""}
    </div>
    ${opts ? `<div class="card"><h3>报价方案（合规代价已计入）</h3><div class="options">${opts}</div></div>` : ""}
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

function show(result) {
  if (state.result && state.result.session_id === result.session_id && state.result.run_id !== result.run_id) {
    state.previous = state.result;
  } else if (!state.result || state.result.session_id !== result.session_id) {
    state.previous = null;
  }
  state.result = result;
  state.sessionId = result.session_id;
  state.channel = result.channel;
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
  $("#btn-send").classList.toggle("hidden", !(isMail && state.health?.mail.mode === "imap" && state.health?.mail.smtp_configured));
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
  state.threadId = null; state.result = null; state.previous = null;
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
    text: $("#manual-text").value,
    channel: $("#manual-channel").value,
    buyer_name: $("#manual-buyer").value || null,
    source: "manual",
  });
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

/* ---------- 发送 ---------- */
$("#btn-send").addEventListener("click", (e) => busy(e.target, async () => {
  const subject = $("#reply-subject").value, body = $("#reply-body").value;
  const thread = (await api(`/api/mail/thread/${encodeURIComponent(state.threadId)}`));
  const to = thread.buyer_addr;
  if (!confirm(`确认把这封回复发送给 ${to}？\n\n主题：${subject}\n\n发送后无法撤回。金额和交期仍是待确认的估算。`)) return;
  try {
    const sent = await api("/api/mail/send", { thread_id: state.threadId, language: state.lang, subject, body });
    toast(`已发送给 ${sent.to}`);
  } catch (err) {
    if (err.payload?.check) renderCheck(err.payload.check, body, null);
    throw err;
  }
}).catch(() => {}));

/* ---------- 邮箱设置 ---------- */
const PRESETS = {
  qq: { imap_host: "imap.qq.com", smtp_host: "smtp.qq.com", domains: ["qq.com", "foxmail.com"],
    help: "QQ 邮箱网页版 → 设置 → 账号 → 找到“POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务”→ 开启 IMAP/SMTP，按提示发短信验证后得到授权码。" },
  163: { imap_host: "imap.163.com", smtp_host: "smtp.163.com", domains: ["163.com"],
    help: "163 网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 新增授权密码。" },
  126: { imap_host: "imap.126.com", smtp_host: "smtp.126.com", domains: ["126.com"],
    help: "126 网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 新增授权密码。" },
  exmail: { imap_host: "imap.exmail.qq.com", smtp_host: "smtp.exmail.qq.com", domains: [],
    help: "腾讯企业邮 → 设置 → 客户端设置 → 开启 IMAP/SMTP；如开启了安全登录，需生成“客户端专用密码”。" },
  aliyun: { imap_host: "imap.qiye.aliyun.com", smtp_host: "smtp.qiye.aliyun.com", domains: [],
    help: "阿里企业邮 → 设置 → 客户端设置 → 开启 IMAP/SMTP（可能需要管理员允许），使用邮箱密码或三方客户端安全密码。" },
  gmail: { imap_host: "imap.gmail.com", smtp_host: "smtp.gmail.com", domains: ["gmail.com", "googlemail.com"],
    help: "Gmail 设置中启用 IMAP；Google 账号先开启两步验证，再到“安全性 → 应用专用密码”生成 16 位密码。" },
};
const DEFAULT_HELP = "先在邮箱网页版的设置里开启 IMAP/SMTP 服务，生成授权码。";
const form = $("#mail-form");
const fieldNames = ["user", "password", "imap_host", "imap_port", "drafts_folder", "smtp_host", "smtp_port", "smtp_security", "signature"];

function formData() {
  const data = {};
  for (const n of fieldNames) data[n] = form.elements[n].value.trim();
  data.imap_port = Number(data.imap_port) || 993;
  data.smtp_port = Number(data.smtp_port) || 465;
  return data;
}

function applyPreset(key) {
  const p = PRESETS[key];
  $("#mail-help").textContent = p ? p.help : DEFAULT_HELP;
  if (!p) return;
  form.elements.imap_host.value = p.imap_host;
  form.elements.imap_port.value = 993;
  form.elements.smtp_host.value = p.smtp_host;
  form.elements.smtp_port.value = 465;
  form.elements.smtp_security.value = "ssl";
}

function showTest(result, error) {
  const box = $("#mail-test");
  if (error) { box.innerHTML = `<div class="fail">${esc(error)}</div>`; return; }
  const rows = [];
  const imap = result.imap;
  rows.push(`<div class="${imap.ok ? "ok" : "fail"}">收信：${esc(imap.message)}${imap.drafts ? ` · 草稿箱「${esc(imap.drafts)}」` : ""}</div>`);
  if (imap.drafts_error || imap.warning) rows.push(`<div class="warn">${esc(imap.warning || imap.drafts_error)}</div>`);
  if (result.smtp) rows.push(`<div class="${result.smtp.ok ? "ok" : "fail"}">发信：${esc(result.smtp.message)}</div>`);
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
})();
