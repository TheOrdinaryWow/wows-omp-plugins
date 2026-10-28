# omo-ultrawork 参考

[English](REFERENCE.md) | 简体中文

## 关键词识别

- 触发词不区分大小写，必须是代码、块引用、直引号或弯引号内容、已注入模式／引导／提醒块、转述头、URL 和英语否定调用子句之外的字面工作流词。路径、标识符、连字符及点号邻接会被拒绝，但配置为 `c++` 这类字面值仍然有效。斜杠命令由已注册处理器执行，不靠关键词触发。
- 粘贴一个完整的 `<ultrawork-mode>…</ultrawork-mode>` 块会让会话进入触发状态，但不会重复注入指令。
- 子会话和扩展生成的消息会被忽略。
- 只有当 OMP 会响应 `orchestrate`（该关键词已启用且 `task` 工具可用）时，它才会阻止注入。
- `orchestrate` 单独使用与宿主一致的扫描逻辑；工作流的引号和否定屏蔽不能隐藏宿主仍会激活的关键词。
- 引导返回独立的 `{target,intent}`；目标为 `mass-ulw`、`prometheus`、`ulw-loop` 或 `ulw-research`，意图为 `mention` 或 `binding`。规划及循环始终有条件；mass 与 research 只绑定允许连接词的句首 `run|start|use|do|execute` 正向请求，或上游精确的韩语请求结尾。提问（包括 `？`）不绑定，裸 `meth` 只作提及。URL 在问号判断前屏蔽，不新增中文语义意图分类器。
- `ulw plan`、`ulw-plan`、`ulwplan` 建议用户输入 `/prometheus`，没有钩子会开启 Plan Mode。循环提及引向显式命令。绑定调研和 `/ulw-research` 共用私有载荷构造器，包括固定资源、临时根目录设置、原生采集辅助说明，以及只复用活动循环的规则。讨论不加载流程；组合写法会去重目标与流程。

## 指令投递

开启持续模式时，指令的投递方式如下：

- 带参数（`/ultrawork fix X`）：指令排队，参数作为你的下一条消息发出；
- 空闲时不带参数：随你的下一条消息发出；
- 回合进行中：并入当前回合。

关闭模式时会排队一条隐藏的退出通知。持续模式下每条消息都会附带简短提醒，压缩之后则附带完整指令。只有在模式原本关闭时，`/ultrawork <request>` 才会提交请求。

普通输入的指令及引导通过宿主输入转换返回，保留图片，并使排队调研绑定自己的请求，而不是以 steering aside 干扰正在进行的工作。显式开关命令保留原有即时／下一消息行为。关闭 `/ulw` 不会暂停或停止明确激活的循环。

处于触发状态时，第一次 `todo init` 或 `todo append` 会触发一条隐藏提醒，要求代理评估可独立进行的工作，并说明它的委派选择。压缩会重置这条提醒。

退出模式，或切换到未触发的会话时，页脚提示会清除。切换会话或关闭时，不会清除已触发会话中保存的状态。

## 各命令使用的代理

`/hyperplan`：范围评审（`skeptic`）使用 `task`，集成评审（`validator`）使用 `effort: "hi"` 的 `task`；如果列表中有 `deep-low`、`ultrabrain` 和 `artistry`，证据评审（`researcher`）、架构评审（`architect`）和替代方案评审（`creative`）分别使用它们。没有 `deep-low` 时，辩论不含证据评审，以四个角色进行；缺少 `ultrabrain` 或 `artistry` 时回退到 `task`。规划者使用 `ultrabrain`，没有时使用 `task`。

`/ulw-research`：机械性工作交给 `sonic`，有限判断交给 `task`，高强度工作交给 `effort: "hi"` 的 `task`。`scout` 负责本地发现，`librarian`（或 `scout`）负责来源调研，`writing`（或 `task`）负责校对；其他分类代理回退到 `task`。辅助脚本是 `assets/ulw-research/scripts/` 下无依赖的 Node CLI，按绝对路径调用。

