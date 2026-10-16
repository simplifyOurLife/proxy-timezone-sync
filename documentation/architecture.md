# 工程结构与交接索引

本项目为 Chrome Manifest V3 扩展，以目标域名探测请求的出口为依据，为选定网页设置 IANA 时区。技术栈为原生 JavaScript、HTML/CSS、Chrome API，可选 Python 原生宿主机。运行扩展无需编译或安装 npm 依赖。

| 层 | 入口 | 职责 |
|---|---|---|
| 界面 | src/popup、src/options | 展示状态及修改本地设置 |
| 调度 | src/background.js | 探测、选择时区、串行应用、状态存储 |
| 探测 | src/detect | 目标 trace、地理服务、代理诊断及可选宿主机 |
| 网页覆盖 | src/tz、src/content | document_start 种子／Date/Intl 补丁或 CDP 接管 |
| 发布 | tools/package-plan.mjs、tools/package.ps1 | 文件白名单、ZIP／可选签名 CRX |

没有账号、登录会话、数据库、邮件或 SEO 页面。网页环境、扩展后台、第三方地理服务和可选本机宿主机是不同边界。网页只接收时区适配，不接收签名密钥或宿主机进程清单。

已知边界：探测只代表当前请求的出口；地理数据库可能不同或不可用；补丁模式不覆盖 Worker；CDP 子目标支持随浏览器变化，同进程框架不能保证细粒度隔离。代码证据见 detect/geo.js、tz/cdp.js、tz/shim.js。

| 文档 | 内容 |
|---|---|
| [flows.md](flows.md) | 权限与数据边界的执行顺序 |
| [permissions.md](permissions.md) | Chrome 权限与资源范围 |
| [variables.md](variables.md) | 设置及签名密钥 |
| [tests.md](tests.md) | 现有检查、建议及缺口 |
| [cron.md](cron.md) | Chrome 周期检测与后台唤醒 |
| [automation.md](automation.md) | GitHub Actions 的触发与产物 |
| [隐私说明](../PRIVACY.md) | 数据接收方、本地保留及删除 |
| [发布准备](../docs/GitHub发布准备.md) | 仓库创建字段、待办与材料 |
