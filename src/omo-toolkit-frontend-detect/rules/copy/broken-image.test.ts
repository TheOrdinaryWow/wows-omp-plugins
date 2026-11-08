// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { brokenImage } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/copy/broken-image";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given absent empty and hash sources #then real source aliases and responsive images pass", () => {
  const snapshot = buildSnapshot([
    { tag: "img", id: "absent" },
    { tag: "img", id: "empty", attributes: { src: " " } },
    { tag: "img", id: "hash", attributes: { src: "#" } },
    { tag: "img", id: "real", attributes: { src: "photo.png" } },
    { tag: "img", id: "set", attributes: { src: "", srcset: "photo.png 1x" } },
    { tag: "img", id: "lazy", attributes: { "data-src": "photo.png" } },
    { tag: "img", id: "misleading", attributes: { alt: "src=photo.png" } },
    { tag: "div", id: "other" },
  ]);
  expect(brokenImage.check({ snapshot, config: {} }).map((hit) => hit.element?.selector)).toEqual([
    "#absent",
    "#empty",
    "#hash",
    "#misleading",
  ]);
});

test("#given placeholder srcset and valid alternate sources #then either usable attribute is enough", () => {
  const snapshot = buildSnapshot([
    { tag: "img", id: "placeholder", attributes: { src: "#", srcset: " " } },
    { tag: "img", id: "inline", attributes: { src: "data:image/svg+xml,<svg/>" } },
    { tag: "img", id: "lazyset", attributes: { "data-srcset": "/small.png 300w" } },
  ]);
  expect(brokenImage.check({ snapshot, config: {} }).map((hit) => hit.element?.selector)).toEqual(["#placeholder"]);
});