`metis` 只在 Prometheus 规划中使用；规划之外，`momus` 只用于明确的 Atlas 合规检查。

需要完整评审的工作遵循其所属的计划。独立的合规、代码质量和真实界面 QA 报告可以并行进行，这些报告齐全后才启动最终的证据关口评审。轻量工作只做限定范围的自查和真实界面验证，不并行派评审。

## mass-ulw 持久化

状态保存在 `local://mass-ulw/<run-key>.json`，报告保存在 `local://mass-ulw/<run-key>/<id>.md`。两者在内核重置后都会保留，但已保存的 `running` 句柄无法重新接回 `wait`，必须先核对清楚才能继续分发工作。`done` 只表示子代理已返回。重试或修改部分节点时，其他节点的 `done` 报告保持不变。

## 持久循环契约

插件先保存带运行标记的意图，再创建一个原生目标并绑定精确 id。OMP 的目标控制器负责续跑、计量及预算；不安装 `session_stop` 驱动或自定义调度器。`ulw_loop` 工具拥有有类型的子目标和不可变标准／证据历史。它可被发现，help/status/criteria/template 使用读取审批，变更使用写入审批。请求拒绝额外字段和调用者提供的会话／存储身份。工具返回 `{ok:true,op,result,nextActions,warnings?}` 或 `{ok:false,op,error:{code,message}}`。

| 操作 | 参数与行为 |
| --- | --- |
| `help` / `status` | 帮助包含缓存的参考文本；状态含持久状态、新鲜／陈旧计数、精确驱动关系、证据根目录、当前尝试目录及下一步。 |
| `create_goals` | `{briefPath,objective,goals,validationBatches?}` 读取并复制权威简报；要求用户 `/ulw-loop` 授权，拒绝覆盖已有分解。 |
| `complete_goals` | `{retryFailed?}` 只取得／恢复一个可执行目标；失败只显式重试，阻塞／被替代目标不会重启。已完成循环只读返回 `aggregateComplete:true`；未完成循环没有可执行工作仍返回 false。 |
| `criteria` | `{goalId}` 返回定义、绑定版本及尝试的采集记录，以及当前新鲜度。 |
| `record_evidence` | `{goalId,criterionId,status:"pass"|"fail"|"blocked",evidence,artifacts,notes?}` 校验非空文件，复制并计算哈希；pass 至少需要一个证据文件。 |
| `checkpoint` | `{goalId,status:"complete"|"failed"|"blocked",evidence,qualityGatePath?}` 或 `{printTemplate:true,goalId?}`；失败／阻塞保留诊断，最终／批次验收要求权威关口文件。 |
| `steer` | `{kind,source:"finding",evidence,rationale,...fields}` 原子应用一个经校验的转向提案，类型见下文。 |
| `add_goal` | 完整的有类型目标种子；待执行工作重排时稳定 id 不变。 |
| `record_review_blockers` | `{goalId,title,objective,evidence,artifacts}` 原子阻塞目标并追加修复目标；修复完成后重开原目标，重新验收。 |
| `pause` / `resume` / `stop` | `{reason?}` 只管理自己的驱动。模型 resume 不能重建缺失／已完成原生目标，用户 `/ulw-loop resume` 可以；stop 不宣称成功或子代理已取消。 |

目标种子为 `{title,objective,shape:"delivery"|"research",tier:"LIGHT"|"HEAVY",criteria:[{scenario,expectedEvidence,essential?,userModel?:"happy"|"edge"|"regression"|"adversarial"}]}`，至少有一条具体标准。`essential` 默认 true，`userModel` 默认 happy。稳定 id 为 `G001…`，每个目标内为 `C001…`。验证批次为 `{id,goalIds,finalGoalId}`，成员唯一且有效，收尾目标必须是成员。

