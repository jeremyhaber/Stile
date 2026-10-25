// Renders the fictional pages the demo tabs show. All content here is placeholder text.
export const icon = (s) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${s.color}"/><text x="16" y="23" font-family="Helvetica,Arial" font-size="19" font-weight="700" text-anchor="middle" fill="#fff">${s.letter}</text></svg>`);

// `sub` is the URL path: "" is the site's home page, "octopus" gives a page titled "Octopus - <site>".
export function pageHtml(s, sub = '') {
  const cap = sub ? sub[0].toUpperCase() + sub.slice(1) : '';
  const title = sub ? `${cap} - ${s.title}` : s.title;
  const head = sub ? cap : s.head;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${icon(s)}">
<style>body{margin:0;font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif;background:${s.bg};color:#1f2328}
header{display:flex;align-items:center;gap:12px;padding:14px 28px;background:${s.color};color:#fff;font-weight:700;font-size:20px}
header i{width:30px;height:30px;border-radius:8px;background:#fff3;display:inline-block}
main{max-width:640px;margin:28px auto;padding:0 28px}h1{font-size:34px;margin:0 0 10px}
p{color:#4b5563}.card{height:120px;border-radius:12px;background:${s.color}22;margin:18px 0;display:flex;align-items:center;justify-content:center;color:${s.color};font-weight:600}
.ad{background:#ffd54a;color:#4a3b00;border-radius:10px;padding:26px;text-align:center;font-weight:700;margin:18px 0;font-size:20px}
.cookie{position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:18px 28px;display:flex;justify-content:space-between;font-size:15px}
.cookie b{background:#fff;color:#222;padding:4px 14px;border-radius:6px}</style></head><body>
<header><i></i>${s.title}</header>
<main><h1>${head}</h1><p>Welcome back. Here is what is new today, picked for you from around the site.</p>
<div class="ad" id="promo">Sponsored: win a free upgrade today</div>
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer nec odio praesent libero, sed cursus ante dapibus diam.</p>
<div class="card">Featured</div><p>Sed nisi nulla quis sem at nibh elementum imperdiet. Duis sagittis ipsum.</p></main>
<div class="cookie" id="cookie"><span>We use cookies to improve your experience.</span><b>Accept</b></div></body></html>`;
}

// A generic, unbranded "other app" window (a chat) whose messages hold links. Clicking a link does nothing by itself:
// the scene sends the same openLittle command Stile.app sends. `app` comes from fixtures.mjs (LITTLE_APP).
export function appHtml(app) {
  const msgs = app.messages.map((m, i) => `<div class="m"><p>${m.text}</p><a href="#" data-i="${i}">${m.link.label}</a></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${app.title}</title>
<style>body{margin:0;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;background:#f4f5f7;color:#1f2328;height:100vh;overflow:hidden}
header{display:flex;align-items:center;gap:9px;padding:9px 14px;background:#fff;border-bottom:1px solid #e1e4e8;font-weight:600}
header i{width:26px;height:26px;border-radius:50%;background:#7c8aa5;color:#fff;font-style:normal;display:flex;align-items:center;justify-content:center;font-size:13px}
main{padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.m{background:#fff;border:1px solid #e1e4e8;border-radius:12px 12px 12px 3px;padding:8px 12px;max-width:215px}
.m p{margin:0 0 3px}.m a{color:#1a63d6;text-decoration:underline;font-weight:500;word-break:break-all}</style></head>
<body><header><i>${app.contact[0]}</i>${app.contact}</header><main>${msgs}</main>
<script>document.addEventListener('click',(e)=>{if(e.target.closest('a'))e.preventDefault()},true)</script></body></html>`;
}
