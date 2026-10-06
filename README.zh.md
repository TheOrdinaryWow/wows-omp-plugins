# wows-omp-plugins

[English](README.md) | 简体中文

一个个人维护的 [omp](https://omp.sh) 插件市场。

需要 OMP 18.3.5 或更高版本。

## 用法

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin discover wows-omp-plugins
omp plugin install <name>@wows-omp-plugins
```

在会话中，可以改用 `/marketplace add`、`/marketplace discover` 和 `/marketplace install`。

插件默认安装到当前用户，传入 `--scope project` 时除外。安装后运行 `/reload-plugins` 加载新的技能和斜杠命令；新的工具、钩子和扩展要重启会话才生效。

更新：

```bash
omp plugin marketplace update wows-omp-plugins
omp plugin upgrade <name>@wows-omp-plugins
```

## 插件

| 插件 | 说明 | 文档 |
| --- | --- | --- |
| `audit-goal` | `/audit`：反复进行独立审计与修复，并记录轮次账本 | [README](plugins/audit-goal/README.zh.md) |
| `judge-dispatch` | 让 OMP 的 judge 角色为 `task` 调用选择子代理类型、思考强度和模型 | [README](plugins/judge-dispatch/README.zh.md) |
| `omp-herdr-dag` | 在 Herdr 侧边窗格中实时展示待办、计划、Atlas DAG 和子代理视图 | [README](plugins/omp-herdr-dag/README.zh.md) |
| `omo-prometheus` | 移植到 OMP 的 oh-my-openagent Prometheus 规划与 Atlas 执行 | [README](plugins/omo-prometheus/README.zh.md) |
| `omo-ultrawork` | Ultrawork 模式、mass-ulw、`/hyperplan` 和 `/ulw-research` | [README](plugins/omo-ultrawork/README.zh.md) |
| `omo-toolkit` | 分类与研究代理、技能以及文档类 MCP 服务器 | [README](plugins/omo-toolkit/README.zh.md) |
| `roadmap` | 由工具管理的项目轮次、阶段、TODO 和 MADR 架构决策 | [README](plugins/roadmap/README.zh.md) |

## 仓库结构

```
.omp-plugin/marketplace.json   catalog listing every published plugin
plugins/<name>/                one directory per plugin, with its own README
src/                           repo tooling and tests
```

安装插件时只复制插件自己的目录，所以每个插件都自包含，没有运行时依赖。

## 开发

```bash
bun install

bun run check          # Biome lint + format check
bun run check-types    # tsc
bun run check-catalog  # catalog vs. plugins/ drift check
```

[AGENTS.md](AGENTS.md) 说明插件编写规则、安装限制和本地测试方法。

## 许可证

除非插件另有说明，为本仓库编写的代码和内容均采用 MIT 许可证。三个 `omo-*` 插件包含经过修改的 OmO 提示词资源，适用 Sustainable Use License 1.0；详见各插件的 README 和许可证文件。
