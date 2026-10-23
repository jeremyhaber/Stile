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

export const PRESETS = {
  aws: { label: 'AWS S3', endpoint: 'https://s3.{region}.amazonaws.com', region: 'us-east-1', style: 'virtual', hint: 'Endpoint uses the region below.' },
  r2: { label: 'Cloudflare R2', endpoint: 'https://<account-id>.r2.cloudflarestorage.com', region: 'auto', style: 'path', hint: 'Replace <account-id> with your Cloudflare account ID.' },
  b2: { label: 'Backblaze B2', endpoint: 'https://s3.{region}.backblazeb2.com', region: 'us-west-004', style: 'path', hint: 'Use the region shown in your bucket’s endpoint.' },
  spaces: { label: 'DigitalOcean Spaces', endpoint: 'https://{region}.digitaloceanspaces.com', region: 'nyc3', style: 'virtual', hint: 'Region is the datacenter, for example nyc3.' },
  custom: { label: 'MinIO / custom', endpoint: 'http://localhost:9000', region: 'us-east-1', style: 'path', hint: 'Any S3-compatible server.' },
};

export const DEFAULT_S3 = {
  preset: 'aws', endpoint: PRESETS.aws.endpoint, region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '',
  prefix: 'screenshots/{yyyy}/{mm}/', style: 'virtual', naming: 'random', linkType: 'public', publicBase: '', expiry: 86400,
};

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
  const ep = new URL(String(cfg.endpoint).replace(/\{region\}/g, cfg.region || 'us-east-1'));
  const keyPath = encodePath(key);
  if (cfg.style === 'virtual') return `${ep.protocol}//${cfg.bucket}.${ep.host}/${keyPath}`;
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

async function put(cfg, key, body, contentType, extra = {}) {
  const url = objectUrl(cfg, key);
  const payloadHash = await sha256Hex(body);
  const signed = await signHeaders({ method: 'PUT', url, headers: { 'content-type': contentType, ...extra }, payloadHash, region: cfg.region || 'us-east-1', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const { host, ...send } = signed.headers; // the browser sets Host itself
  let res;
  try { res = await fetch(url, { method: 'PUT', headers: send, body }); } catch (e) { throw new Error(`Couldn’t reach ${new URL(url).host}: ${e.message || e}`); }
  if (!res.ok) throw await xmlError(res);
  return url;
}
async function del(cfg, key) {
  const url = objectUrl(cfg, key);
  const signed = await signHeaders({ method: 'DELETE', url, payloadHash: await sha256Hex(''), region: cfg.region || 'us-east-1', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const { host, ...send } = signed.headers;
  let res;
  try { res = await fetch(url, { method: 'DELETE', headers: send }); } catch (e) { throw new Error(`Couldn’t reach ${new URL(url).host}: ${e.message || e}`); }
  if (!res.ok && res.status !== 404) throw await xmlError(res);
}

/** Uploads a PNG blob; resolves { key, url } where url is the link to share (public base or presigned). */
export async function uploadPng(cfg, blob, { date = new Date() } = {}) {
  if (!s3Configured(cfg)) throw new Error('Upload isn’t set up. Add your storage details in Settings → Screenshots.');
  if (cfg.linkType !== 'presigned' && !String(cfg.publicBase || '').trim()) throw new Error('Add a public base URL in Settings → Screenshots, or switch the link type to “Presigned link”.');
  const key = objectKey(cfg, date);
  const body = new Uint8Array(await blob.arrayBuffer());
  await put(cfg, key, body, 'image/png', { 'cache-control': 'public, max-age=31536000' });
  let url;
  if (cfg.linkType === 'presigned') {
    const expires = Math.min(604800, Math.max(1, Number(cfg.expiry) || 86400));
    url = (await presign({ url: objectUrl(cfg, key), region: cfg.region || 'us-east-1', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, expires })).url;
  } else url = publicLink(cfg, key);
  return { key, url };
}

/** PUT a tiny text object, then DELETE it. Rejects with the server’s own error text. */
export async function testConnection(cfg) {
  if (!s3Configured(cfg)) throw new Error('Fill in the endpoint, bucket and both keys first.');
  let prefix = expandPrefix(cfg.prefix).replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const key = `${prefix}sidebar-test.txt`;
  await put(cfg, key, enc.encode('Sidebar connection test'), 'text/plain');
  await del(cfg, key);
  return true;
}
