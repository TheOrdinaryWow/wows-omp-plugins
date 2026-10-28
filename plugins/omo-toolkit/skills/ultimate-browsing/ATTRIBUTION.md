> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Attribution and distribution boundary

The routing and reference prose in this directory adapts project-original oh-my-openagent material from:

- `packages/shared-skills/skills/ultimate-browsing/SKILL.md`
- `packages/shared-skills/skills/ultimate-browsing/ATTRIBUTION.md`
- `packages/shared-skills/skills/ultimate-browsing/references/insane-search/**`
- `packages/shared-skills/skills/ultimate-browsing/references/agent-reach/**`
- `packages/shared-skills/skills/ultimate-browsing/references/chrome-stealth.md`

Source revision: `8a8db1d3094da8743989bf693ee5de77889de50e` in [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent).

This OMP edition rewrites the routing around native `read` and eval `browser`, makes archive provenance explicit, and omits executable extraction machinery. Its references describe manual native routes; their directory names do not imply an installed engine or agent-reach service.

## Deliberate omissions

The upstream skill contains a modified, vendored [fivetaku/insane-search](https://github.com/fivetaku/insane-search) engine from a pre-0.7.0 snapshot imported by upstream commit `a4e4ed797`. Upstream's attribution says that snapshot did not include an upstream LICENSE. The root SUL notice is not evidence of redistribution rights for that third-party code. **No `engine/**` code, configuration, templates or engine fixtures are redistributed here.**

The upstream cookie-export/decryption/injection scripts and their tests are also omitted by design. This edition does not read browser credential stores or provide cross-profile cookie transfer. Authenticated tasks use the user's existing attached session.

Platform names and optional external tools (for example V2EX APIs, yt-dlp, gh and Jina Reader) identify independent services/software, not bundled integrations or source code. Their availability, credentials and terms are separate prerequisites; this skill neither installs them nor grants access.
