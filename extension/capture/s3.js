// S3-compatible uploads with AWS Signature Version 4, plain JS + crypto.subtle (no dependencies).
// Used by the editor page and the service worker. Credentials never leave the configured endpoint.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toBytes = (d) => (typeof d === 'string' ? enc.encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : d);

export async function sha256Hex(data) { return hex(await crypto.subtle.digest('SHA-256', toBytes(data))); }
export async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', toBytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, toBytes(data));
}

// RFC 3986 encoding as SigV4 wants it (everything but A-Z a-z 0-9 - _ . ~).
export const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const encodePath = (p) => p.split('/').map(uriEncode).join('/');

export const amzDate = (d = new Date()) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

async function signingKey(secret, date8, region, service) {
  const kDate = await hmac('AWS4' + secret, date8);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

const hostOf = (u) => u.host; // includes a non-default port, exactly what fetch sends as Host

function canonicalQuery(params) {
  return [...params].map(([k, v]) => [uriEncode(k), uriEncode(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Header-based signing. `headers` are the request headers to sign (host and x-amz-date are added when missing).
 * Returns { headers, authorization, signature, canonicalRequest, stringToSign }.
 */
export async function signHeaders({ method, url, headers = {}, payloadHash, region, service = 's3', accessKeyId, secretAccessKey, date = new Date() }) {
  const u = new URL(url);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const stamp = amzDate(date);
  if (!h.host) h.host = hostOf(u);
  if (!h['x-amz-date'] && !h.date) h['x-amz-date'] = stamp;
  if (!h['x-amz-content-sha256']) h['x-amz-content-sha256'] = payloadHash;
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, encodePath(decodeURI(u.pathname)), canonicalQuery(u.searchParams), canonicalHeaders, signedHeaders, h['x-amz-content-sha256']].join('\n');
  const date8 = stamp.slice(0, 8);
  const scope = `${date8}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(await hmac(await signingKey(secretAccessKey, date8, region, service), stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: { ...h, authorization }, authorization, signature, canonicalRequest, stringToSign };
}

/** Query-string signing (presigned URL). */
export async function presign({ method = 'GET', url, region, service = 's3', accessKeyId, secretAccessKey, expires = 3600, date = new Date() }) {
  const u = new URL(url);
  const stamp = amzDate(date), date8 = stamp.slice(0, 8);
  const scope = `${date8}/${region}/${service}/aws4_request`;
  const params = new URLSearchParams(u.searchParams);
  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential', `${accessKeyId}/${scope}`);
  params.set('X-Amz-Date', stamp);
  params.set('X-Amz-Expires', String(expires));
  params.set('X-Amz-SignedHeaders', 'host');
  const cq = canonicalQuery(params);
  const canonicalRequest = [method, encodePath(decodeURI(u.pathname)), cq, `host:${hostOf(u)}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(await hmac(await signingKey(secretAccessKey, date8, region, service), stringToSign));
  return { url: `${u.origin}${u.pathname}?${cq}&X-Amz-Signature=${signature}`, signature, canonicalRequest, stringToSign };
}

// ------------------------------------------------------------------ configuration

/** SigV4 caps a presigned link at 7 days (AWS, R2, B2, … refuse a longer X-Amz-Expires), so a link that never expires needs a public base URL. */
export const PRESIGN_MAX = 604800;

// v3.0: no provider presets. One S3-compatible form; region and addressing are worked out from the endpoint unless overridden.
export const DEFAULT_S3 = {
  endpoint: '', region: '', regionAuto: true, bucket: '', accessKeyId: '', secretAccessKey: '',
  prefix: 'screenshots/{yyyy}/{mm}/', style: 'auto', naming: 'random', linkType: 'presigned', publicBase: '', expiry: PRESIGN_MAX, v: 2,
};

const hostOfEndpoint = (endpoint) => { try { return new URL(String(endpoint || '').trim()).hostname.toLowerCase(); } catch { return ''; } };

/** The region an endpoint implies (R2 -> auto, s3.<region>.amazonaws.com, <region>.digitaloceanspaces.com, ...), or null. */
export function regionFromEndpoint(endpoint) {
  const h = hostOfEndpoint(endpoint);
  if (!h) return null;
  if (/(^|\.)r2\.cloudflarestorage\.com$/.test(h)) return 'auto';
  let m;
  if ((m = /(?:^|\.)s3[.-](?:dualstack\.)?([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(h))) return m[1];
  if (/(?:^|\.)s3\.amazonaws\.com$/.test(h)) return 'us-east-1';
  if ((m = /(?:^|\.)([a-z0-9-]+)\.digitaloceanspaces\.com$/.exec(h))) return m[1];
  if ((m = /(?:^|\.)s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(h))) return m[1];
  if ((m = /(?:^|\.)s3\.([a-z0-9-]+)\.wasabisys\.com$/.exec(h))) return m[1];
  if ((m = /(?:^|\.)s3\.([a-z0-9-]+)\.idrivee2-[a-z0-9-]+\.com$/.exec(h))) return m[1];
  return null;
}
/** Region to sign with: what the user entered, else what the endpoint implies, else us-east-1. */
export const effectiveRegion = (cfg) => String((cfg && cfg.region) || '').trim() || regionFromEndpoint(cfg && cfg.endpoint) || 'us-east-1';
/** Automatic addressing: virtual-hosted for amazonaws.com, path-style for everything else. */
export function autoStyle(endpoint) { return /(^|\.)amazonaws\.com(\.cn)?$/.test(hostOfEndpoint(endpoint)) ? 'virtual' : 'path'; }
export const effectiveStyle = (cfg) => (cfg && (cfg.style === 'path' || cfg.style === 'virtual') ? cfg.style : autoStyle(cfg && cfg.endpoint));

/** Stored settings from before v3.0 had provider presets: drop `preset`/`provider`, resolve `{region}`, and map an addressing style that equals the automatic one to "auto". */
export function migrateS3(raw) {
  const r = raw && typeof raw === 'object' ? { ...raw } : {};
  const had = 'preset' in r || 'provider' in r;
  const old = !(Number(r.v) >= 2);
  delete r.preset; delete r.provider;
  const cfg = { ...DEFAULT_S3, ...r };
  // v2: presigned links are the default; a saved "public" choice with no public base URL could never upload, so it moves over (once)
  if (old) {
    if (cfg.linkType !== 'presigned' && !String(cfg.publicBase || '').trim()) { cfg.linkType = 'presigned'; cfg.expiry = PRESIGN_MAX; }
    cfg.v = 2;
  }
  if (/\{region\}/.test(String(cfg.endpoint))) cfg.endpoint = String(cfg.endpoint).replace(/\{region\}/g, cfg.region || 'us-east-1');
  if (/^https:\/\/<account-id>/.test(String(cfg.endpoint))) cfg.endpoint = '';
  if (had) {
    cfg.regionAuto = !cfg.region || cfg.region === regionFromEndpoint(cfg.endpoint);
    if (cfg.style === autoStyle(cfg.endpoint)) cfg.style = 'auto';
  }
  if (cfg.style !== 'path' && cfg.style !== 'virtual') cfg.style = 'auto';
  return { cfg, changed: had || (old && Object.keys(r).length > 0) };
}

export const s3Configured = (c) => !!(c && c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function expandPrefix(prefix, d = new Date()) {
  return String(prefix || '').replace(/\{yyyy\}/g, d.getFullYear()).replace(/\{mm\}/g, pad(d.getMonth() + 1)).replace(/\{dd\}/g, pad(d.getDate()));
}
export const randomId = (n = 10) => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = crypto.getRandomValues(new Uint8Array(n));
  return [...r].map((x) => a[x % a.length]).join('');
};
export const stampName = (d = new Date()) => `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;

export function objectKey(cfg, d = new Date(), id) {
  let prefix = expandPrefix(cfg.prefix, d).replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const name = cfg.naming === 'timestamp' ? stampName(d) : (id || randomId(10));
  return `${prefix}${name}.png`;
}

/** The URL of an object on the endpoint, with the configured addressing style. */
export function objectUrl(cfg, key) {
  const ep = new URL(String(cfg.endpoint).trim());
  const keyPath = encodePath(key);
  if (effectiveStyle(cfg) === 'virtual') return `${ep.protocol}//${cfg.bucket}.${ep.host}/${keyPath}`;
  return `${ep.protocol}//${ep.host}${ep.pathname.replace(/\/$/, '')}/${encodePath(cfg.bucket)}/${keyPath}`;
}

export function publicLink(cfg, key) {
  const base = String(cfg.publicBase || '').trim();
  return base.replace(/\/*$/, '/') + encodePath(key);
}

async function xmlError(res) {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
  const msg = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
  const detail = [code, msg].filter(Boolean).join(': ') || body.trim().slice(0, 200);
  return new Error(`${res.status} ${res.statusText}${detail ? ' – ' + detail : ''}`.trim());
}

async function put(cfg, key, body, contentType, extra = {}, f = fetch) {
  const url = objectUrl(cfg, key);
  const payloadHash = await sha256Hex(body);
  const signed = await signHeaders({ method: 'PUT', url, headers: { 'content-type': contentType, ...extra }, payloadHash, region: effectiveRegion(cfg), accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const { host, ...send } = signed.headers; // the browser sets Host itself
  let res;
  try { res = await f(url, { method: 'PUT', headers: send, body }); } catch (e) { throw new Error(`Couldn’t reach ${new URL(url).host}: ${e.message || e}`); }
  if (!res.ok) throw await xmlError(res);
  return url;
}
async function del(cfg, key, f = fetch) {
  const url = objectUrl(cfg, key);
  const signed = await signHeaders({ method: 'DELETE', url, payloadHash: await sha256Hex(''), region: effectiveRegion(cfg), accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const { host, ...send } = signed.headers;
  let res;
  try { res = await f(url, { method: 'DELETE', headers: send }); } catch (e) { throw new Error(`Couldn’t reach ${new URL(url).host}: ${e.message || e}`); }
  if (!res.ok && res.status !== 404) throw await xmlError(res);
}

/**
 * Uploads a PNG blob; resolves { key, url } where url is the link to share (public base or presigned). `fetch` can be
 * replaced (Stile.app's editor window sends the request through the app).
 */
export async function uploadPng(cfg, blob, { date = new Date(), fetch: f = fetch } = {}) {
  if (!s3Configured(cfg)) throw new Error('Upload isn’t set up. Add your storage details in Settings → Screenshots.');
  if (cfg.linkType !== 'presigned' && !String(cfg.publicBase || '').trim()) throw new Error('Add a public base URL in Settings → Screenshots, or switch the link type to “Presigned link”.');
  const key = objectKey(cfg, date);
  const body = new Uint8Array(await blob.arrayBuffer());
  await put(cfg, key, body, 'image/png', { 'cache-control': 'public, max-age=31536000' }, f);
  let url;
  if (cfg.linkType === 'presigned') {
    const expires = Math.min(PRESIGN_MAX, Math.max(1, Number(cfg.expiry) || PRESIGN_MAX));
    url = (await presign({ url: objectUrl(cfg, key), region: effectiveRegion(cfg), accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, expires })).url;
  } else url = publicLink(cfg, key);
  return { key, url };
}

/** PUT a tiny text object, then DELETE it. Rejects with the server’s own error text. */
export async function testConnection(cfg, { fetch: f = fetch } = {}) {
  if (!s3Configured(cfg)) throw new Error('Fill in the endpoint, bucket and both keys first.');
  let prefix = expandPrefix(cfg.prefix).replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const key = `${prefix}sidebar-test.txt`;
  await put(cfg, key, enc.encode('Stile connection test'), 'text/plain', {}, f);
  await del(cfg, key, f);
  return true;
}
