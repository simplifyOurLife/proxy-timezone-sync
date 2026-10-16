# 配置与秘密

扩展客户端没有内置 API 密钥、账号 token 或 CRX 签名私钥。

| 名称 | 使用方与来源 | 范围／维护 | 风险或语义 |
|---|---|---|---|
| enabled、engine | 后台／用户本地设置 | 浏览器配置；用户修改 | 控制关闭恢复及补丁／CDP |
| manualTimezone | 后台／用户设置 | 客户端；可清空 | 非空时优先，需合法 IANA 名称 |
| refreshMinutes | Chrome alarm／用户设置 | 默认 5，限制 1–120 | 控制检测频率 |
| includedDomains、excludedDomains | 后台和内容脚本／用户设置 | 默认 chatgpt、openai；例外优先 | 留空 included 表示更广网页范围 |
| exitProbeUrl | 地理探测／用户设置 | 默认目标 trace HTTPS 地址 | 接收方看到请求出口；不能保证所有分流路径相同 |
| allowGenericExit、countryFallback | 时区判断／用户设置 | 默认均关闭 | 开启会使用较弱的出口／主要城市线索 |
| localProbe、extraProbePorts | 本机诊断／用户设置 | 默认扫描候选 localhost 端口 | 诊断证据不能单独证明目标出口 |
| nativeProbe | 宿主机探测／用户设置及可选授权 | 默认关闭 | 额外读取进程、路径和系统代理 |
| cdpAllFrames | CDP／用户设置 | 默认开启 | 尝试关联子目标；支持范围取决于 Chrome |
| showDebug | 后台／用户设置 | 默认关闭 | 本地日志可能含出口及诊断信息 |
| CRX_PRIVATE_KEY | 打包脚本／GitHub repository secret | 仅 runner；固定身份，GitHub 外备份 | 泄露影响签名身份；更换可能需要扩展迁移 |
| CHROME_BIN／ChromePath | 打包脚本／runner 或本地参数 | 指定可信 Chrome 可执行文件 | 不从仓库下载任意二进制 |
| PLAYWRIGHT_MODULE、CHROMIUM_EXECUTABLE | 可选实机测试／维护者环境 | 本地工具路径，不进入扩展 | 不发布个人绝对路径 |
| TIMEZONE_TEST_PROXY、TIMEZONE_TEST_EXPECTED_TZ | 可选实网测试／维护者环境 | 显式设置才访问真实网络 | 代理地址中不要放凭据 |

发布前核对密钥未进源码／日志／产物、实际标签与两个版本文件一致、真实截图已脱敏；远端签名配置尚未创建。
