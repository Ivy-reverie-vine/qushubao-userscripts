# AGENTS.md

取数宝后台的 Tampermonkey 用户脚本仓库。单文件发布，无构建、无 npm 依赖。

## 1. 项目边界与核心约束

- **目标站点**：`https://dep.ai-indeed.com`（取数宝 / mallQuan 后台）。
- **唯一产物**：`qushubao-userscripts.user.js`（单文件 IIFE，跑在页面上下文）。
- **特权限制**：严格保持 `@grant none`。禁止使用任何 `GM_*` API；所有网络请求、DOM 操作、剪贴板读写必须使用页面原生 API（`fetch` / `XMLHttpRequest` / `navigator.clipboard`）。
- **零依赖与纯内联**：禁止引入构建工具、打包器与 npm 依赖；样式必须动态注入 `<style>` 或行内样式，禁止外部外链。
- **数据精度陷阱**：取数宝 19 位雪花 ID 全程必须保持 `string`，**严禁**使用 `parseInt` 或 `Number()` 转换。

---

## 2. 文档索引与查阅规则（按需阅读）

**严禁凭记忆臆造字段名或接口路径**。需要查阅时按如下指针获取：

### 本地文档（本仓库 `docs/`）
- `docs/2026-11-10_数据中心表字段导出Excel方案.md`：数据中心展开行导出 Excel 规约、无依赖手写 OOXML+ZIP 实现方案、表字段映射结构。
- `docs/2026-11-10_数据中心启用表名复制按钮方案.md`：数据中心复制启用表名按钮的交互与 DOM 注入方案。

### 上游业务与接口文档（父仓库 `../docs/`，备用 `D:/Desktop/qsb-api-tool/docs/`）
- **总索引**：`../docs/文档导航.md`（所有业务规则、接口定义与领域词汇的权威导航）。
- **查接口契约（L1~L4 等）**：查阅 `../docs/上游接口/`（重点参考 `接口汇总与兼容核验.md`、`表字段映射接口.md`）。
- **查业务概念**：查阅 `../docs/领域词汇/`（如 `运行分析.md`、`连接器管理.md`）。
- **查批量执行/停止机制**：查阅 `../docs/任务批量停止/后端接口与执行.md`。

---

## 3. 架构规范

所有新增功能与页面扩展必须接入既有骨架，禁止破坏单例：

- **扩展注册点**：
  - `onResponse(match, { onRequest, onResponse })`：监听/拦截网络请求（fetch 与 XHR 统一拦截）。
  - `registerPage({ name, route, setup(state), teardown(state) })`：注册页面模块。
- **单例与幂等约束**：
  - 拦截器与事件委托全局只初始化一次。
  - 同一时刻只有一个页面处于激活态；离开页面时必须在 `teardown` 中清理 DOM 节点、MutationObserver、定时器及页面级缓存。
  - 同一路由内因 `pushState` 会多次触发 `enterPage()`，各页面 `setup(state)` **必须幂等**（通过 `state` 标志位守卫）。
- **新增页面规范**：仅需调用一次 `registerPage`（及可选的 `onResponse`），严禁修改拦截器内核机制。

---

## 4. 工作流与操作守卫（硬规则）

### 版本号与 Commit（用户要求 commit 时一次性完成）
1. **同步更新两处版本号**（必须完全一致）：
   - 脚本头部注释：`// @version      x.y.z`
   - 脚本常量：`const VERSION = 'vx.y.z'`
2. **Git Commit**：使用中文规范提交信息 `type(scope): 摘要`。
3. **禁止自动 Push**：除非用户明确下达推送指令（如“推送 / push”），否则 commit 即止。
4. **免升版例外**：仅修改 `AGENTS.md`、`docs/`、`tests/` 等非脚本文件时无需升版。

### 测试验证
- **测试命令**：`node --test tests/core.test.mjs`
  - *注意：Windows 下禁止直接传目录 `node --test tests/`。*
- **内核变更要求**：修改请求拦截、路由激活、状态分发等核心逻辑时，必须同步补齐测试用例，并执行变异验证（故意破坏逻辑确认测试变红）。

### 环境与网络规避
- Windows 环境下使用 `git` 访问 GitHub 必须带参数：`-c http.sslBackend=openssl`。
- 脚本更新源固定为：`https://ivy-reverie-vine.github.io/qushubao-userscripts/qushubao-userscripts.user.js`，禁止擅自修改。
