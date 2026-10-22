import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, plain, close } from './fetch.js';
import { extract, tokens } from './extract.js';

export { extract, close, tokens };

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// url | local file path -> Page  (opts: engine browser|fetch, maxAge seconds, timeout ms, interactive)
export async function scrape(url, opts = {}) {
  const file = url.replace(/^file:\/\//, '');
  if (!/^https?:\/\//.test(url) && existsSync(file)) return extract(await readFile(file, 'utf8'), pathToFileURL(resolve(file)).href);
  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
  const r = await load(url, opts);
  return extract(/html/.test(r.type) ? r.html : `<pre>${esc(r.html)}</pre>`, r.url);
}

// same-origin links of a page + sitemap urls
export async function map(url, { search, limit = 5000, sitemap = true, ...opts } = {}) {
  const page = await scrape(url, opts);
  const origin = new URL(page.url).origin, found = new Map();
  for (const l of page.links) {
    const u = l.url.split('#')[0];
    if (new URL(u).origin === origin && !found.has(u)) found.set(u, l.text);
  }
  if (sitemap) for (const u of await sitemapUrls(origin)) if (!found.has(u)) found.set(u, '');
  const re = search && new RegExp(search, 'i');
  return [...found].filter(([u, t]) => !re || re.test(u) || re.test(t)).slice(0, limit).map(([url, text]) => ({ url, text }));
}

async function sitemapUrls(origin) {
  const queue = [], out = [];
  try { queue.push(...[...(await plain(origin + '/robots.txt')).html.matchAll(/^sitemap:\s*(\S+)/gim)].map(m => m[1])); } catch {}
  if (!queue.length) queue.push(origin + '/sitemap.xml');
  // ponytail: 10 sitemap files max, enough for map(); crawl() follows links anyway
  for (let i = 0; i < queue.length && i < 10; i++) {
    try {
      const { html, status } = await plain(queue[i]);
      if (status >= 400) continue;
      const locs = [...html.matchAll(/<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));
      (/<sitemapindex/i.test(html) ? queue : out).push(...locs);
    } catch {}
  }
  return out.filter(u => u.startsWith(origin));
}

// BFS over same-origin links under the start url's directory
export async function crawl(url, { limit = 10, depth = 2, include, exclude, concurrency = 4, ...opts } = {}) {
  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
  const start = new URL(url), prefix = start.origin + start.pathname.replace(/[^/]*$/, '');
  const inc = include && new RegExp(include), exc = exclude && new RegExp(exclude);
  const norm = u => u.split('#')[0].replace(/\/$/, '');
  const seen = new Set([norm(url)]), queue = [[url, 0]], pages = [];
  while (queue.length && pages.length < limit) {
    await Promise.all(queue.splice(0, Math.min(concurrency, limit - pages.length)).map(async ([u, d]) => {
      try {
        const p = await scrape(u, opts);
        pages.push(p);
        if (d >= depth) return;
        for (const { url: l } of p.links) {
          const n = norm(l);
          if (seen.has(n) || !n.startsWith(prefix) || /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3)$/i.test(n) || (inc && !inc.test(n)) || (exc && exc.test(n))) continue;
          seen.add(n);
          queue.push([l, d + 1]);
        }
      } catch (e) {
        pages.push({ url: u, error: e.message });
      }
    }));
  }
  return pages;
}
