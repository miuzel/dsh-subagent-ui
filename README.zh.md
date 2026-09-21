# DSH 子代理工作区管理器

面向 DeepSeek Harness Web 的子代理管理插件。插件在会话标题栏提供一个紧凑的 `🧩 子代理 active/total` 入口，用于搜索、筛选、分组、排序、查看和批量归档当前运行时已发现的子代理。

当前发布版本：**v1.5.0**

## 主要功能

### 会话与工作区范围

- 默认选择当前工作区。
- 默认选择当前主会话；即使当前页面已经进入某个子代理，会话管理器仍然以最上层主会话为基准。
- 工作区下拉框支持：
  - 当前工作区
  - 全部工作区
  - 具体工作区列表
- 会话下拉框支持：
  - 全部会话
  - 当前工作区内的会话
  - 当前会话标记
- 支持通过 `id:` 前缀单独搜索 Session ID，例如：

  ```text
  id: graph:g-a92e1406
  ```

  普通搜索不会把 Session ID 或父会话 ID 当作搜索字段。

### 搜索、排序与分组

- 普通搜索匹配子代理名称、标题和工作区名称。
- 支持按以下方式排序：
  - 最近活跃
  - 名字
  - 类型
- “最近活跃”优先使用 DSH 提供的 `updatedAt`。
- 最近进入运行状态的子代理会被记录，即使运行结束后仍会保持靠前显示。
- 支持以下分组：
  - 按会话
  - 按工作区
  - 按分类
  - 按类型
  - 不分组
- 按会话分组时，分组标题显示“工作区 · 会话名称”，卡片中不再重复显示相同的归属信息。
- 活跃子代理单独置顶，并可折叠。

## 界面截图

### 子代理管理抽屉

![子代理管理抽屉](docs/images/screenshot-1.png)

### 活跃子代理浮窗

![活跃子代理浮窗](docs/images/screenshot-2.png)

### 分类标签

内置分类包括：

- 全部
- 其他
- 审计
- 测试
- 实现
- 规划

分类标签会显示当前数量，超过 99 个显示为 `99+`。

用户可以创建自定义正则分类。自定义分类支持：

- 标签内显示数量。
- 未选中时不显示选中高亮。
- 删除前确认。
- 删除按钮与分类名称处于同一个标签框内。

一次性子代理名称后显示紧凑标签：

```text
⚡ 一次性
```

可继续子代理不显示额外类型标签。

### 过滤与隐藏

支持以下过滤与个性化选项：

- 隐藏一次性
- 隐藏长期未活跃
- 显示已隐藏
- 显示活跃浮窗
- **子代理背景色自定义**：可开启/关闭子代理会话的独立背景色，支持分别配置深色主题与浅色主题下的背景色，进入子代理时一目了然。
- 重置筛选

### 暂停与一键暂停

- **浮窗一键暂停**：活跃子代理浮窗头部提供“⏸ 一键暂停”按钮，点击并二次确认后批量暂停所有活跃的可继续子代理。
- **浮窗单项暂停**：浮窗内每个正在运行的可继续子代理卡片均有“⏸ 暂停”按钮，点击确认后暂停该子代理。
- **管理面板单项暂停**：列表和活跃分组中的每个运行中可继续子代理均有“⏸ 暂停”按钮。
- **管理面板一键暂停**：“活跃子代理”折叠分组头部右侧提供“⏸ 一键暂停”按钮，支持一键暂停全部活跃子代理。

隐藏是插件本地状态，只在列表不显示子代理，不会删除 DSH 会话或工作区文件。默认情况下：

- 列表不显示已隐藏子代理。
- 标题栏入口的总数和活跃数扣除已隐藏子代理。
- 勾选“隐藏一次性”后，入口按钮统计也会扣除一次性子代理。
- 卡片右侧提供 **👁 隐藏** / **🙈 取消隐藏** 按钮。

### 批量操作与永久删除

点击结果统计右侧的“批量操作”进入批量模式。批量模式下：

- 整张子代理卡片都变为选择区域。
- 点击卡片任意位置即可选中或取消选中。
- 复选框支持普通选择和 Shift 连续选择。
- 不会跳转到子代理会话。
- 隐藏单个操作按钮。
- 已隐藏项显示 `已隐藏` 标签。
- “完成”按钮使用高亮样式，点击后退出批量模式。

可用批量操作：

