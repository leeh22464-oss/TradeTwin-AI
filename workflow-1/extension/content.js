// 只读取用户当前打开的页面；只把文字填进输入框，从不触发发送。
(() => {
  if (window.__tradetwinContent) return;
  window.__tradetwinContent = true;

  // Direction markers are deliberately explicit. Unknown site layouts require
  // selection/manual paste rather than guessing that the last text is a buyer.
  const incoming = '[data-message-direction="incoming"],[data-direction="incoming"],[data-sender-role="buyer"],.message-incoming,.message-received,.message-recv,.msg-receive,.im-message-receive';
  const outgoing = '[data-message-direction="outgoing"],[data-direction="outgoing"],[data-sender-role="self"],.message-outgoing,.message-sent,.message-send,.msg-send,.im-message-send';
  const bodies = '[data-message-content],.message-content,.msg-content';
  const composers = '.message-composer,.chat-composer,.reply-composer,.reply-editor,.chat-editor,[data-role="message-composer"],[data-testid="message-composer"]';
  const alibabaPage = () => location.protocol === "https:" && /(^|\.)alibaba\.com$/i.test(location.hostname);
  let lastEditable = null;

  function visible(el) {
    if (!el || !el.isConnected || !document.contains(el) || !el.getClientRects().length) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute("aria-hidden") === "true" || node.getAttribute("inert") !== null
        || style.display === "none" || /^(hidden|collapse)$/.test(style.visibility) || style.opacity === "0") return false;
    }
    return true;
  }

  function attributes(el) {
    return ["id", "name", "class", "placeholder", "aria-label", "data-testid", "data-role", "role"]
      .map((key) => el.getAttribute(key) || "").join(" ");
  }

  function trustedComposer(el) {
    if (!alibabaPage() || !el) return null;
    if (el.isContentEditable) el = el.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]');
    if (!el || !(el.tagName === "TEXTAREA" || el.isContentEditable) || !visible(el)
      || el.getAttribute("disabled") !== null || el.getAttribute("readonly") !== null) return null;
    const own = attributes(el);
    if (/search|filter|搜索|查找/i.test(own) || el.closest('[role="search"]')) return null;
    if (/(^|[\s_-])(reply|message|chat)([\s_-]|$)|回复|消息/i.test(own)) return el;
    let parent = el.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      if (/search|filter|搜索|查找/i.test(attributes(parent))) return null;
      if (parent.matches(composers)) return el;
    }
    return null;
  }

  document.addEventListener("focusin", (e) => {
    const editor = trustedComposer(e.target);
    if (editor) lastEditable = editor;
  }, true);

  function replyTarget() {
    const active = document.activeElement;
    const editor = trustedComposer(active);
    if (editor) return editor;
    // An explicit focus in an unrelated editor must never redirect insertion.
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return null;
    return trustedComposer(lastEditable);
  }

  function recentMessage() {
    if (!alibabaPage()) return "";
    const candidates = [...document.querySelectorAll(incoming)].filter((el) => visible(el)
      && !el.closest(outgoing) && !el.closest('textarea,input,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]')
      && !el.querySelector('textarea,input,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]'));
    let recent = "";
    for (const el of candidates) {
      if (candidates.some((other) => other !== el && el.contains(other))) continue;
      const parts = [...el.querySelectorAll(bodies)].filter((body) => visible(body) && !body.closest(outgoing));
      // Pick leaf bodies once so nested wrappers do not duplicate the text.
      const leaves = parts.filter((part) => !parts.some((other) => other !== part && part.contains(other)));
      const text = (leaves.length ? leaves.map((part) => part.innerText).join("\n") : el.innerText || "").trim();
      if (text) recent = text.slice(-4000);
    }
    return recent;
  }

  function conversationKey() {
    if (!alibabaPage()) return null;
    const url = new URL(location.href);
    const ids = new URLSearchParams();
    const known = /^(conversation_?id|thread_?id|buyer_?id|contact_?id|rfq_?id|inquiry_?id|imSessionId)$/i;
    [...url.searchParams.entries()].filter(([key, value]) => known.test(key) && value.trim())
      .sort(([a], [b]) => a.localeCompare(b)).forEach(([key, value]) => ids.append(key, value));
    if (ids.size) return url.origin + url.pathname + "?" + ids;
    for (const attribute of ["data-conversation-id", "data-thread-id", "data-buyer-id"]) {
      const values = [...document.querySelectorAll(`[${attribute}]`)]
        .filter(visible).map((el) => el.getAttribute(attribute)?.trim()).filter(Boolean);
      const unique = [...new Set(values)];
      if (unique.length === 1) return url.origin + url.pathname + "#" + attribute + "=" + encodeURIComponent(unique[0]);
      if (unique.length > 1) return null;
    }
    return null;
  }

  function readDraft() {
    const el = replyTarget();
    if (!el) return null;
    return el.isContentEditable ? el.innerText : el.value;
  }

  function insert(text, expectedConversationKey) {
    if (typeof expectedConversationKey !== "string" || !expectedConversationKey
      || conversationKey() !== expectedConversationKey) return { ok: false, error: "买家身份未确认或已变化，请手动核对后粘贴" };
    const el = replyTarget();
    if (!el) return { ok: false, error: "无法确认安全的聊天回复框，请复制后手动粘贴" };
    el.focus();
    // focus may trigger site handlers; recheck synchronously at the write boundary.
    if (conversationKey() !== expectedConversationKey || trustedComposer(el) !== el)
      return { ok: false, error: "买家或回复框已变化，请手动核对后粘贴" };
    if (el.isContentEditable) {
      el.innerText = text;
    } else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      setter ? setter.call(el, text) : (el.value = text);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "tt-read") {
      const selection = String(window.getSelection() || "").trim();
      const recent = selection ? "" : recentMessage();
      sendResponse({ selection, recent, source: selection ? "selection" : recent ? "recent" : "none", conversationKey: conversationKey(), url: location.href });
    }
    else if (msg?.type === "tt-read-draft") sendResponse({ text: readDraft() });
    else if (msg?.type === "tt-insert") sendResponse(insert(String(msg.text || ""), msg.expectedConversationKey));
  });
})();
