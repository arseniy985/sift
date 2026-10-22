import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { scrape, map, crawl, close } from './index.js';

const server = new McpServer({ name: 'sift', version: '0.1.0' });
const text = s => ({ content: [{ type: 'text', text: s }] });
const common = {
  url: z.string().describe('http(s) URL or local html file path'),
  engine: z.enum(['browser', 'fetch']).optional().describe('browser = real Chrome, handles JS & anti-bot (default); fetch = fast plain HTTP'),
  fresh: z.boolean().optional().describe('bypass the 10-minute page cache'),
};
const opts = a => ({ engine: a.engine, maxAge: a.fresh ? 0 : 600 });

server.registerTool('outline', {
  description: 'START HERE for any web page. Returns a cheap map instead of the page: title, description, jsonld types, '
    + 'regions (r1 header, r2 nav, r3 main, r4 aside, r5 footer…) with token sizes, link/table/form/card counts, a text preview, '
    + 'and the heading tree with §ids and per-section token sizes. Then call `read` with section=… to pull only what you need.',
  inputSchema: common,
}, async a => text((await scrape(a.url, opts(a))).outline()));

server.registerTool('read', {
  description: 'Page as semantic markdown. Regions are fenced `:::: role #rN` (header/nav/main/content/aside/footer/dialog), '
    + 'nested `::: form|details|aside`; headings carry §ids; nav/footer are compacted to `a · b · c`; repeated cards become one line each; '
    + 'controls appear as [button: …], [input …], [select: a | *b*]; JSON-LD in `:::: data`. '
    + 'Narrow with section (r3, §5, main, nav, data) or grep (regex → matching blocks with their §path). Long output is paged.',
  inputSchema: {
    ...common,
    section: z.string().optional().describe('region id (r3), heading id (§5 or 5), role (main|nav|aside|footer|header) or data'),
    grep: z.string().optional().describe('regex; returns only matching blocks'),
    maxTokens: z.number().int().optional().describe('page size, default 8000'),
    page: z.number().int().optional(),
  },
}, async a => text((await scrape(a.url, opts(a))).read({ section: a.section, grep: a.grep, maxTokens: a.maxTokens ?? 8000, page: a.page })));

server.registerTool('map', {
  description: 'List same-origin URLs of a site (links on the page + sitemap.xml) with link text. Use to find the right page before reading.',
  inputSchema: { ...common, search: z.string().optional().describe('regex filter on url or link text'), limit: z.number().int().optional() },
}, async a => {
  const links = await map(a.url, { ...opts(a), search: a.search, limit: a.limit ?? 300 });
  return text(links.map(l => l.text ? `${l.url}  ${l.text}` : l.url).join('\n') || 'no links');
});

server.registerTool('crawl', {
  description: 'Read several pages under the start URL directory (BFS over same-origin links). Returns each page\'s main content, truncated per page.',
  inputSchema: {
    ...common,
    limit: z.number().int().optional().describe('max pages, default 10'),
    depth: z.number().int().optional().describe('link depth, default 2'),
    include: z.string().optional().describe('regex urls must match'),
    exclude: z.string().optional().describe('regex urls must not match'),
    maxTokensPerPage: z.number().int().optional().describe('default 2000'),
  },
}, async a => {
  const pages = await crawl(a.url, { ...opts(a), limit: a.limit ?? 10, depth: a.depth ?? 2, include: a.include, exclude: a.exclude });
  return text(pages.map(p => p.error ? `# ✗ ${p.url}\n${p.error}`
    : `# ${p.meta.title}\n${p.url}\n\n${p.read({ section: 'main', maxTokens: a.maxTokensPerPage ?? 2000 })}`).join('\n\n---\n\n'));
});

await server.connect(new StdioServerTransport());
process.stdin.on('close', () => close().finally(() => process.exit(0)));