- 全选当前筛选结果。
- 清空选择。
- 选择 N 小时以前的子代理。
- 批量隐藏 / 批量取消隐藏 / 一键全部隐藏。
- **批量删除**：将选中的子代理永久从磁盘、投影缓存、工作区索引和内存会话中彻底销毁。
- **一键删除全部**：一键彻底清理当前视图中的所有子代理。

单项卡片在非批量模式下也提供 **🗑 删除** 按钮，点击确认后彻底销毁。所有删除操作完全由人类用户在 UI 侧主动操作，子代理不会也不需要耗费时间去感知或调用工具。

### 实时活动与流式输出

当 DSH 会话 API 提供绑定会话与实时事件时，卡片底部会显示实时活动：

- 最新两行模型文本或思考文本。
- 正在运行的工具调用，例如 `Read`、`Bash`（优先显示工具说明或目标文件名）。
- 最近完成的工具调用及成功/失败状态。
- 上下文注入，例如 `skill-catalog` 或插件系统提示。
- 命令状态。

实时输出具有金属光泽扫光动效；子代理结束后保留最后显示快照，并变为灰色。输出区域最多显示两行，避免持续滚动导致内容难以阅读。

**兼容两个 API 代际（自动探测）**：

- dsh **0.1.2-alpha.2**：使用 `binding.eventSource`（原始 `SessionEvent` 事件流）推导实时输出。
- dsh **0.1.1-rc.2** 及更早：回退 `session.getSnapshot().chat.legacy`（对话快照）路径。

按能力探测自动切换，向前兼容，老版本行为不变。

## 界面说明

从上到下依次为：

1. **标题栏入口**：显示活跃数 / 总数，点击打开管理面板。
2. **搜索框**：普通文本搜索；使用 `id: xxx` 查询 Session ID。
3. **范围和排序行**：工作区、会话、排序、分组四个紧凑控件。
4. **分类标签行**：分类名称和数量。
5. **筛选行**：一次性、长期未活跃、已归档和重置筛选。
6. **结果统计**：显示当前结果数量和批量操作入口。
7. **结果列表**：活跃分组、会话/工作区分组、子代理卡片和实时状态。

插件不在左侧全局菜单增加入口按钮；入口仅位于会话标题栏。

## 安装

在插件目录执行：

```bash
dsh plugin --profile web add file:.
```

升级或重新安装时可以先移除旧版本：

```bash
dsh plugin --profile web remove dsh-subagent-workspace-ui
dsh plugin --profile web add file:.
```

插件 bundle 会自动加载 [`cordis.patch.yml`](cordis.patch.yml)：安装期间插入管理器，并禁用 DSH 自带的 `ui-subagent` 子代理导航。卸载插件后，该 bundle 层会移除，底层的 `ui-subagent` 设置自动恢复。请重启现有的 `dsh web` 进程，然后刷新：

```text
http://127.0.0.1:3080
```

如果之前在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中手动禁用了 `ui-subagent`，测试自动恢复前请移除那条手动配置；插件不会覆盖用户自己的设置。

## 数据边界与兼容性

插件只管理当前 DSH Web 客户端运行时已经发现的子代理目录，不伪造不存在的历史数据。首次加载以 40 条为一页；普通分页可以继续加载，批量时间选择最多扩展到 1000 条。

公共 `SessionSummary` 不保证提供原始提示词或全部历史日志，因此插件不查询、不显示提示词。**类型与模型**改由宿主的公开投影提供，见下一节；实时输出按能力探测自动切换两种公开接口：

```text
# dsh 0.1.2-alpha.2（新 API）：绑定的事件源
sessions.binding(childId).eventSource
→ open()
→ getSnapshot().entries   # 原始 SessionEvent：assistant/chunk、tool/call、tool/result…

# dsh 0.1.1-rc.2 及更早（旧 API）：对话快照
sessions.binding(childId).session
→ session.open()
→ session.getSnapshot().chat.legacy
```

如果在当前宿主拿不到对应的实时数据，插件只能显示持久化的会话摘要和统计信息。

### 类型与模型（只读投影）

子代理的「类型」与「模型 provider/id」来自宿主的公开投影，不新增任何 RPC、也不写入任何状态：

