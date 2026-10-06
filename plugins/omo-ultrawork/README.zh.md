# omo-ultrawork

[English](README.md) | 简体中文

本插件将 oh-my-openagent 的 ultrawork 关键词模式、按依赖顺序执行的 `mass-ulw`、对抗式 `/hyperplan` 和以研究饱和为收敛目标的 `/ulw-research` 适配到 OMP。

## 安装

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

本插件不安装运行时依赖。`/ulw-research` 需要 PATH 中有 `node` 才能生成报告。辅助脚本是不依赖第三方包的 Node CLI，随插件放在 `assets/ulw-research/scripts/` 下，命令会传入这些脚本的绝对路径。

## Ultrawork 模式

在消息中输入独立单词 `ulw` 或 `ultrawork`，会在你的文本前注入完整的隐藏 ultrawork 指令，回复以 `ULTRAWORK MODE ENABLED!` 开头。同一会话中后续触发时只会注入简短提醒，因为完整指令仍在上下文中。上下文压缩后，下次触发会再次注入完整指令。

`/ultrawork` 或 `/ulw` 会开启持续模式。之后无需关键词，每条消息都会收到提醒，或在上下文压缩后收到完整指令。再次运行任一命令会关闭持续模式，并将一条隐藏的退出通知加入队列。指令何时送达取决于开启模式的时机：

- 带参数时（`/ultrawork fix X`）：指令加入队列，参数作为你的下一条消息发送；
- 空闲时不带参数：指令随你的下一条消息发送；
- 当前轮次执行期间：指令加入正在执行的轮次。

持续模式开启时，底栏显示 `Ultrawork mode`；通过关键词触发后，显示 `Ultrawork armed`。退出模式或切换到未进入待触发状态的会话时，该提示会清除。模式、待触发状态和提醒状态会保存在会话中，并在恢复、切换、创建分支和树形导航时还原。子会话及扩展生成的消息会被忽略。

行内代码、围栏代码块、注入的指令或提醒块以及斜杠命令中的关键词不会触发模式。粘贴完整的 `<ultrawork-mode>…</ultrawork-mode>` 块会让会话进入待触发状态，但不会重复注入该指令。

输入 `mass ulw`、`mass-ulw`、`ulw-mass`、`mulw` 或 `meth` 还会注入指向 `skill://mass-ulw` 的提示；`mulw` 和 `meth` 本身不会让 ultrawork 进入待触发状态。处于待触发状态时，首次 `todo init` 或 `todo append` 会触发一次隐藏提醒，要求代理评估独立工作的规模，并说明其委派选择。上下文压缩会重置这条提醒。

### 不要与 `orchestrate` 同时使用

OMP 内置的 `orchestrate` 魔法关键词会注入自己的编排规则，这些规则在提交、验证和委派方面与 ultrawork 冲突。当消息包含 OMP 会处理的独立单词 `orchestrate` 时，即该关键词已启用且 `task` 工具可用，本插件不会为这条消息注入任何内容，并会显示警告。持续模式仍然开启，并从下一条消息恢复。`/ultrawork orchestrate …` 和 `/ulw orchestrate …` 会拒绝开启持续模式。如果你经常使用 ultrawork，请关闭内置关键词：

```bash
omp config set magicKeywords.orchestrate false
```

## mass-ulw

模型可以调用 `mass-ulw` 技能，通过 `eval` 执行由 `{ id, prompt, agent, dependsOn?, label? }` 节点组成的依赖图。启动任何子代理前，技能会校验所有 ID、依赖、环路和已保存的状态。每个代码单元执行一批当前就绪的节点，代理读取返回的报告后才启动下一批。

状态（`local://mass-ulw/<run-key>.json`）和报告（`local://mass-ulw/<run-key>/<id>.md`）在内核重置后仍然保留，但已保存的 `running` 句柄无法重新接入 `wait`，必须先核实并更新其状态，才能继续派发工作。`done` 只表示子代理已返回；最后一批验证节点会检查证据是否满足验收要求。重试或修改部分节点不会影响其他 `done` 节点的报告。

对于没有依赖的独立工作，直接使用一次普通的 `task` 批量调用即可。使用前请阅读 `skill://mass-ulw` 及其规划参考资料。

## 命令

`/hyperplan <request>` 会让五种角色进行三轮对抗式辩论，然后交给独立的规划代理。质疑者使用 `task`，验证者使用带 `effort: "hi"` 的 `task`；研究者、架构师和创意角色在代理列表包含对应代理时，分别使用 `deep-low`、`ultrabrain` 和 `artistry`。没有 `deep-low` 时，辩论由四种角色进行；缺少 `ultrabrain` 或 `artistry` 时则回退到 `task`。规划代理使用 `ultrabrain`，不可用时使用 `task`。首条可见内容为 `HYPERPLAN MODE ENABLED!`。

`/ulw-research <request>` 通过扩展和反向检索构建论断图，撰写带引用的综合分析，按顺序运行 QA 关卡，并检查交付物。机械性工作交给 `sonic`，范围明确的判断交给 `task`，需要深入分析的工作交给带 `effort: "hi"` 的 `task`。`scout` 负责本地发现，`librarian`（或 `scout`）负责来源研究，`writing`（或 `task`）负责校对；其他分类代理不可用时回退到 `task`。临时文件存放在 `<tmpdir>/ulw-research/` 或配置的 `researchScratchDir` 中，最终输出存放在你指定的位置。首条可见内容为 `ULW-RESEARCH MODE ENABLED!`。

两个命令都会拒绝空请求，且仅在主会话中运行。它们的流程保存在私有提示词资源中，没有注册为技能。子代理和模型无法通过 `skill://` 或 `/skill:` 发现或调用这些流程。`mass-ulw` 是本插件唯一公开的技能。

安装 `omo-toolkit` 可获得上述指定的分类代理，安装 `omo-prometheus` 可获得经过审查的 `/prometheus` 规划选项；未安装时，上述回退机制仍能让所有命令正常工作。`metis` 仅用于 Prometheus 规划；`momus` 在规划之外仅用于明确要求的 Atlas 合规检查。

需要完整审查的工作应遵循负责该工作的计划。独立的合规、代码质量和真实界面 QA 报告可以并行生成，最终的证据关卡审查者在这些报告完成后开始。不要在已批准的计划之外另加一套审查流程。轻量工作只需限定范围的自查和真实界面证据，无需安排并行审查者。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-omo-ultrawork`。

```bash
omp plugin config list wows-omp-plugin-omo-ultrawork
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `keywordTrigger` | 布尔值 | `true` | 为 false 时，输入关键词不会让 ultrawork 进入待触发状态，也不会注入指令。mass-ulw 提示及各命令仍然有效。 |
| `keywords` | 逗号分隔的字符串 | `ulw,ultrawork` | 不区分大小写的完整单词触发词，引用区域内的词会被忽略；空字符串会禁用关键词触发。 |
| `researchScratchDir` | 字符串 | 空（`<tmpdir>/ulw-research`） | 研究临时文件的根目录；相对路径基于会话的 cwd 解析。 |

设置会在 `session_start` 和会话切换时读取；修改后请重启会话。

## 许可证

扩展代码和原创打包内容采用 MIT 许可证。修改后的提示词资源及随插件提供的研究脚本采用 SUL-1.0 许可证。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