七种转向及字段：`add_subgoal` 接受目标种子；`split_subgoal` 接受待执行的 `targetGoalId,childGoals`；`reorder_pending` 接受完整 `pendingOrder` 排列；`revise_pending_wording` 接受待执行的 `targetGoalId` 以及 `revisedTitle,revisedObjective` 中至少一个；`revise_criterion` 接受 `goalId,criterionId` 以及 `scenario,expectedEvidence,userModel` 中至少一个；`annotate_ledger` 无额外字段；`mark_blocked_superseded` 接受 `targetGoalId,childGoals?,blockedReason?`。标准版本变化会使旧 pass 失效，但不改写历史；替代关系及验证批次链接均被保留。

权威 v1 状态为 `<getSessionDir()>/ulw-loop/<getSessionId()>/state.json`，包含意图／id、目标尝试、标准、复制文件哈希、关口、事件和完成通知状态，以一次原子 JSON 写入发布。变更通过进程内队列和短期独占磁盘锁串行化。初始化后的状态缺失、损坏、未知版本或归属不匹配会拒绝续跑，而不是重新初始化。已测试文件型 v1 恢复；未来格式变化必须在加载时升级已发布版本。`getSessionDir()===""` 在任何项目写入前拒绝持久循环。只有用户 `/ulw-loop reset` 可归档状态及证据，没有模型 force/reset 参数。

宿主会话另存 `wows-omp-omo-ultrawork.loop-driver` v1 `{version:1,runId,goalId,objective}`，仅用于最小所有权绑定，不是第二个标准状态来源。权威存储损坏或缺失时，只有原生驱动的 id 与精确运行标记目标都匹配此绑定，恢复流程才暂停它；无关目标或 `/audit` 保持不动。不会覆盖存储来伪造恢复成功。

每次采集绑定标准定义版本及已取得的目标尝试。在 Git 中，采集／完成要求受跟踪文件干净，并绑定完整 `HEAD^{tree}`，不使用提交 id 或短戳。rebase/amend 后树不变仍然新鲜；树、来源／报告字节、复制证据、标准或尝试改变都使有效 pass 陈旧。未跟踪证据也计算哈希。不自动 stash/reset。非 Git 调研绑定文件哈希；Git 交付要求已提交 HEAD。非最终检查点要求必要标准新鲜；最终检查点重查全部当前标准及已声明的中间批次关口。

最终／批次关口文件形状如下；路径必须是真实文件系统路径，相对路径相对于会话 cwd：

```json
{
  "version": 1,
  "treeHash": "<完整 HEAD 树 id；仅非 Git 调研可省略>",
  "criteriaCoverage": [{ "goalId": "G001", "criterionId": "C001", "captureId": "<当前采集 id>" }],
  "qa": {
    "reportPath": "qa.md",
    "entries": [{ "goalId": "G001", "criterionId": "C001", "kind": "real-surface", "artifactPath": "observed-output.txt", "observation": "<实际观察>" }]
  },
  "review": { "agentId": "<本会话独立 OMP 子代理>", "reportPath": "review.md", "verdict": "PASS", "blockers": [] }
}
```

调研目标的 QA 条目使用 `kind:"research-source"`。全部引用的报告与证据必须存在且非空，关口对每条标准引用精确的当前采集。插件证明绑定、哈希及存在性，不证明任意文字陈述为真：主代理仍需检查原生子代理／作业最终成功以及实际观察；不引入 Atlas 指派或 receipt 认证。最终验收先持久化，再只完成自己的原生目标并保存通知状态。`ulw-loop:completed` v1 `{version:1,sessionId,runId,revision}` 仅为输出，历史完成不重新发出。

外来活动／暂停目标阻止启动或恢复。原生暂停、预算上限、用户完成／丢弃、外来 id 以及 Plan Mode 会暂停未完成工作，不接管其他所有者。意图恢复只接受精确运行标记的目标，相似文字不构成所有权。`/audit` 与循环不能共用活动驱动。用户 `/goal` 操作仍可用，但循环标准未完成时会阻止模型 `goal complete`。已批准的 Atlas 计划保留自己的账本及隔离；普通 ultrawork 使用循环日志而非另一份笔记。插件保留现有 todo 结果改写钩子，只增加必要的原生完成 tool-call 防护，不新增被动结果钩子。