```text
# 类型：当前浏览器运行时的子代理目录条目
ctx.sessions.list.getSnapshot().subagentsByParent[parentId].entries
→ entry.mode                       # one-shot | continuable

# 模型：会话投影 modelSelection（按 key 能力探测，读不到即视为宿主不提供）
ctx.sessions.list.getSnapshot().byId[childId].projectionValues.modelSelection
→ { lastUsed, next }               # next = 待生效选择 ?? lastUsed
→ 显示值 = next ?? lastUsed        # { provider, model, reasoningEffort? }
```

显示规则在三处完全一致，只有密度不同：

| 位置 | 显示形态 |
| --- | --- |
| 管理面板列表行的元信息行 | 不含模型（保持原样：时间、统计） |
| 卡片详情行（默认展开） | `类型：可继续 · 模型：newapi-test/DeepSeek-V4.1-Flash · high` |
| 活跃子代理浮窗 | 紧凑形态：`可继续 · newapi-test/DeepSeek-V4.1-Flash · high` |

- `reasoningEffort` **仅在宿主提供时**追加（` · high`），宿主不提供就不显示占位符。
- 三处共用同一个 `modelText()` 取值函数，来源、优先级（`next ?? lastUsed`）与兜底逻辑完全相同，浮窗只省略字段标签。
- 宿主未提供该投影（例如 **0.1.1-rc.2**）、投影值为空或 provider/model 为空串时，统一显示兜底文案 **模型未知**（英文界面 `model unknown`），不会出现空白或 `null/null`。该兜底使用独立 i18n 键 `modelUnknown`，不复用 `typeLoading`：老版本宿主上类型与模型各自独立降级（实测同行为 `类型：类型加载中… · 模型未知`）。
- **只读、无切换入口**：插件不调用 `selectedModel` 等任何模型写入 API，也不提供模型切换 UI；官方 SDK 对子代理地址的模型选择明确不可用（`model selection is unavailable for addressed subagent sessions`）。

### 打开子代理会话的三级能力探测

```text
# dsh 0.1.2-alpha.5 ~ 0.1.6-alpha.1：会话控制器入口
ctx.sessions.openSubagent(address)   # 精确子代理地址
ctx.sessions.open(sessionId)         # 保留的会话导航

# dsh 0.1.6-alpha.2 及以后：工作区导航服务
ctx.get('uiWorkspace').openSession({ parentSessionId, childSessionId, mode } | sessionId)

# 两者都不存在：提示当前 dsh 版本缺少可用的会话导航接口
```

`uiWorkspace` 通过 `ctx.get('uiWorkspace')` 读取，而不是必填注入，因此未注册该服务的宿主（**0.1.2-alpha.5** 之前的全部版本）仍能正常加载并继续走会话控制器路径；而移除了 `openSubagent`/`open` 的 **0.1.6-alpha.2** 则走工作区服务。**探测顺序按「参数形态」而不是版本号决定**：`sessions.openSubagent` 在所有带它的宿主上都吃 address 对象，而 `uiWorkspace.openSession` 直到 **0.1.6-alpha.2** 才接受 `SessionTarget`——在 **0.1.5-alpha.2 … 0.1.6-alpha.1** 上它是 `openSession(sessionId)`，内部走 `sessions.open(id)`，传入对象会抛错。因此先试会话控制器一级、把工作区服务作为兜底。控制器路径下优先使用 `{ parentSessionId, childSessionId, mode }` 精确地址，仅在缺少 mode/child 时才降级为普通会话导航，因为 `openSubagent` 会拒绝非健康目录子项的地址。0.1.2 系列能力探测路径（实时输出走 `binding.eventSource`、对话标签切换走 slot `actions`）仍为首选分支，**0.1.1-rc.2** legacy 回退路径保持不变。本版本支持 **dsh 0.1.6-alpha.2**，并向下兼容所有 DeepSeek Harness 版本。

归档、分类和最近使用顺序保存在浏览器本地 `localStorage` 中，不会写入 DSH 会话日志。

## 开发与验证

插件的客户端实现自 v1.4.0 起使用 TypeScript 编写，位于 [`src/client/`](src/client/)；发布产物 [`lib/client.js`](lib/client.js) 由构建脚本生成，**不要直接编辑**。宿主入口 [`lib/index.js`](lib/index.js) 仍为手写。

```bash
pnpm install      # 安装开发依赖（sucrase + typescript）
pnpm run build    # scripts/build.mjs 从 src/client 生成 lib/client.js
pnpm run check    # 构建 + tsc --noEmit + node --check lib/index.js + 产物新鲜度门禁
```

