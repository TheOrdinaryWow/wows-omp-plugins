// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { brokenImage } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/broken-image";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  ['<img alt="photo" />', "a.tsx", 1],
  ['<img\nsrc="#"\n/>', "a.tsx", 1],
  ["<img src={url} />", "a.tsx", 0],
  ['<img srcset="a.webp 1x" />', "a.tsx", 0],
  ["<img {...props} />", "a.tsx", 0],
  ['<img data-caption="src=example" />', "a.tsx", 1],
  ['const example = "<img>";', "a.tsx", 0],
  ['<script>const example = "<img>";</script><img src="a.png">', "a.vue", 0],
  ['<img :src="url" />', "a.vue", 0],
  ["<img {src} />", "a.svelte", 0],
  ['<img src="" />', "a.astro", 1],
  ["// Plain <img> comment\nexport const A=()=> <img src='a.png'/>;", "a.tsx", 0],
  ['<div>{"<img>"}</div>', "a.tsx", 0],
  ["const pattern=/<img>/;", "a.tsx", 0],
  ["<div>{url ? <img src={url}/> : <img/>}</div>", "a.tsx", 1],
])("#given image source %s #then returns expected findings", (source, path, count) => {
  expect(checkSource(brokenImage, source, { path })).toHaveLength(count);
});

test("#given a multiline missing image #then identifies its opening position", () => {
  expect(checkSource(brokenImage, "\n  <img\n    alt='photo'\n  />")[0]).toMatchObject({ line: 2, column: 3 });
});
