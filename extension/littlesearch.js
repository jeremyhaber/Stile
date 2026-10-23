// v2.8: the page a "new little window" (Control+Option+N) starts with. Enter navigates this tab; Escape closes the window.
import { looksLikeUrl, toUrl } from './shared.js';

const q = document.getElementById('q');
q.focus();
window.addEventListener('focus', () => q.focus());

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) return;
  if (looksLikeUrl(text)) { location.href = toUrl(text); return; }
  try {
    const tab = await chrome.tabs.getCurrent();
    await chrome.search.query({ text, tabId: tab.id });
  } catch (err) { console.warn('[sidebar] search failed', err); }
});

document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  try { const w = await chrome.windows.getCurrent(); await chrome.windows.remove(w.id); } catch { window.close(); }
});

// v3.0: ⌘O promotes this little window to a full tab, like on any page in it (nothing to open yet while it is still the search page).
document.addEventListener('keydown', async (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.key || '').toLowerCase() !== 'o') return;
  e.preventDefault();
  e.stopPropagation();
  try { const tab = await chrome.tabs.getCurrent(); await chrome.runtime.sendMessage({ cmd: 'promoteLittle', tabId: tab && tab.id }); } catch { /* ignore */ }
}, true);
