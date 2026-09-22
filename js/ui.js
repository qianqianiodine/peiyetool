/* DOM 辅助 —— 选择器、元素创建、Toast、复制、转义 */
(function (global) {
  'use strict';

  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /** HTML 转义：所有用户/远端数据进 innerHTML 前必须过一遍 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* ── Toast ────────────────────────────────────────── */
  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast on' + (kind === 'error' ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    // 确认类短暂自动消失；错误类停留更久，且点一下可手动关掉
    toastTimer = setTimeout(() => {
      t.className = 'toast';
      setTimeout(() => { t.hidden = true; }, 200);
    }, kind === 'error' ? 6000 : 2600);
  }
  function toastOff() {
    const t = $('#toast');
    if (t) { t.className = 'toast'; t.hidden = true; }
  }

  /* ── 复制 ─────────────────────────────────────────── */
  async function copy(text) {
    const s = String(text == null ? '' : text);
    try {
      // file:// 下不是 secure context，clipboard API 不可用，会落到下面的兜底
      if (navigator.clipboard && global.isSecureContext) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch (e) { /* 继续走兜底 */ }

    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /** 绑定复制按钮：data-copy 存文本，或从 data-copy-from 指向的元素取值 */
  function bindCopy(root) {
    $$('[data-copy],[data-copy-from]', root || document).forEach(btn => {
      if (btn.__copyBound) return;
      btn.__copyBound = true;
      btn.addEventListener('click', async () => {
        const from = btn.getAttribute('data-copy-from');
        const text = from
          ? (($(from) && ($(from).textContent || '')) || '')
          : (btn.getAttribute('data-copy') || '');
        const ok = await copy(text.trim());
        toast(ok ? '已复制' : '复制失败，请长按手动选择', ok ? '' : 'error');
      });
    });
  }

  /** 结果区通用的"复制"按钮 HTML */
  function copyBtn(text, label) {
    return '<button class="btn tiny" data-copy="' + esc(text) + '">'
      + esc(label || '复制') + '</button>';
  }

  /* ── 其他 ─────────────────────────────────────────── */
  const debounce = (fn, ms) => {
    let t;
    return function () {
      const a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, a), ms || 250);
    };
  };

  /** 时间戳 → 相对时间 */
  function ago(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 86400000 * 7) return Math.floor(d / 86400000) + ' 天前';
    const dt = new Date(ts);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  global.UI = { $, $$, esc, el, toast, toastOff, copy, bindCopy, copyBtn, debounce, ago };

})(typeof globalThis !== 'undefined' ? globalThis : this);