`pnpm run verify:build` 会对生成的 `lib/client.js` 与改造前的手写版本（git 引用 `v1.3.4`）做 token 级与行级比对；迁移完成后它同时充当差异查看器，可精确显示任何有意改动引入的 token/行差异。

### 冒烟测试（可指定 dsh 版本）

```bash
./test.sh                          # 本地 dsh 跑 web，端口 8084
./test.sh 8085                     # 指定端口
DSH_VERSION=0.1.6-alpha.2 ./test.sh  # 用 pnpx 拉取 0.1.6-alpha.2 跑 web（默认经 proxychains4 -q 走代理）
DSH_VERSION=0.1.1-rc.2 ./test.sh   # 旧版本兼容性冒烟（legacy 导航路径）
DSH_PLUGIN_DIR=.worktrees/x ./test.sh  # 冒烟其它 checkout 的产物
```

`DSH_HOME` 固定用隔离目录（`$HOME/tmp/dsh-test`，可用 `DSH_SMOKE_HOME=/path` 覆盖），并在启动前拒绝把真实 `~/.dsh` 当冒烟目录。`DSH_VERSION` 非空时用 `pnpx @deepseek-ai/dsh@<version>` 运行，可用于冒烟任意 dsh 版本（如 0.1.6-alpha.2、legacy 的 0.1.1-rc.2）。pnpm 12 默认忽略依赖的生命周期脚本，脚本会为 dsh 的原生依赖逐个传 `--allow-build=<pkg>`（清单可用 `DSH_ALLOW_BUILDS=…` 覆盖）。

## 致谢与参考

