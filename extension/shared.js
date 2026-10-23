// Helpers shared by the service worker and the side panel.

export const SIDEBAR_TITLE = 'Sidebar';
export const FAV_TITLE = 'Favourites';
export const PINNED_TITLE = 'Pinned';
export const DEFAULT_ARCHIVE_MINUTES = 720;
// Choices for the archive selects (minutes). 0 = never.
export const ARCHIVE_CHOICES = [60, 360, 720, 1440, 4320, 10080, 43200, 0];

export function fmtMinutes(n) {
  if (n === 0) return 'Never';
  if (n == null) return '';
  const t = {
    60: '1 hour', 360: '6 hours', 720: '12 hours', 1440: '24 hours',
    4320: '3 days', 10080: '7 days', 43200: '30 days'
  };
  if (t[n]) return t[n];
  if (n % 1440 === 0) return `${n / 1440} days`;
  if (n % 60 === 0) return `${n / 60} hours`;
  return `${n} minutes`;
}

export function isBlankUrl(u) {
  return !u || /^(chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?|about:blank)$/i.test(u);
}

export function normUrl(u) {
  try { return new URL(u).href; } catch { return u || ''; }
}

export function faviconUrl(pageUrl, size = 32) {
  return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*:\/\/|(about|chrome|chrome-extension|file|data|mailto|view-source):)/i;

export function looksLikeUrl(text) {
  const t = (text || '').trim();
  if (!t || /\s/.test(t)) return false;
  if (SCHEME_RE.test(t)) return true;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(t)) return true;
  return t.includes('.');
}

export function toUrl(text) {
  const t = text.trim();
  if (SCHEME_RE.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(t)) return 'http://' + t;
  return 'https://' + t;
}

async function validRoots(r) {
  if (!r) return null;
  try {
    const nodes = await chrome.bookmarks.get([r.sidebar, r.favourites, r.pinned]);
    if (nodes.length === 3 && !nodes[0].url && nodes[0].title === SIDEBAR_TITLE &&
        nodes[1].parentId === r.sidebar && nodes[2].parentId === r.sidebar) return r;
  } catch { /* invalid ids */ }
  return null;
}

// Finds (and, only when create is true, creates) Sidebar/Favourites/Pinned.
// Only the service worker passes create:true, from inside its write queue.
export async function getRoots({ create = false } = {}) {
  const { roots } = await chrome.storage.local.get('roots');
  const cached = await validRoots(roots);
  if (cached) return cached;
  const tree = await chrome.bookmarks.getTree();
  const top = (tree[0] && tree[0].children) || [];
  const other = top.find((n) => n.folderType === 'other') || top[1] || top[0];
  if (!other) return null;
  let sidebar = (other.children || []).find((n) => !n.url && n.title === SIDEBAR_TITLE);
  if (!sidebar) {
    if (!create) return null;
    sidebar = await chrome.bookmarks.create({ parentId: other.id, title: SIDEBAR_TITLE });
  }
  const kids = await chrome.bookmarks.getChildren(sidebar.id);
  let fav = kids.find((n) => !n.url && n.title === FAV_TITLE);
  let pin = kids.find((n) => !n.url && n.title === PINNED_TITLE);
  if (create) {
    if (!fav) fav = await chrome.bookmarks.create({ parentId: sidebar.id, title: FAV_TITLE });
    if (!pin) pin = await chrome.bookmarks.create({ parentId: sidebar.id, title: PINNED_TITLE });
  }
  if (!fav || !pin) return null;
  const r = { sidebar: sidebar.id, favourites: fav.id, pinned: pin.id };
  await chrome.storage.local.set({ roots: r });
  return r;
}

// ------------------------------------------------------------------ profile styles (v1.1)
export const PROFILE_COLORS = [
  { hex: '#ff5f57', name: 'Coral' }, { hex: '#ff9f0a', name: 'Orange' }, { hex: '#ffd60a', name: 'Yellow' },
  { hex: '#32d74b', name: 'Green' }, { hex: '#30b0c7', name: 'Teal' }, { hex: '#0a84ff', name: 'Blue' },
  { hex: '#5e5ce6', name: 'Indigo' }, { hex: '#bf5af2', name: 'Purple' }, { hex: '#ff375f', name: 'Pink' },
  { hex: '#8e8e93', name: 'Graphite' }
];
export const PROFILE_GLYPHS = ['home', 'briefcase', 'code', 'star', 'heart', 'book', 'music', 'camera', 'palette', 'rocket', 'leaf', 'coffee', 'game', 'globe', 'bolt', 'moon'];
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const HEX_RE = /^#[0-9a-f]{6}$/i;

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

export function defaultProfileColor(p) {
  const c = p && typeof p.color === 'string' && HEX_RE.test(p.color) ? p.color : null;
  if (c) {
    const { s, l } = hexToHsl(c);
    if (s > 0.25 && l >= 0.25 && l <= 0.8) return c.toLowerCase();
  }
  const key = (p && (p.dir || p.name)) || '';
  return PROFILE_COLORS[hashStr(String(key)) % PROFILE_COLORS.length].hex;
}

// Resolve what a profile should look like: saved style first, then defaults.
export function resolveStyle(p, override) {
  const st = override || (p && p.style) || null;
  let icon = st && st.icon;
  const valid = icon === 'picture' || icon === 'initial' || PROFILE_GLYPHS.includes(icon);
  if (!valid) icon = p && p.picture ? 'picture' : 'initial';
  if (icon === 'picture' && !(p && p.picture)) icon = 'initial';
  const color = st && typeof st.color === 'string' && HEX_RE.test(st.color) ? st.color.toLowerCase() : defaultProfileColor(p);
  return { icon, color };
}

// Readable text colour on top of a given background colour.
export function onColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  return L > 0.42 ? '#1c1c1e' : '#ffffff';
}
