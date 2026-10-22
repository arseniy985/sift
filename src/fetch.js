import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'sift');
const PROFILE = join(CACHE, 'profile');
const CHROME = (() => { try { return execFileSync('google-chrome', ['--version']).toString().match(/(\d+)\./)[1]; } catch { return null; } })();
// headless Chrome only leaks "HeadlessChrome" in the UA; brands/webdriver are clean with patchright
const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME || 143}.0.0.0 Safari/537.36`;

// engine: browser (real Chrome via patchright, default) | fetch (plain HTTP, fast, no JS)
export async function load(url, { engine = 'browser', maxAge = 600, timeout = 30000, interactive = true } = {}) {
  const file = join(CACHE, createHash('sha1').update(engine + ' ' + url).digest('hex') + '.json');
  if (maxAge > 0) {
    try { const c = JSON.parse(await readFile(file, 'utf8')); if (Date.now() - c.ts < maxAge * 1000) return c; } catch {}
  }
  const res = engine === 'fetch' ? await plain(url, timeout) : await rendered(url, timeout, interactive);
  res.ts = Date.now();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(res));
  return res;
}

export async function plain(url, timeout = 30000) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9,ru;q=0.8' },
    redirect: 'follow', signal: AbortSignal.timeout(timeout),
  });
  const type = (r.headers.get('content-type') || 'text/html').split(';')[0].trim();
  if (/pdf|image|video|audio|zip|octet-stream/.test(type)) throw new Error(`unsupported content-type ${type}: ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const cs = /charset=["']?([\w-]+)/i.exec(r.headers.get('content-type') || '')?.[1]
    || /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(buf.slice(0, 4096)))?.[1];
  let html;
  try { html = new TextDecoder(cs || 'utf-8').decode(buf); } catch { html = new TextDecoder().decode(buf); }
  return { url: r.url, status: r.status, type, html };
}

// one persistent Chrome profile: cookies / solved challenges survive between runs
let ctxP = null, shown = false;
async function context(show) {
  if (ctxP && shown === show) return ctxP;
  await close();
  shown = show;
  const opts = { channel: CHROME ? 'chrome' : undefined, headless: !show, viewport: null, args: show ? [] : [`--user-agent=${UA}`, '--window-size=1366,900'] };
  return (ctxP = import('patchright').then(({ chromium }) => chromium.launchPersistentContext(PROFILE, opts)
    // profile locked by another sift process -> throwaway profile
    .catch(() => chromium.launchPersistentContext('', opts))));
}

export async function close() {
  if (!ctxP) return;
  const c = ctxP;
  ctxP = null;
  await (await c).close().catch(() => {});
}

// cloudflare / recaptcha / hcaptcha / yandex smartcaptcha interstitials; a captcha inside a normal page doesn't count
const blocked = () => {
  const text = document.body?.innerText || '';
  const short = text.length < 1500;
  return /just a moment|attention required|checking your browser|verify you are human|are you a robot|access denied|доступ ограничен|вы не робот|проверяем браузер|проверка браузера|похоже, нет соединения/i.test(document.title + ' ' + (short ? text : ''))
    || (short && !!document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],#px-captcha,.smart-captcha,#challenge-form'));
};

// runs in the page: resolves once the DOM stops changing for `quiet` ms (networkidle never comes on sites with analytics)
const settle = quiet => new Promise(done => {
  let t;
  const end = () => { ob.disconnect(); done(); };
  const ob = new MutationObserver(() => { clearTimeout(t); t = setTimeout(end, quiet); });
  ob.observe(document, { subtree: true, childList: true, characterData: true });
  t = setTimeout(end, quiet);
  setTimeout(end, 4000);
});

// runs in the page: HTML with open shadow roots flattened (slots filled) plus layout facts
// static HTML can't give: hidden nodes, overlays, inline tags rendered as blocks
function serialize() {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe']);
  const inline = /^(a|abbr|b|button|cite|code|em|i|label|small|span|strong|time|u)$/;
  const area = innerWidth * innerHeight, out = [];
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const walk = (n, quiet) => {
    if (n.nodeType === 3) return void out.push(esc(n.data));
    if (n.nodeType !== 1) return;
    const tag = n.localName;
    if (tag === 'slot') {
      const a = n.assignedNodes({ flatten: true });
      return (a.length ? a : [...n.childNodes]).forEach(c => walk(c, quiet));
    }
    const ld = tag === 'script' && n.type === 'application/ld+json';
    if (SKIP.has(tag) && !ld && !(tag === 'iframe' && n.src)) return;
    let mark = '';
    if (!quiet && tag !== 'html' && tag !== 'head') {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') { mark = ' data-sift-hidden'; quiet = true; }
      else {
        if (inline.test(tag) && /^(block|flex|grid|list-item|table)$/.test(cs.display)) mark = ' data-sift-block';
        if (cs.position === 'fixed') {
          const b = n.getBoundingClientRect();
          if (b.width * b.height > area * 0.25 && n.innerText.length < 2000) mark += ' data-sift-overlay';
        }
      }
    }
    out.push('<' + tag);
    for (const a of n.attributes) if (/^[\w:.-]+$/.test(a.name)) out.push(` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
    out.push(mark + '>');
    if (VOID.has(tag)) return;
    if (ld) out.push(n.textContent);
    else if (tag !== 'iframe') for (const c of (n.shadowRoot || n).childNodes) walk(c, quiet || tag === 'head');
    out.push(`</${tag}>`);
  };
  walk(document.documentElement, false);
  return '<!doctype html>' + out.join('');
}

async function rendered(url, timeout, interactive, show = false) {
  const page = await (await context(show)).newPage();
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const type = (r?.headers()['content-type'] || 'text/html').split(';')[0].trim();
    if (!/html/.test(type)) return { url: page.url(), status: r.status(), type, html: await r.text() };
    // challenge pages often redirect mid-way, which kills the evaluate; wait for the new document and retry once
    const calm = q => page.evaluate(settle, q).catch(() => page.waitForLoadState('domcontentloaded').then(() => page.evaluate(settle, q)).catch(() => {}));
    await calm(500);
    // most challenges clear themselves in a few seconds; otherwise a human solves it in a visible window
    if (show) process.stderr.write(`sift: captcha on ${url} — solve it in the Chrome window (2 min)\n`);
    const stuck = await page.evaluate(blocked).catch(() => true) && await page.waitForFunction(`!(${blocked})()`, null, { timeout: show ? 120000 : 12000 })
      .then(() => false, () => true);
    // ponytail: switching to headful closes the shared context, in-flight parallel crawl pages fail; serialize if that bites
    if (stuck && !show && interactive) { await page.close(); return rendered(url, timeout, interactive, true); }
    if (stuck === false) await calm(500);
    // scroll to trigger lazy-loaded content
    await page.evaluate(async () => {
      for (let i = 0; i < 12 && innerHeight + scrollY < document.documentElement.scrollHeight - 5; i++) {
        scrollBy(0, innerHeight * 1.5);
        await new Promise(r => setTimeout(r, 120));
      }
      scrollTo(0, 0);
    });
    await page.evaluate(settle, 300);
    return { url: page.url(), status: r?.status() ?? 200, type, html: await page.evaluate(serialize), blocked: stuck };
  } finally {
    await page.close().catch(() => {});
  }
}
