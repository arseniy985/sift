# sift

Local Firecrawl-alike for AI agents: page → semantic markdown, read by map/section instead of whole HTML.
Real Chrome via [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (no CDP leaks, real Chrome TLS, persistent profile in `~/.cache/sift/profile`).
Captcha that doesn't clear itself → visible Chrome window, solve once, cookies stay.

## Agent workflow
1. `outline` — regions (`r1 header`, `r3 main`…), `§` heading tree, token size per part, preview.
2. `read section=§7` / `section=main` / `grep=price` — only what's needed. Long output pages (`maxTokens`, `page`).

Output format: `:::: role #rN` region fences, nested `::: form|details|aside`, `## Heading §N`,
nav/footer compacted to `a · b · c`, repeated cards → one line each, `[button: …]`, `[input email "Email" required]`,
`[select "size": 41 | *42*]`, JSON-LD in `:::: data`. Same-origin links shortened to paths, tracking params dropped.

## Install
```
git clone https://github.com/arseniy985/sift && cd sift && npm i && npm link   # needs Google Chrome installed
```

## CLI
```
sift <url|file> [-o] [-s §5|r3|main] [-g regex] [-m maxTokens --page N] [--json]
sift map <url> [--search re]
sift crawl <url> [--limit 10 --depth 2 --include re --out dir]
sift mcp
--engine fetch   plain HTTP (fast, no JS)    --fresh   skip 10-min cache    --no-interactive   never open a window
```

## SDK
```js
import { scrape, map, crawl, close } from './sift/src/index.js';
const p = await scrape('https://example.com');
p.outline(); p.read({ section: 'main' }); p.read({ grep: 'price' }); p.regions; p.links; p.meta.data;
await close(); // shuts Chrome, otherwise the process stays alive
```
`extract(html, url)` works on HTML you already have.

## MCP
`claude mcp add sift -s user -- node /path/to/sift/bin/sift.js mcp` → tools `outline`, `read`, `map`, `crawl`.

`node test.js` — fixture self-check.
