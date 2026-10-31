// 只读取用户当前打开的页面；只把文字填进输入框，从不触发发送。
(() => {
  if (window.__tradetwinContent) return;
  window.__tradetwinContent = true;

  let lastEditable = null;
  const isEditable = (el) => el && (el.tagName === "TEXTAREA"
    || (el.tagName === "INPUT" && /^(text|search)?$/i.test(el.type || ""))
    || el.isContentEditable);

  document.addEventListener("focusin", (e) => {
    if (isEditable(e.target)) lastEditable = e.target;
  }, true);

  function replyTarget() {
    if (isEditable(document.activeElement)) return document.activeElement;
    return lastEditable && document.contains(lastEditable) ? lastEditable : null;
  }

  function readDraft() {
    const el = replyTarget();
    if (!el) return null;
    return el.isContentEditable ? el.innerText : el.value;
  }

  function insert(text) {
    const el = replyTarget();
    if (!el) return { ok: false, error: "没有找到回复输入框" };
    el.focus();
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
    if (msg?.type === "tt-read") sendResponse({ selection: String(window.getSelection() || "").trim(), url: location.href });
    else if (msg?.type === "tt-read-draft") sendResponse({ text: readDraft() });
    else if (msg?.type === "tt-insert") sendResponse(insert(String(msg.text || "")));
  });
})();