## 调研存储与保真契约

`#src/research-assets` 导出 `RESEARCH_UPSTREAM_PIN` 及 `materializeResearchAssets(sessionDir) -> Promise<{directory,pin,digest,durable}>`。模块导入时缓存脚本、参考资料、署名与私有流程的原始字节。快照键由完整上游版本号及已排序 `{path,bytes,sha256}` 条目的 SHA-256 摘要组成；版本为 1 的 `manifest.json` 列出这些条目。资源先写入同一父目录中的暂存目录，再原子重命名完整目录，并校验清单、精确文件集合及每个文件哈希。已有损坏或混合版本的快照会明确拒绝使用，不会静默替换。并发首次生成会收敛到同一个经校验的目录。

持久化会话使用 `<sessionDir>/ulw-research-assets/<pin>-<digest>/`；路径来自宿主，不重建用户主目录路径。会话目录为空时，使用 `<os tmpdir>/wows-omp-plugins-<uid-or-username>/ulw-research-assets/<pin>-<digest>/`，父目录为权限 0700 且经当前用户归属检查的私有目录。此时返回 `durable:false`，明确不是持久化会话存储。调研日志仍使用所配置临时根目录下的真实文件系统路径，因为 Node/Bun 无法解析 `local://`。

Outcome 清单使用 `OUTCOME_SCHEMA_VERSION = 2`；`SCHEMA_VERSION = 1` 仍用于 repair-state，保留其尝试、平台期与时间历史。加载 outcome v1 会保留时间戳、承诺及交付、渲染路径、非保真关口状态、残余缺陷、修复记录、来源统计和无害可选字段；保真状态设为 `not_run`，记录 `legacyFidelity:{upgradedFrom:1,status:"legacy_unverified"}`，并给历史已交付行添加 `fidelityStatus:"legacy_unverified"`。只读状态或简报不会改写旧字节，下一次成功变更才原子写入 v2。历史交付仍保持已交付，但旧版标记不豁免恢复或重新交付版本的保真关口。`outcome set` 创建新行时不继承历史保真标记。

事实账本、fidelity-state、论断索引、填充映射、语句配对和单次调研校准沿用各自上游 v1 格式；保真、语义及转换记录保留上游字段名和严格外层结构。`verifiedBy` 将交付绑定到精确的 `artifact_sha256`；`renderedFrom` 指明 PDF/DOCX 的已验证源文件。同一字节版本采用最新语义记录，时间相同则更严重的记录优先。缺失阅读结果、缺少必需强阅读覆盖、伪造片段、陈旧或不匹配的记录，以及未解决的注册表阻断或主要缺陷都会阻止交付。修复耗尽或显式争议都不能清除该关口。

脚本没有运行时 npm 依赖。其可执行行为测试与固定样例位于仓库 `src/omo-ultrawork-research/`，不会随插件发布；模块生命周期、格式升级与代表性中文事实及引文回归另有仓库测试。英语及韩语规范化规则来自上游，不代表支持所有语言的完整解析。


## 状态快照

主会话会用共享的快照外层结构发布 `omo-ultrawork.json`（见[仓库参考文档](../../REFERENCE.zh.md)）：

```json
{ "kind": "omo-ultrawork/mode", "version": 1, "mode": true, "armed": true }
```

`mode` 是持续模式开关；`armed` 表示指令已经在会话上下文中。两者都为 false 时 `state` 为 `null`。快照会跟随恢复和分支导航更新。`mass-ulw` 文件和调研临时文件与快照无关。

没有 UI 时，命令反馈以 `wows-omp-omo-ultrawork.command-status` 类型的自定义消息送达。
