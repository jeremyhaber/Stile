'use strict';
// Reference implementation of CaptureSettings.swift (v3.5c): the app-owned capture settings. Kept in state.json under
// `capture`; the S3 secret lives outside it (the Swift app uses the Keychain, here it is a field of this object).
const os = require('os');
const path = require('path');

const DEFAULT_PATTERN = 'Screenshot {yyyy}-{mm}-{dd} at {hh}.{min}.{ss}';
const S3_STRINGS = ['endpoint', 'region', 'bucket', 'accessKeyId', 'prefix', 'publicBase'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const expand = (p) => (p.startsWith('~') ? os.homedir() + p.slice(1) : p);

class CaptureSettings {
  /** @param host the HostServer (state.json access) */
  constructor(host) {
    this.host = host;
    /** the Keychain stand-in */
    this.keychainSecret = '';
  }

  get stored() { const c = this.host.readState().capture; return isObject(c) ? c : {}; }
  save(mutate) { this.host.updateState((st) => { const cap = isObject(st.capture) ? st.capture : {}; mutate(cap); st.capture = cap; }); }

  static get defaultScreenshotFolder() { return path.join(os.homedir(), 'Downloads', 'Screenshots'); }
  static get defaultRecordingFolder() { return path.join(os.homedir(), 'Movies', 'Stile'); }

  get screenshotFolder() { const p = this.stored.screenshotFolder; return typeof p === 'string' && p ? expand(p) : CaptureSettings.defaultScreenshotFolder; }
  get recordingFolder() { const p = this.stored.recordingFolder; return typeof p === 'string' && p ? expand(p) : this.screenshotFolder; }
  get recordingFolderFollowsScreenshots() { const p = this.stored.recordingFolder; return !(typeof p === 'string' && p); }
  get filenamePattern() { const p = typeof this.stored.filenamePattern === 'string' ? this.stored.filenamePattern.trim() : ''; return p || DEFAULT_PATTERN; }
  get windowShadow() { return typeof this.stored.windowShadow === 'boolean' ? this.stored.windowShadow : true; }
  get annotate() { return typeof this.stored.annotate === 'boolean' ? this.stored.annotate : true; }
  get askWhere() { return typeof this.stored.askWhere === 'boolean' ? this.stored.askWhere : false; }

  get recording() {
    const r = isObject(this.stored.recording) ? this.stored.recording : {};
    return {
      micDeviceId: typeof r.micDeviceId === 'string' ? r.micDeviceId : '',
      systemAudio: typeof r.systemAudio === 'boolean' ? r.systemAudio : false,
      countdown: typeof r.countdown === 'boolean' ? r.countdown : true,
      fps: r.fps === 60 ? 60 : 30,
      codec: r.codec === 'hevc' ? 'hevc' : 'h264',
      maxResolution: ['1080p', '1440p', 'native'].includes(r.maxResolution) ? r.maxResolution : '1080p',
      showCursor: typeof r.showCursor === 'boolean' ? r.showCursor : true,
    };
  }

  /** the extension's S3 shape (DEFAULT_S3 in capture/s3.js) minus the secret */
  get s3Public() {
    const s = isObject(this.stored.s3) ? this.stored.s3 : {};
    const out = {};
    for (const k of S3_STRINGS) out[k] = typeof s[k] === 'string' ? s[k] : '';
    out.prefix = typeof s.prefix === 'string' ? s.prefix : 'screenshots/{yyyy}/{mm}/';
    out.regionAuto = typeof s.regionAuto === 'boolean' ? s.regionAuto : true;
    out.style = ['auto', 'path', 'virtual'].includes(s.style) ? s.style : 'auto';
    out.naming = s.naming === 'timestamp' ? 'timestamp' : 'random';
    out.linkType = s.linkType === 'public' ? 'public' : 'presigned';
    out.recordingShare = s.recordingShare === 'file' ? 'file' : 'page';
    out.expiry = Number.isInteger(s.expiry) ? Math.min(604800, Math.max(1, s.expiry)) : 604800;
    out.v = 2;
    return out;
  }

  get s3Configured() { const s = this.s3Public; return !!(s.endpoint && s.bucket && s.accessKeyId && this.keychainSecret); }

  /** what settings pages and appState carry: no secret (`secretSet` says whether there is one); `full` adds it */
  publicDict(full = false) {
    const s3 = { ...this.s3Public, secretSet: !!this.keychainSecret };
    if (full) s3.secretAccessKey = this.keychainSecret;
    return {
      screenshotFolder: this.screenshotFolder, recordingFolder: this.recordingFolder, recordingFolderFollowsScreenshots: this.recordingFolderFollowsScreenshots,
      defaultScreenshotFolder: CaptureSettings.defaultScreenshotFolder, defaultRecordingFolder: CaptureSettings.defaultRecordingFolder,
      filenamePattern: this.filenamePattern, defaultPattern: DEFAULT_PATTERN,
      windowShadow: this.windowShadow, annotate: this.annotate, askWhere: this.askWhere, s3, recording: this.recording,
    };
  }

  /** the config the editor window loads: the app's settings plus the profile's colour */
  editorConfig(sidebarColor) {
    const cfg = { annotate: this.annotate, askWhere: this.askWhere, s3: { ...this.s3Public, secretAccessKey: this.keychainSecret } };
    if (sidebarColor !== undefined && sidebarColor !== null) cfg.sidebarColor = sidebarColor;
    return cfg;
  }

  /** applies a patch; unknown keys and invalid values are ignored. Returns whether anything changed. */
  apply(patch) {
    if (!isObject(patch)) return false;
    let changed = false, newSecret = null;
    const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : null);
    this.save((cap) => {
      for (const k of ['screenshotFolder', 'recordingFolder']) {
        const p = str(patch[k], 1024);
        if (p !== null && (p === '' || p.startsWith('/') || p.startsWith('~'))) { cap[k] = p; changed = true; }
      }
      const pat = str(patch.filenamePattern, 200);
      if (pat !== null) { cap.filenamePattern = pat; changed = true; }
      for (const k of ['windowShadow', 'annotate', 'askWhere']) if (typeof patch[k] === 'boolean') { cap[k] = patch[k]; changed = true; }
      if (isObject(patch.s3)) {
        const s = patch.s3, cur = isObject(cap.s3) ? cap.s3 : {};
        for (const k of S3_STRINGS) { const v = str(s[k]); if (v !== null) cur[k] = v.trim(); }
        if (typeof s.regionAuto === 'boolean') cur.regionAuto = s.regionAuto;
        if (['auto', 'path', 'virtual'].includes(s.style)) cur.style = s.style;
        if (['random', 'timestamp'].includes(s.naming)) cur.naming = s.naming;
        if (['presigned', 'public'].includes(s.linkType)) cur.linkType = s.linkType;
        if (['page', 'file'].includes(s.recordingShare)) cur.recordingShare = s.recordingShare;
        if (Number.isInteger(s.expiry)) cur.expiry = Math.min(604800, Math.max(1, s.expiry));
        const sec = str(s.secretAccessKey, 512);
        if (sec !== null) newSecret = sec.trim();
        cap.s3 = cur; changed = true;
      }
      if (isObject(patch.recording)) {
        const r = patch.recording, cur = isObject(cap.recording) ? cap.recording : {};
        const mic = str(r.micDeviceId); if (mic !== null) cur.micDeviceId = mic;
        for (const k of ['systemAudio', 'countdown', 'showCursor']) if (typeof r[k] === 'boolean') cur[k] = r[k];
        if (r.fps === 30 || r.fps === 60) cur.fps = r.fps;
        if (['h264', 'hevc'].includes(r.codec)) cur.codec = r.codec;
        if (['1080p', '1440p', 'native'].includes(r.maxResolution)) cur.maxResolution = r.maxResolution;
        cap.recording = cur; changed = true;
      }
    });
    if (newSecret !== null) { this.keychainSecret = newSecret; changed = true; }
    if (changed) this.host.captureChanged();
    return changed;
  }

  /** the extension's first S3 setup is adopted once when the app has none (cfg is its `captureConfig`) */
  adoptIfEmpty(cfg) {
    if (!isObject(cfg) || this.stored.s3Adopted === true || this.s3Configured) return false;
    const s3 = cfg.s3;
    if (!isObject(s3) || typeof s3.bucket !== 'string' || !s3.bucket) return false;
    const patch = { s3 };
    if (typeof cfg.annotate === 'boolean' && this.stored.annotate === undefined) patch.annotate = cfg.annotate;
    if (typeof cfg.askWhere === 'boolean' && this.stored.askWhere === undefined) patch.askWhere = cfg.askWhere;
    this.apply(patch);
    this.save((cap) => { cap.s3Adopted = true; });
    return true;
  }

  /** "Screenshot 2026-10-24 at 14.03.22.png" from the pattern: {yyyy} {mm} {dd} {hh} {min} {ss} {app} */
  fileName(app, d = new Date(), ext = 'png') {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const tokens = { '{yyyy}': p(d.getFullYear(), 4), '{mm}': p(d.getMonth() + 1), '{dd}': p(d.getDate()), '{hh}': p(d.getHours()), '{min}': p(d.getMinutes()), '{ss}': p(d.getSeconds()), '{app}': app };
    let s = this.filenamePattern;
    for (const [t, v] of Object.entries(tokens)) s = s.split(t).join(v);
    s = s.replace(/\//g, '-').replace(/:/g, '.').trim();
    if (!s || s.startsWith('.')) s = d.toISOString();
    return `${s}.${ext}`;
  }
}

module.exports = { CaptureSettings, DEFAULT_PATTERN };
