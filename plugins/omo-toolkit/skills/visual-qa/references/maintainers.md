> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# visual-qa maintainer notes

`scripts/visual-qa.mjs` is the only executable shipped by this skill. It is a zero-dependency Node bundle; upstream TypeScript sources and tests are not distributed with this port. Treat the bundle as vendored upstream output: replace it from a pinned upstream build instead of hand-editing it.

Commands:

```bash
node <skill-directory>/scripts/visual-qa.mjs image-diff <reference.png> <actual.png>
node <skill-directory>/scripts/visual-qa.mjs tui-check <capture.txt> --cols 80
```

`image-diff` reports dimensions, alpha, similarity and 8x8 hotspot cells. `tui-check` reports overflow, border alignment and wide-character columns. Width calculations account for CJK wide characters and ANSI escapes; never compare terminal widths with `String.length`. Keep the bundle limited to `node:` built-ins.

For live browser capture use the OMP `browser` tool. Do not install a separate browser automation package as part of this skill.
