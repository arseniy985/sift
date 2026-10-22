import { parseHTML } from 'linkedom';

const INLINE = new Set('a abbr b bdi bdo br cite code data del dfn em font i img input ins kbd label mark q s samp select small span strong sub sup time u var button textarea wbr output meter progress'.split(' '));
const DROP = 'head,script,style,noscript,template,svg,canvas,link,meta,object,embed,map,input[type=hidden]';
// hidden tab panels / accordions are real content, keep them
const KEEP_HIDDEN = '[role=tabpanel],details,[class*=tabs],[class*=tab-],[class*=accordion],[class*=collapse]';
const TRACKING = /^(utm_\w+|fbclid|gclid|yclid|_openstat|mc_cid|mc_eid|ref_src)$/;
const COMPACT = new Set(['nav', 'header', 'footer']);

// ponytail: chars/3.5 token estimate, swap for a real tokenizer if budgets get tight
export const tokens = s => Math.ceil(s.length / 3.5);
const textLen = el => el.textContent.replace(/\s+/g, ' ').length;

export function extract(html, baseUrl = 'http://localhost/') {
  const { document: doc } = parseHTML(html);
  let base = new URL(baseUrl);
  try { base = new URL(doc.querySelector('base[href]')?.getAttribute('href') ?? base, base); } catch {}
  const meta = readMeta(doc);
  for (const el of doc.querySelectorAll(DROP)) el.remove();
  const body = doc.body || doc.documentElement;
  for (const el of body.querySelectorAll('*')) if (isHidden(el) && !el.closest(KEEP_HIDDEN) && textLen(el) < 2000) el.remove();

  // landmarks: outermost semantic/hinted blocks; everything else is content
  const bodyLen = textLen(body), lm = new Map(), holders = new Set();
  (function find(el, depth) {
    for (const c of el.children) {
      const r = landmark(c, depth, bodyLen);
      if (r) lm.set(c, r); else find(c, depth + 1);
    }
  })(body, 0);
  for (const el of lm.keys()) for (let p = el.parentElement; p && p !== body; p = p.parentElement) holders.add(p);
  const groups = [];
  (function walk(el) {
    for (const n of el.childNodes) {
      if (lm.has(n)) groups.push({ role: lm.get(n), el: n, nodes: [n] });
      else if (holders.has(n)) walk(n);
      else if (groups.at(-1) && !groups.at(-1).role) groups.at(-1).nodes.push(n);
      else groups.push({ role: null, nodes: [n] });
    }
  })(body);

  const links = [];
  let regions = groups.map(g => {
    const stats = { links: 0, images: 0, tables: 0, forms: 0, cards: 0 };
    const ctx = { base, compact: COMPACT.has(g.role), stats, links, region: g.role };
    const md = (g.el && g.role !== 'main' ? blocksOf(g.el.childNodes, ctx) : blocksOf(g.nodes, ctx)).trim()
      // galleries: keep the first image
      .replace(/(!\[[^\]]*\]\([^)]*\))((?:(?: · |\s+)!\[[^\]]*\]\([^)]*\)){2,})/g, (_, first, rest) => `${first} (+${rest.match(/!\[/g).length} img)`);
    const label = g.el && (g.el.getAttribute('aria-label') || (g.role !== 'main' && g.el.querySelector('h1,h2,h3,h4')?.textContent)) || '';
    return { role: g.role, label: label.replace(/\s+/g, ' ').trim().slice(0, 60), md, stats };
  }).filter(r => r.md);
  if (!regions.some(r => r.role === 'main')) {
    const big = regions.filter(r => !r.role).sort((a, b) => b.md.length - a.md.length)[0];
    if (big) big.role = 'main';
  }

  let sid = 0;
  regions = regions.map((r, i) => {
    const lines = r.md.split('\n'), heads = [];
    let code = false;
    for (let j = 0; j < lines.length; j++) {
      if (/^(```|~~~)/.test(lines[j])) code = !code;
      const m = !code && /^(#{1,6}) (.*)$/.exec(lines[j]);
      if (m) { const id = '§' + ++sid; heads.push({ id, level: m[1].length, text: m[2], line: j }); lines[j] += ' ' + id; }
    }
    heads.forEach((h, k) => {
      h.end = heads.slice(k + 1).find(x => x.level <= h.level)?.line ?? lines.length;
      h.tokens = tokens(lines.slice(h.line, h.end).join('\n'));
    });
    const md = lines.join('\n');
    return { ...r, id: 'r' + (i + 1), role: r.role || 'content', md, lines, heads, tokens: tokens(md) };
  });
  return new Page({ url: base.href, meta, regions, links });
}

function isHidden(el) {
  return el.hasAttribute('hidden') || el.hasAttribute('data-sift-hidden') || el.getAttribute('aria-hidden') === 'true'
    || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') || '');
}

function readMeta(doc) {
  const m = n => doc.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.getAttribute('content')?.trim();
  const data = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      for (const o of [JSON.parse(s.textContent)].flat().flatMap(x => x['@graph'] || [x])) { delete o['@context']; data.push(o); }
    } catch {}
  }
  return {
    title: (m('og:title') || doc.querySelector('title')?.textContent || doc.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim(),
    description: m('description') || m('og:description'),
    lang: doc.documentElement.getAttribute('lang'),
    published: m('article:published_time') || m('datePublished'),
    author: m('author') || m('article:author'),
    image: m('og:image'),
    data,
  };
}

function landmark(el, depth, bodyLen) {
  const tag = el.localName, role = el.getAttribute('role');
  if (tag === 'main' || role === 'main') return 'main';
  let r = role === 'dialog' || role === 'alertdialog' || tag === 'dialog' || el.hasAttribute('data-sift-overlay') ? 'dialog'
    : role === 'navigation' || tag === 'nav' ? 'nav'
    : role === 'complementary' || tag === 'aside' ? 'aside'
    : role === 'banner' || tag === 'header' ? 'header'
    : role === 'contentinfo' || tag === 'footer' ? 'footer'
    : depth < 6 ? hint(el) : null;
  // header/footer/aside inside an article belong to the article
  if (r && r !== 'dialog' && el.parentElement?.closest(r === 'header' || r === 'footer' ? 'article,aside,main,nav,section' : 'article,main')) return null;
  // a "landmark" holding most of the page is a layout wrapper
  if (r && textLen(el) > Math.max(1000, bodyLen * 0.5)) return null;
  return r;
}

function hint(el) {
  const cls = `${el.id || ''} ${el.getAttribute('class') || ''}`.toLowerCase().split(/\s+/).filter(Boolean);
  const is = re => cls.some(c => re.test(c));
  return is(/cookie|consent|gdpr/) || is(/^(modal|popup)$/) ? 'dialog'
    : is(/^(main-?|site-?|top-?)?(nav|navbar|navigation|menu|breadcrumbs?)$/) ? 'nav'
    : is(/^(left-?|right-?)?sidebar$/) ? 'aside'
    : is(/^(site-?|page-?)?(header|masthead|topbar)$/) ? 'header'
    : is(/^(site-?|page-?)?footer$/) ? 'footer' : null;
}

// ---------- DOM -> markdown ----------

const isInline = n => INLINE.has(n.localName) && !n.hasAttribute('data-sift-block');
const oneLine = s => s.split('\n').map(l => l.replace(/^(#{1,6}|[-*>]|\d+\.)\s+/, '').trim())
  .filter(l => l && !/^(:{3,}.*|---|```.*)$/.test(l)).join(' · ');
const fence = (kind, label, inner) => inner.trim() ? `::: ${kind}${label ? ` "${label}"` : ''}\n${inner.trim()}\n:::` : '';
const label = n => (n.getAttribute('aria-label') || '').trim();

function blocksOf(nodes, ctx) {
  const out = [];
  let buf = '', items = [];
  const flushText = () => {
    const t = buf.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (t) out.push(t);
    buf = '';
  };
  const flushItems = () => {
    if (!items.length) return;
    out.push(ctx.compact && items.every(s => s.length < 60) ? items.map(s => s.slice(2)).join(' · ') : items.join('\n'));
    items = [];
  };
  nodes = [...nodes];
  const card = repeated(nodes);
  for (const n of nodes) {
    if (card?.(n)) {
      flushText();
      const parts = (isInline(n) ? oneLine(inline(n, ctx)) : [...n.childNodes].map(c => oneLine(c.nodeType === 3 ? c.data : c.nodeType !== 1 ? '' : isInline(c) ? inline(c, ctx) : blocksOf(c.childNodes, ctx))).filter(Boolean).join(' · ')).split(' · ');
      // product image alt usually repeats the title: drop it
      const t = parts.filter((p, i) => { const alt = /^!\[([^\]]+)\]\(/.exec(p)?.[1]; return !(alt && parts.some((q, j) => j !== i && q.includes(alt))); }).join(' · ');
      if (t) { items.push('- ' + t); ctx.stats.cards++; }
    } else if (n.nodeType === 3) {
      if (n.data.trim()) flushItems();
      buf += n.data.replace(/\s+/g, ' ');
    } else if (n.nodeType !== 1) continue;
    else if (isInline(n)) { flushItems(); buf += gap(n) + inline(n, ctx); }
    else { flushText(); flushItems(); const b = block(n, ctx); if (b) out.push(b); }
  }
  flushText(); flushItems();
  return out.join('\n\n');
}

// grids of same-shaped short link/image blocks (product cards, news teasers) -> one line each
function repeated(nodes) {
  const els = nodes.filter(n => n.nodeType === 1);
  if (els.length < 3) return null;
  const sig = e => e.localName + '.' + (e.getAttribute('class') || '').trim().split(/\s+/)[0];
  const count = new Map();
  for (const e of els) count.set(sig(e), (count.get(sig(e)) || 0) + 1);
  const [best, n] = [...count].sort((a, b) => b[1] - a[1])[0];
  if (n < 3 || n < els.length * 0.6 || /^(p|h\d|li|tr|td|th|dt|dd|br|span|img|pre|table|ul|ol|dl|blockquote|figure|section|option)\./.test(best)) return null;
  const group = els.filter(e => sig(e) === best);
  const avg = group.reduce((s, e) => s + textLen(e), 0) / n;
  const cardy = group.filter(e => e.querySelectorAll('*').length >= 2 && (e.matches('a,button') || e.querySelector('a,img,button'))).length;
  if (avg > (n >= 6 ? 700 : 300) || cardy < n * 0.6 || group.some(e => e.querySelector('h1,pre,table'))) return null;
  return e => e.nodeType === 1 && sig(e) === best;
}

function block(n, ctx) {
  const tag = n.localName;
  if (/^h[1-6]$/.test(tag)) {
    const t = oneLine(inlineOf(n, ctx)).replace(/\s+/g, ' ');
    return t && (ctx.compact ? `**${t}**` : '#'.repeat(+tag[1]) + ' ' + t);
  }
  switch (tag) {
    // controls rendered as blocks (data-sift-block) keep their inline form
    case 'a': case 'button': case 'img': case 'input': case 'select': case 'textarea': return oneLine(inline(n, ctx));
    case 'ul': case 'ol': case 'menu': return list(n, ctx);
    case 'table': return table(n, ctx);
    case 'pre': return pre(n);
    case 'blockquote': return blocksOf(n.childNodes, ctx).replace(/^/gm, '> ');
    case 'hr': return '---';
    case 'dl': return dl(n, ctx);
    case 'figcaption': { const t = oneLine(blocksOf(n.childNodes, ctx)); return t && `*${t}*`; }
    case 'iframe': case 'video': case 'audio': {
      const u = abs(n.getAttribute('src') || n.querySelector('source')?.getAttribute('src'), ctx.base);
      return u ? `[${tag === 'iframe' ? 'embed' : tag}](${short(u, ctx.base)})` : '';
    }
    case 'details': {
      const s = n.querySelector('summary');
      return fence('details', s ? oneLine(inlineOf(s, ctx)) : '', blocksOf([...n.childNodes].filter(c => c !== s), ctx));
    }
    case 'form': ctx.stats.forms++; return fence('form', label(n) || n.getAttribute('name'), blocksOf(n.childNodes, ctx));
    case 'nav': case 'aside': case 'dialog':
      return fence(tag, label(n), blocksOf(n.childNodes, { ...ctx, compact: tag === 'nav' || ctx.compact }));
  }
  return blocksOf(n.childNodes, ctx);
}

function list(n, ctx) {
  const ordered = n.localName === 'ol';
  let i = +n.getAttribute('start') || 1;
  const items = [];
  for (const li of n.children) {
    let t = blocksOf(li.childNodes, ctx).trim();
    if (!t) continue;
    if (!li.querySelector('ul,ol,pre,table')) t = oneLine(t);
    else if (ctx.compact) { const [h, ...rest] = t.split(/\n{2,}/); t = oneLine(h) + (rest.length ? ': ' + rest.map(oneLine).join(' · ') : ''); }
    const p = ordered ? `${i++}. ` : '- ';
    items.push(p + t.replace(/\n{2,}/g, '\n').replace(/\n/g, '\n' + ' '.repeat(p.length)));
  }
  if (ctx.compact && items.every(s => s.length < 60 && !s.includes(': '))) return items.map(s => s.replace(/^(- |\d+\. )/, '')).join(' · ');
  return items.join('\n');
}

function table(n, ctx) {
  const rows = [...n.querySelectorAll('tr')].filter(tr => tr.closest('table') === n)
    .map(tr => [...tr.children].filter(c => c.localName === 'td' || c.localName === 'th'));
  const span = c => Math.max(1, +c.getAttribute('colspan') || 1);
  const cols = Math.max(0, ...rows.map(r => r.reduce((s, c) => s + span(c), 0)));
  if (cols < 2 || n.querySelector('table') || n.getAttribute('role') === 'presentation') return blocksOf(n.childNodes, ctx);
  ctx.stats.tables++;
  const grid = rows.filter(r => r.length).map(r => {
    const v = r.flatMap(c => [oneLine(blocksOf(c.childNodes, ctx)).replace(/\|/g, '\\|'), ...Array(span(c) - 1).fill('')]);
    while (v.length < cols) v.push('');
    return v;
  });
  // layout tables leave whole columns empty (spacers, vote arrows)
  const keep = [...Array(cols).keys()].filter(i => grid.some(v => v[i]));
  const lines = grid.map(v => `| ${keep.map(i => v[i]).join(' | ')} |`);
  lines.splice(1, 0, '|' + ' --- |'.repeat(keep.length));
  const cap = n.querySelector('caption');
  return (cap ? `Table: ${oneLine(blocksOf(cap.childNodes, ctx))}\n` : '') + lines.join('\n');
}

function pre(n) {
  const code = n.textContent.replace(/\n+$/, '');
  const cls = [n, n.querySelector('code'), n.closest('[class*=brush],[class*=language-]')].map(e => e?.getAttribute('class') || '').join(' ');
  const lang = /(?:lang(?:uage)?-|brush:\s*)([\w+#-]+)/.exec(cls)?.[1] || '';
  const f = code.includes('```') ? '````' : '```';
  return code.trim() ? `${f}${lang}\n${code}\n${f}` : '';
}

function dl(n, ctx) {
  const out = [];
  for (const x of [...n.children].flatMap(c => c.localName === 'div' ? [...c.children] : [c])) {
    const t = oneLine(blocksOf(x.childNodes, ctx));
    if (!t) continue;
    if (x.localName === 'dt') out.push(`**${t}**:`);
    else if (out.length) out[out.length - 1] += ' ' + t;
    else out.push(t);
  }
  return out.join('\n');
}

// block children inside inline elements become separate lines; callers oneLine() them
// adjacent elements with no whitespace between are usually separate visual pieces (flex items etc.)
const gap = n => n.previousSibling?.nodeType === 1 ? ' ' : '';
const inlineOf = (n, ctx) => [...n.childNodes].map(c =>
  c.nodeType === 3 ? c.data.replace(/\s+/g, ' ') : c.nodeType !== 1 ? '' : isInline(c) ? gap(c) + inline(c, ctx) : `\n${oneLine(block(c, ctx))}\n`).join('');

function wrap(t, m) {
  const s = t.trim().replace(/\s+/g, ' ');
  return s ? t.match(/^\s*/)[0] + m + s + m + t.match(/\s*$/)[0] : t;
}

function inline(n, ctx) {
  const name = () => n.getAttribute('aria-label') || n.getAttribute('placeholder') || n.getAttribute('name') || '';
  switch (n.localName) {
    case 'br': return '\n';
    case 'img': {
      const alt = (n.getAttribute('alt') || '').replace(/[[\]\s]+/g, ' ').trim();
      const src = [n.getAttribute('src'), n.getAttribute('data-src'), n.getAttribute('srcset')?.split(/[\s,]/)[0]].find(s => s && !s.startsWith('data:'));
      const u = !ctx.compact && alt && abs(src, ctx.base);
      if (!u) return '';
      ctx.stats.images++;
      return `![${alt}](${short(u, ctx.base)})`;
    }
    case 'a': {
      const t = oneLine(inlineOf(n, ctx)).trim() || n.getAttribute('aria-label') || n.getAttribute('title') || n.querySelector('img')?.getAttribute('alt')?.trim() || '';
      const u = abs(n.getAttribute('href'), ctx.base);
      // ponytail: >100-char query values are state/tracking blobs (avito context=, etc); signed links lose them too
      if (u) for (const [k, v] of [...u.searchParams]) if (v.length > 100) u.searchParams.delete(k);
      if (!t || !u) return t ? ` ${t} ` : '';
      ctx.stats.links++;
      if (/^https?:/.test(u.protocol)) ctx.links.push({ url: u.href, text: t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'), region: ctx.region });
      return `[${t}](${short(u, ctx.base)})`;
    }
    case 'code': case 'kbd': case 'samp': { const t = n.textContent.replace(/\s+/g, ' ').trim(); return t ? '`' + t + '`' : ''; }
    case 'strong': case 'b': return wrap(inlineOf(n, ctx), '**');
    case 'em': case 'i': return wrap(inlineOf(n, ctx), '*');
    case 'del': case 's': return wrap(inlineOf(n, ctx), '~~');
    case 'button': { const t = oneLine(inlineOf(n, ctx)).trim() || n.getAttribute('aria-label') || n.getAttribute('title'); return t ? ` [button: ${t}] ` : ''; }
    case 'select': {
      const o = [...n.querySelectorAll('option')].map(o => [o.textContent.trim(), o.hasAttribute('selected')]).filter(([t]) => t).map(([t, s]) => s ? `*${t}*` : t);
      return ` [select${name() ? ` "${name()}"` : ''}: ${o.slice(0, 30).join(' | ')}${o.length > 30 ? ` | …+${o.length - 30}` : ''}] `;
    }
    case 'textarea': return ` [textarea${name() ? ` "${name()}"` : ''}] `;
    case 'input': {
      const type = (n.getAttribute('type') || 'text').toLowerCase(), v = n.getAttribute('value');
      if (type === 'checkbox' || type === 'radio') return n.hasAttribute('checked') ? '[x] ' : '[ ] ';
      if (/^(submit|button|reset|image)$/.test(type)) return ` [button: ${v || n.getAttribute('alt') || type}] `;
      return ` [input${type === 'text' ? '' : ' ' + type}${name() ? ` "${name()}"` : ''}${v ? ` = ${v}` : ''}${n.hasAttribute('required') ? ' required' : ''}] `;
    }
  }
  return inlineOf(n, ctx);
}

function abs(href, base) {
  href = href?.trim();
  if (!href || /^(javascript:|data:|#)/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u;
  } catch { return null; }
}
const short = (u, base) => u.origin === base.origin && u.origin !== 'null' ? u.pathname + u.search + u.hash : u.href;

// ---------- page API ----------

export class Page {
  constructor(o) { Object.assign(this, o); }

  head() {
    const m = this.meta;
    const fm = ['---', `url: ${this.url}`, ...['title', 'description', 'lang', 'published', 'author'].filter(k => m[k]).map(k => `${k}: ${String(m[k]).replace(/\s+/g, ' ')}`), '---'];
    if (m.data.length) fm.push('', ':::: data #jsonld', ...m.data.map(d => { const s = JSON.stringify(d); return s.length > 1500 ? s.slice(0, 1500) + '…' : s; }), '::::');
    return fm.join('\n');
  }

  fence(r) { return `:::: ${r.role} #${r.id}${r.label ? ` "${r.label}"` : ''}\n${r.md}\n::::`; }

  outline() {
    const m = this.meta;
    const L = [`# ${m.title || this.url}`, `${this.url} · lang ${m.lang || '?'} · full ≈${tokens(this.read())} tok`];
    if (m.description) L.push(`> ${m.description.replace(/\s+/g, ' ')}`);
    if (m.data.length) L.push(`jsonld: ${m.data.map(d => [d['@type']].flat().join('/')).join(', ')} (in full read / section=data)`);
    L.push('');
    for (const r of this.regions) {
      const s = Object.entries(r.stats).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
      const preview = r.md.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*`|>:§-]{2,}|\s+/g, ' ').trim().slice(0, 100);
      L.push(`${r.id} ${r.role}${r.label ? ` "${r.label}"` : ''} ≈${r.tokens} tok${s ? ' · ' + s : ''}`, `   "${preview}${preview.length >= 100 ? '…' : ''}"`);
      const min = Math.min(...r.heads.map(h => h.level));
      for (const h of r.heads) L.push(`${'  '.repeat(h.level - min + 1)}${h.id} ${'#'.repeat(h.level)} ${h.text} ≈${h.tokens}`);
    }
    L.push('', 'read: section=r3|§5|main|nav|data · grep=regex · maxTokens+page for paging');
    return L.join('\n');
  }

  read({ section, grep, maxTokens = Infinity, page = 1 } = {}) {
    const md = grep ? this.grep(grep) : section ? this.section(section)
      : [this.head(), ...this.regions.map(r => this.fence(r))].join('\n\n');
    return paginate(md, maxTokens, page);
  }

  section(id) {
    id = String(id).trim().replace(/^(s|§)?(\d+)$/i, '§$2');
    if (id === 'data') return this.head();
    const rs = this.regions.filter(r => r.id === id || r.role === id || (id === 'main' && r.role === 'content'));
    if (rs.length) return rs.map(r => this.fence(r)).join('\n\n');
    if (id === 'main') return this.read();
    for (const r of this.regions) {
      const h = r.heads.find(h => h.id === id);
      if (h) return `:::: ${r.role} #${r.id} › ${id}\n${r.lines.slice(h.line, h.end).join('\n')}\n::::`;
    }
    throw new Error(`no section "${id}" — ids: ${this.regions.map(r => r.id).join(', ')}, §1..§${this.regions.flatMap(r => r.heads).length}`);
  }

  grep(q) {
    let re;
    try { re = new RegExp(q, 'i'); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const out = [];
    for (const r of this.regions) {
      let h = null;
      for (let b of r.md.split(/\n{2,}/)) {
        if (/^#{1,6} /.test(b)) h = b;
        if (!re.test(b)) continue;
        if (b.length > 800) b = b.split('\n').filter(l => re.test(l)).join('\n');
        out.push(`[${r.id} ${r.role}${h && h !== b ? ' › ' + h.replace(/^#+ /, '') : ''}]\n${b}`);
      }
    }
    return out.join('\n\n') || `no matches for /${q}/`;
  }
}

function paginate(md, max, page) {
  if (!(max < Infinity) || tokens(md) <= max) return md;
  const pages = [];
  let cur = '';
  for (const b of md.split(/\n{2,}/).flatMap(b => tokens(b) > max ? b.split('\n') : [b])) {
    if (cur && tokens(cur + b) > max) { pages.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + b;
  }
  pages.push(cur);
  const i = Math.min(Math.max(+page || 1, 1), pages.length) - 1;
  return `${pages[i]}\n\n[page ${i + 1}/${pages.length} · ≈${tokens(md)} tok total${i + 1 < pages.length ? ` · next: page=${i + 2}` : ''}]`;
}
