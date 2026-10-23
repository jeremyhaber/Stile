// Boosts content script (top frame, document_start): zaps + custom CSS for the exact hostname,
// and the custom tab-name override of document.title. Must never throw.
(() => {
  try {
    if (window.top !== window) return;
    const host = location.hostname;
    const api = chrome;
    if (!api?.storage?.local || !api.runtime?.id) return;

    // ---------- CSS + zaps ----------
    const ID = '__sidebar_boost__';
    let style = null;
    const build = (b) => {
      if (!b || b.enabled === false) return '';
      let out = '';
      if (Array.isArray(b.zaps)) for (const z of b.zaps) if (z && typeof z.selector === 'string') out += z.selector + '{display:none!important}\n';
      if (typeof b.css === 'string') out += b.css;
      return out;
    };
    const attach = () => {
      const root = document.documentElement;
      if (style && root && style.parentNode !== root) root.appendChild(style);
      return !!root;
    };
    const applyCss = (text) => {
      try {
        if (!text) { if (style) { style.remove(); style = null; } return; }
        if (!style) { style = document.createElement('style'); style.id = ID; }
        if (style.textContent !== text) style.textContent = text;
        if (!attach()) new MutationObserver((_, o) => { if (attach()) o.disconnect(); }).observe(document, { childList: true });
      } catch {}
    };
    const loadBoost = () => {
      try {
        api.storage.local.get('boosts', (r) => {
          try { applyCss(build(r?.boosts?.[host])); } catch {}
        });
      } catch {}
    };
    if (host) {
      loadBoost();
      document.addEventListener('DOMContentLoaded', () => { if (style && !style.isConnected) attach(); }, { once: true });
    }

    // ---------- title override ----------
    let name = '';
    let realTitle = null;
    let headObs = null, rootObs = null;
    const setTitle = () => {
      try { if (name && document.title !== name) document.title = name; } catch {}
    };
    const onMut = () => {
      try {
        if (!name) return;
        if (document.title !== name) { realTitle = document.title; document.title = name; }
      } catch {}
    };
    const watch = () => {
      if (headObs) return;
      const head = document.head;
      if (head) {
        if (rootObs) { rootObs.disconnect(); rootObs = null; }
        headObs = new MutationObserver(onMut);
        headObs.observe(head, { childList: true, subtree: true, characterData: true });
      } else if (!rootObs && document.documentElement) {
        rootObs = new MutationObserver(() => { if (document.head) watch(); });
        rootObs.observe(document.documentElement, { childList: true });
      }
    };
    const applyName = (n) => {
      n = typeof n === 'string' ? n : '';
      if (n === name) return;
      if (n) {
        if (!name) realTitle = document.title;
        name = n;
        setTitle();
        watch();
        document.addEventListener('DOMContentLoaded', () => { watch(); setTitle(); }, { once: true });
      } else {
        name = '';
        if (headObs) { headObs.disconnect(); headObs = null; }
        if (realTitle != null) { try { document.title = realTitle; } catch {} }
        realTitle = null;
      }
    };
    let askSeq = 0;
    const askName = () => {
      const seq = ++askSeq;
      try {
        api.runtime.sendMessage({ cmd: 'getTabName' }, (res) => {
          void api.runtime.lastError;
          if (seq === askSeq) applyName(res && res.name);
        });
      } catch {}
    };
    askName();


    // ---------- v3.0: ⌘O in a little window promotes it to a full tab ----------
    // The answer is cached (asked at load and whenever the page becomes visible) because preventDefault has to happen synchronously.
    let little = false, ownTab = null;
    const askLittle = () => {
      try {
        api.runtime.sendMessage({ cmd: 'isLittleTab' }, (res) => { void api.runtime.lastError; little = !!(res && res.little); ownTab = res && res.tabId != null ? res.tabId : null; });
      } catch {}
    };
    askLittle();
    // the worker registers a little window just after creating it, which can be after this page's first question
    setTimeout(() => { if (!little) askLittle(); }, 500);
    setTimeout(() => { if (!little) askLittle(); }, 2000);
    window.addEventListener('focus', () => { if (!little) askLittle(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) askLittle(); });
    window.addEventListener('keydown', (e) => {
      try {
        if (!little || ownTab == null || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if ((e.key || '').toLowerCase() !== 'o') return;
        e.preventDefault();
        e.stopPropagation();
        api.runtime.sendMessage({ cmd: 'promoteLittle', tabId: ownTab }, () => { void api.runtime.lastError; });
      } catch {}
    }, true);

    api.storage.onChanged.addListener((ch, area) => {
      try {
        if (area !== 'local') return;
        if (ch.boosts && host) applyCss(build(ch.boosts.newValue?.[host]));
        if (ch.tabNames) askName();
      } catch {}
    });
  } catch {}
})();
