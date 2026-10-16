# 验证地图

## 现有覆盖

| 规则与负向场景 | 证据 | 状态 |
|---|---|---|
| Date 时间戳不漂移；显式 UTC、本地 setter 和夏令时符合语义 | tools/test-shim.cjs、test-regressions.cjs | 自动检查已有 |
| 无法确认目标出口时不静默采用公共出口；IP 不匹配拒绝 | tools/test-routing.mjs | 自动检查已有 |
| 地理全失败保留 trace 国家/IP；多时区国家不猜测 | tools/test-background.mjs、test-routing.mjs | 自动检查已有 |
| 旧检测不能重启关闭状态；启动和导航竞态 | tools/test-background.mjs | 自动检查已有 |
| 域名例外恢复、CDP 子目标顺序、种子首次同步可见 | test-routing.mjs、test-browser.cjs | 自动及实机检查已有 |
| 长诊断默认折叠、展开仍完整、按钮可见 | tools/test-browser.cjs | 既有 Chromium 检查 |
| 发布白名单含种子；日志、宿主机和私钥不进入扩展包 | tools/test-package.mjs | 5 项只读回归已有 |
| 标签、package 与 manifest 版本一致；拒绝包外引用 | tools/test-package.mjs | 自动检查已有 |

npm test 包含上述自动检查，已有扩展行为 308 项，加发布清单 5 项，总计 313 项。实机 34 项的具体运行范围见 docs/验证结果.md。

## 建议的后续验证

| 场景 | 类型 | 预期 |
|---|---|---|
| 首次 Actions 真实打包，下载并核对 SHA-256 | 自动集成＋人工核验 | 仅实际产物被上传，ZIP 根目录含 manifest |
| 固定 PEM 连续打包两个版本 | 受控签名＋人工 | CRX 身份一致，临时密钥清理，普通用户安装限制明确 |
| 新版 Chrome 的 Worker／iframe 变化 | 受控实机 | 支持时覆盖，不支持时报告并放行 |

## 当前缺口

本地 ZIP 已实际生成并核验 485 个文件、根目录 manifest、版本和 SHA-256，签名 CRX 尚未生成。远端打包及发布的实际结果以 GitHub Actions 和 Release 附件为准。所有网络路径、Shared Worker 和独立 Service Worker 也没有完整覆盖；main 分支保护尚未设置。
