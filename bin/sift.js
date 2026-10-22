#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `sift — local page -> semantic markdown for AI agents

  sift <url|file> [options]     read a page (full semantic markdown)
  sift map <url> [--search re]  same-origin links + sitemap
  sift crawl <url> [--limit 10] [--depth 2] [--include re] [--exclude re] [--out dir]
  sift mcp                      run MCP server on stdio

read options:
  -o, --outline        cheap page map: regions, §sections, token sizes (start here)
  -s, --section ID     r3 | §5 | main | nav | footer | data
  -g, --grep RE        only blocks matching regex, with their section path
  -m, --max-tokens N   page the output; --page N for next pages
      --json           Page as JSON (regions, links, meta)
common:
      --engine browser|fetch   real Chrome (default) or plain HTTP
      --fresh                  ignore 10-min cache
      --no-interactive         never open a visible window for captchas`;

const { values: o, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    outline: { type: 'boolean', short: 'o' }, section: { type: 'string', short: 's' }, grep: { type: 'string', short: 'g' },
    'max-tokens': { type: 'string', short: 'm' }, page: { type: 'string' }, json: { type: 'boolean' },
    engine: { type: 'string', default: 'browser' }, fresh: { type: 'boolean' }, 'no-interactive': { type: 'boolean' },
    search: { type: 'string' }, limit: { type: 'string' }, depth: { type: 'string' }, include: { type: 'string' }, exclude: { type: 'string' },
    out: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, arg] = ['map', 'crawl', 'mcp'].includes(pos[0]) ? pos : ['read', pos[0]];
if (cmd === 'mcp') await import('../src/mcp.js');
else if (o.help || !arg) console.log(HELP);
else {
  const { scrape, map, crawl, close } = await import('../src/index.js');
  const opts = { engine: o.engine, maxAge: o.fresh ? 0 : 600, interactive: !o['no-interactive'] };
  try {
    if (cmd === 'map') {
      for (const l of await map(arg, { ...opts, search: o.search, limit: +o.limit || 5000 })) console.log(l.text ? `${l.url}  ${l.text}` : l.url);
    } else if (cmd === 'crawl') {
      const pages = await crawl(arg, { ...opts, limit: +o.limit || 10, depth: +o.depth || 2, include: o.include, exclude: o.exclude });
      if (o.out) await mkdir(o.out, { recursive: true });
      for (const p of pages) {
        if (p.error) { console.error(`✗ ${p.url}: ${p.error}`); continue; }
        const md = p.read();
        if (!o.out) { console.log(md + '\n\n'); continue; }
        const f = join(o.out, (new URL(p.url).pathname.replace(/^\/|\/$/g, '').replace(/[^\w.-]+/g, '_') || 'index') + '.md');
        await writeFile(f, md);
        console.error(`✓ ${f}`);
      }
    } else {
      const p = await scrape(arg, opts);
      console.log(o.json ? JSON.stringify(p, (k, v) => k === 'lines' ? undefined : v, 2)
        : o.outline ? p.outline()
        : p.read({ section: o.section, grep: o.grep, maxTokens: +o['max-tokens'] || Infinity, page: +o.page || 1 }));
    }
  } catch (e) {
    console.error('sift: ' + e.message);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
