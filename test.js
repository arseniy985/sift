import assert from 'node:assert/strict';
import { extract } from './src/extract.js';

const html = `<html lang="ru"><head><title>Shop</title><meta name="description" content="desc">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Boots","offers":{"price":"1990"}}</script></head>
<body><div id="app">
<header><a href="/">Logo</a><nav aria-label="Main"><ul><li><a href="/a?utm_source=x">A</a></li><li><a href="/b">B</a></li></ul></nav></header>
<div class="cookie-banner">We use cookies <button>OK</button></div>
<main>
  <h1>Boots</h1><p>Great <b>boots</b>. <span hidden>secret</span></p>
  <div class="grid">
    <div class="card"><a href="/p/1">Boot 1</a><span>100 ₽</span><button>Buy</button></div>
    <div class="card"><a href="/p/2">Boot 2</a><span>200 ₽</span><button>Buy</button></div>
    <div class="card"><a href="/p/3">Boot 3</a><span>300 ₽</span><button>Buy</button></div>
  </div>
  <h2>Specs</h2><table><tr><th>Size</th><th>Color</th></tr><tr><td>42</td><td>black</td></tr></table>
  <div role="tabpanel" style="display:none"><h2>Reviews</h2><p>Nice</p></div>
  <form><input type="email" placeholder="Email" required><select name="size"><option>41</option><option selected>42</option></select></form>
</main>
<aside><h3>Related</h3><p>Socks</p></aside>
<footer><ul><li><a href="https://vk.com/x">VK</a></li><li><a href="/about">About</a></li></ul></footer>
</div></body></html>`;

const p = extract(html, 'https://shop.test/item');
assert.deepEqual(p.regions.map(r => r.role), ['header', 'dialog', 'main', 'aside', 'footer']);
const md = p.read();
assert.match(md, /\[A\]\(\/a\) · \[B\]\(\/b\)/, 'nav compacted, tracking stripped');
assert.match(md, /- \[Boot 2\]\(\/p\/2\) · 200 ₽ · \[button: Buy\]/, 'cards -> one line');
assert.match(md, /\| 42 \| black \|/, 'table');
assert.match(md, /## Reviews/, 'hidden tab panel kept');
assert.doesNotMatch(md, /secret/, 'hidden span dropped');
assert.match(md, /\[input email "Email" required\]/);
assert.match(md, /\[select "size": 41 \| \*42\*\]/);
assert.match(md, /"@type":"Product"/, 'jsonld');
assert.match(md, /\[VK\]\(https:\/\/vk.com\/x\)/, 'external link absolute');
assert.match(p.section('§2'), /^:::: main #r3 › §2\n## Specs §2\n\n\| Size/);
assert.match(p.grep('black'), /\[r3 main › Specs §2\]/);
assert.match(p.outline(), /r3 main ≈\d+ tok · .*3 cards/);
assert.equal(p.read({ maxTokens: 50 }).includes('[page 1/'), true);
console.log('ok');