- UI 本地化（zh/en）由 [@Marcuss2](https://github.com/Marcuss2) 在 [PR #1](https://github.com/miuzel/dsh-subagent-ui/pull/1) 中贡献，特此致谢！
- 子代理永久删除、会话生命周期清理及快照刷新机制的设计参考并致谢开源项目：[@heiheiha798/dsh-plugin-subagent-delete](https://github.com/heiheiha798/dsh-plugin-subagent-delete)。

## v1.5.0 发布说明

- **修复：dsh 0.1.6-alpha.2 点击子代理行无法打开会话**：报错 `TypeError: ctx.sessions.openSubagent is not a function`，且该错误被行点击的 `try`/`catch` 吞掉，界面表现为「点了没反应」。0.1.6-alpha.2 删除了 `sessions.openSubagent(address)` 与 `sessions.open(id)`；插件改为运行时三级能力探测（`sessions.openSubagent` → `sessions.open` → `uiWorkspace.openSession`），不再硬切调用，同一份产物在上下游变更两侧都能工作；三级都不可用时在界面上提示当前版本不支持。
- **修复：三级探测的顺序按参数形态决定**：**0.1.5-alpha.2 … 0.1.6-alpha.1** 这一带同时存在两级 API，但其中的 `uiWorkspace.openSession(sessionId)` 只接受字符串，传入 address 会走 `sessions.open(id)` 并抛 `sessions.select: unknown session [object Object]`；而 `sessions.openSubagent(address)` 在这些宿主上仍然存在且吃对象。若优先试工作区服务，该异常会被吞掉并误报「当前版本不支持」，因此改为 address 先走会话控制器一级、`uiWorkspace` 作为 0.1.6-alpha.2+ 的兜底。已在危险带两侧实机验证：**0.1.5-alpha.1**（客户端包 0.1.5-rc.2）上顺序修正后的产物约 142 ms 完成会话切换、无告警、无导航报错；**0.1.6-alpha.2** 上服务端实际下发的产物仍命中 `uiWorkspace.openSession` 并正常打开子代理会话。
- **修复：dsh 0.1.6-alpha.2 的 `current` 字段缺失**：会话列表快照不再提供 `current`，而当前会话解析与「对话」标签页兜底依赖它。两处均已优雅退化——兜底逻辑识别 `current` 缺失后立即尝试点击宿主自身的「对话」标签，并在 2 秒内安静放弃，不再空转 8 秒。

## v1.4.0 发布说明

- **支持 DeepSeek Harness 0.1.5-rc.2，向下兼容所有 dsh 版本**：适配 0.1.5-rc.2 的对话页视图结构变化（slot 渲染器不再向未声明 store 的注册项注入 `actions`；视图选择改为按会话持久化，新增「轨迹」等标签页）——点击子代理重新正确落回「对话」标签页（`actions` 缺失时改为点击宿主自身的「对话」标签完成切换，激活与持久化语义完整）。0.1.2 系列能力探测路径保留为首选分支、调用方式不变，0.1.1 legacy 回退路径零改动，旧版本行为完全一致。
- **客户端迁移至 TypeScript**：`src/client/*.ts` 成为唯一源码，`lib/client.js` 由 `pnpm run build`（sucrase 逐字类型擦除 + 确定性链接）生成，不再手写。新增 `verify-build`（与 v1.3.4 手写 golden 做 token/行级比对——迁移等价证明兼有意改动差异查看器）与 `verify-fresh`（过期 bundle 门禁）；`pnpm run check` 一键完成构建 + 类型检查 + 语法检查 + 新鲜度校验。
- **修复：筛选摘要潜伏 ReferenceError**：折叠筛选区且选中具体工作区时，`scopeKey` 未定义变量导致报错，已修正为 `workspaceKey`（TS 迁移期间发现）。

## v1.3.4 发布说明

- **特性：UI 本地化（zh/en）**：通过 DSH client-locale 将插件全部 UI 文案本地化，支持中文/英文（英文为 AI 辅助翻译）。标签、按钮、统计、实时输出（上下文注入 / 思考中 / 工具说明）、确认弹窗等均改为走翻译键；跟随宿主语言切换。由 [@Marcuss2](https://github.com/Marcuss2) 在 [PR #1](https://github.com/miuzel/dsh-subagent-ui/pull/1) 中贡献，感谢！

## v1.3.3 发布说明

- **修复：批量删除大数量不再报错**：服务端请求体上限从 64 KiB 提升到 8 MiB，批量删除选中数百上千个子代理时不再触发「body too large」导致「删除请求失败」。
- **特性：隐藏详情时 tooltip 查看统计**：关闭「显示详情」后，行/名字的悬停 tooltip 显示 `输入/输出 · 缓存命中 · 轮数 · 步数` 统计。
- **修复：实时输出显示上下文注入与思考**：新 API 实时推导此前漏掉了 `user/message` 上下文注入；已补齐 `上下文注入 · <form>` 行，并修复思考被活动行掩盖的问题。
- **特性：思考中用动画图标标示**：运行中思考阶段显示旋转的「思考中…」，不再依赖低优先级的思考文本。

## v1.3.2 发布说明

- **性能优化（显著降低卡顿）**：
  - 子代理管理器改为单次基础扫描（`subagentRows`），`allRows`/`activeRows`/`tabCounts` 不再各自全表扫描并重复合并 `modeMap`；`tabCounts` 用延迟值计算、面板关闭时不计算。
  - `useSessions` 细粒度订阅（只订阅 `byId`/`subagentsByParent`/`current` 三字段并浅比较），无关的会话帧不再触发整组重渲染。
  - 活跃浮窗/面板**限制同时实时订阅的子代理数**（`liveCap`，默认 3，`0`=不设限）；关闭实时显示或关闭浮窗/面板时**完全停止 live 订阅并释放资源**，而非仅隐藏。
- **点击子代理自动切换到「对话」选项卡**：进入子代理时自动落到对话视图。
- **修复：批量「选择 N 小时前」**：按当前视图一次性选中真正超过 N 小时的子代理（数量准确），可正常增减，取消后不会自动勾回。

## v1.3.1 发布说明

- **兼容 dsh 0.1.2-alpha.2 与 0.1.1-rc.2**：实时输出按能力探测自动切换两条链路——新版本（0.1.2-alpha.2）走 `binding.eventSource` 原始事件流推导；旧版本（0.1.1-rc.2 及更早）回退 `chat.legacy` 对话快照。老版本行为不变，向前兼容。
- **实时工具调用显示说明/文件名**：进行中与已完成的工具调用现在优先显示工具 `description` 或目标 `path/file_path`（例如 `bash · Print current working directory`、`write · subagent-AJ.txt`），不再只有工具名。工具参数跨分片累积，参数完整后才渲染详情，避免流式过程中显示残缺 JSON。
- **清理**：移除已不存在的 `dsh-client-runtime` 客户端注入引用。
- **测试脚本支持指定版本**：`DSH_VERSION=0.1.1-rc.2 ./test.sh` 可冒烟测试旧版本兼容性。

## v1.2.4 发布说明

- **批量选择优化**：修复批量模式下直接点击 checkbox 偶现无响应的问题；支持 Shift 连选与连续批量取消选中（跟随上一次点击意图）。

## v1.2.3 发布说明

- **按需加载优化**：列表默认仅自动加载最近 10 个子代理的历史最新消息；更早的历史子代理默认不建立会话绑定，改为显示「📥 加载最新消息」按钮，大幅降低大列表初始加载时的资源开销。
- **运行中不受限制**：正在运行中的子代理始终保持自动连接与实时输出流更新。
- **单项按需加载**：点击任意历史子代理的「📥 加载最新消息」按钮后即时打开会话并保持显示，不触发整行跳转。

## v1.2.2 发布说明

- **自适应相对时间**：子代理卡片的时间显示优化为自适应相对时间（`x 秒前`、`x 分钟前`、`x 小时 x 分钟前`、`x 天前`），提升可读性。
- **提示信息重命名**：悬停时间的 Tooltip 标签统一优化为「最近活动：」。

## v1.2.1 发布说明

- 修复活跃浮窗中点击子代理的实时输出区域时，第一下无法打开子代理、需要点击第二下的问题（流式输出高频重渲染导致点击事件丢失）。

## v1.2.0 发布说明

### 永久删除

- 增加子代理永久删除功能（支持“带备份删除”与“不备份直接删除”）。
- 批量模式增加“批量删除（带备份/不备份）”以及“一键删除全部”操作。
- 备份目录保存于 `$DSH_HOME/subagent-backups/`。
- 彻底清理会话磁盘目录、投影缓存、工作区索引与内存注册表，并支持实时同步刷新。

### 隐藏与视觉

- 归档重构为「隐藏」：以 🙈/👁 眼睛图标一键隐藏或取消隐藏子代理，隐藏仅在列表不显示、不删除会话。
- 已隐藏子代理整行暗化，深浅主题自适应，与正常子代理形成强烈视觉对比。

### 浏览密度与筛选

- 新增「显示详情」开关（默认开启）：取消勾选后卡片收拢为单行，token 统计、提示词预览与实时流式输出不再展开，提升单屏浏览密度。
- 搜索框新增 × 清空按钮，关闭抽屉后保留搜索关键词。
- 搜索框右侧 ⚙ 按钮可折叠/展开筛选区（分类标签、范围/会话/分组/排序下拉、选项行），折叠状态自动持久化。
- 筛选区折叠后在统计行上方显示当前筛选摘要（分类/工作区/会话/排序/分组）。

### 布局与交互

- 「显示活跃浮窗」开关固定到标题栏统计行（当前会话/工作区/活跃数）右侧。
- 「显示已隐藏」开关固定到列表统计行（显示 M/N 个）右侧。
- 详情区域宽度对齐整张卡片，左右不再截断。
- 子代理行内状态点与隐藏标记垂直居中。
- 筛选折叠按钮（⚙）点击热区加大，更易点中。

## v1.1.4 发布说明

- 适配深浅两种主题色。
- 子代理会话专属背景色支持自定义与深浅色独立配置。
- 实时浮窗与管理清单支持单个子代理「⏸ 暂停」与「⏸ 一键暂停」全部活跃子代理（带二次确认）。

## v1.1.2 发布说明

- 修复当无活跃子代理时，短路求值导致标题栏按钮左侧意外渲染出数字 `0` 的问题。

## v1.1.1 发布说明

- 测试脚本不再强制要求预先设置 API Key。
- 测试脚本根据自身位置定位项目目录，可从任意工作目录运行。

## v1.1.0 发布说明

- 增加右上角活跃子代理浮窗，显示运行时长、实时输出和统计信息。
- 支持在浮窗和管理抽屉中直接打断可取消的运行中子代理。
- 增加浮窗实时输出开关，关闭后可在有限空间显示更多子代理。
- 实时输出按 100ms 节流，并区分最新活动与已完成活动。
- 优先显示工具 description，长文件路径自动缩略。
- 增加 dsh-graph 工作流产生的大量子代理会话管理说明。

## v1.0.1 发布说明

- 增加中文文档。
- 完善当前主会话、工作区和会话选择逻辑。
- 增加规划分类和分类数量徽章。
- 增加批量选择、Shift 连选、时间范围选择和批量归档。
- 改进批量模式下的卡片交互和完成按钮视觉反馈。
- 增加活跃子代理置顶、实时工具调用、上下文注入和结束快照。
- 移除 provider/model 查询和显示。
- 移除左侧全局菜单中的子代理入口。
