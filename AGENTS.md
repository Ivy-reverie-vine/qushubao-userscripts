# AGENTS.md

取数宝后台的 Tampermonkey 用户脚本仓库。单文件发布，无构建、无依赖。

## 项目边界

- 目标站：`https://dep.ai-indeed.com`（取数宝 / mallQuan 后台）
- 唯一产物：`qushubao-userscripts.user.js`（单文件 IIFE，`@grant none`，跑在页面上下文里）
- 已实现页面：
  - `/mallQuan/taskExecuteManagementV2` —— 店铺名称即时筛选 + 运行异常分类外显（悬浮浮层）
  - `/mallQuan/dataCenter` —— 展开行的表列表里加「导出Excel」列（按表导出字段映射 xlsx）+ 表头「复制」（把启用表的表中文/英文名按行复制进剪贴板）
- **不要**引入打包器、框架或 npm 依赖。发布形态永远是单文件 `.user.js`；文件长到需要拆分时再谈工具链，不要提前上。

## 上游接口文档去哪找

这些接口属于取数宝业务，本仓库不维护接口文档，真身在父仓库：

```
D:/Desktop/qsb-api-tool/docs/
```

| 用途 | 文件 |
| --- | --- |
| 接口总览 + L1→L4 链路、公共前缀、`Auth_token`、成功码 `10000` | `docs/上游接口/接口汇总与兼容核验.md` |
| 依赖接口清单与字段用途（日任务 / Job 详情 / Work 列表 / 流程块） | `docs/需求设计/运行分析/任务运行情况导出方案.md` |
| 真实报文的只读核验证据 | `docs/历史记录/运行方案/2026-10-07_接口只读核验.md` |
| 批量停止相关的执行接口 | `docs/任务批量停止/后端接口与执行.md` |

脚本当前用到的 6 个接口，同一前缀 `/frameWorkPortal/opt/qymall/1.0.0`：

| 层 | 接口 | 脚本里的用途 |
| --- | --- | --- |
| L1 | `/job/record/new` | 日记录分页；脚本拦截它拿 `jobUuid` 与查询日期 |
| L2 | `/job/record/detail/new` | 取 `exeOrderUuid` |
| L3 | `/job/record/work/list` | 取 `workUuid` 与流程块状态 |
| L4 | `/work/result/new` | 取流程块级报错明细 |
| — | `/conn/mapper/get` | 数据中心页：按 `connectorId` 取全部表的字段定义（`tableNameCn/tableNameEn/fields[]`） |
| — | `/connector/page` | 数据中心页：兜底用连接器全名精确匹配换 `connectorId` |

导出相关的接口事实见父仓库 `docs/上游接口/表字段映射接口.md`、`docs/上游接口/连接器关联表名接口获取方案.md`。
两条不能忘的语义：`validStatus=0` 只是没有标准映射，字段仍正常使用；`fieldLock=1` 只锁中英文名和类型。都不参与过滤。
19 位雪花 ID 全程当字符串传，**禁止** `parseInt` / `Number()`。

如果这份代码被克隆到别处，上面这些文档取不到：需要时回父仓库查，**不要凭记忆编字段名**。

## 架构（改代码前先对齐）

所有扩展都从这三个注册点进：

- `onResponse(match, { onRequest, onResponse })` —— 声明要监听的接口，XHR 与 fetch 共用一套匹配
- `registerPage({ name, route, setup(state), teardown(state) })` —— 按路径激活的页面模块，`matchPage()` 负责匹配
- `ensureInterceptor()` / `ensurePageHooks()` —— 整份文档只装一次的全局设施

三条约束：

1. **同一时刻只有一个页面激活**。因此引擎级状态（`errorCache`、预加载队列、tooltip 单例）可以共用，不要为多页面做多实例。
2. 页面级状态放各自的 `state`（`runId` / `barInjected` / `loopRunning` / `exportReady`），离开时由 `teardown` 清干净，包括筛选框句柄、MutationObserver 与请求缓存。
3. 拦截器与事件委托只能装一次。重复安装会让同一个请求被处理两次、浮层重复绑定。
4. `enterPage()` 在同一路由内会被重复调用（`pushState` 每次都会进来），所以各页面的 `setup()` **必须幂等**：用 `state` 上的标志位挡住重复绑定。

新增页面 = 加一次 `registerPage` + 一次（可选的）`onResponse`，不要动内核。

## 版本号与 commit 绑定（硬规则）

用户说「commit」时，按下面一次做完：

1. 改**两处**版本号，必须同一个值：
   - 头部 `// @version      x.y.z`
   - 脚本内 `const VERSION = 'vx.y.z'`
2. `git commit`。提交信息用中文，`type(scope): 摘要`，正文列要点。
3. **不要 push**。除非用户明确说「推送 / 推上去 / push」，否则提交即止。

只改 `AGENTS.md`、`tests/` 这类非发布文件时不必升版，但同样不自动推送。

理由：Tampermonkey 靠版本号判断更新。只改一处会导致"控制台显示的版本"和"实际发布版本"不一致，排查时误导人。

## 发布链

- 更新源：`https://ivy-reverie-vine.github.io/qushubao-userscripts/qushubao-userscripts.user.js`（GitHub Pages，`Content-Type: application/javascript`，支持一键安装）
- 旧文件名 `qsb-taskexecute-helper.user.js` 已废弃，仓库里不要再留同名副本（留着会让 Tampermonkey 认为是两个脚本）
- **不要**改回 `raw.githubusercontent.com` 或 `cdn.jsdelivr.net`：本机与常见国内网络下 TLS 被重置，更新会静默失败
- 推送后 Pages 约 1 分钟重建，边缘缓存 10 分钟；客户端每 24 小时检查一次更新，急用让用户在 Tampermonkey 里手动点

## 测试

```bash
node --test tests/core.test.mjs
```

- Windows 上**不要**用 `node --test tests/`：会把目录当模块解析而报 `MODULE_NOT_FOUND`
- 改内核（拦截分发、路由激活、状态归属）必须补用例，并做一次变异验证：故意改坏实现，确认用例会红。用例全绿但破坏实现也全绿，等于没有用例
- `tests/` 用 `node:vm` 沙箱 + 最小 DOM 桩，不引入 jsdom 等依赖

## 已知环境坑（会重复踩）

- git 走 schannel 访问 GitHub 必失败，需要 `-c http.sslBackend=openssl`
- 代理对 github.com 的 git 通道会间歇 `502` / `unexpected eof`。卡住时可用 `gh api` 的 Git Data API 兜底（blob → tree → commit → PATCH ref），事后本地要 `git fetch && git reset --hard origin/main` 对齐
- 本仓库局部配置了 `credential.helper=!gh auth git-credential`，没有改全局配置；不要动父仓库的凭据设置
