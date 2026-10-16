# 参与开发

请使用中文描述问题、变更原因和验证结果。代码标识符沿用项目现有风格。

## 本地检查

开发检查使用 Node.js 22 及以上版本，无需安装 npm 依赖。

```powershell
$env:TZ = 'Asia/Shanghai'
npm test
pwsh -NoProfile -File .\tools\package.ps1 -CheckOnly
```

第二条命令只读检查发布清单，不打包。真实浏览器测试需要自行提供 playwright-core 和可加载扩展的 Chromium，参见 `tools/test-browser.cjs` 及 `docs/验证结果.md`。

## 变更要求

- 修复时区判定、Date/Intl 或 CDP 行为时，补充能体现实际错误的回归案例。
- Date 时间戳及 UTC 语义保持原样；明确指定的 Intl 时区继续尊重调用方。
- 域名例外、关闭恢复、旧检测结果不能重新启用覆盖等规则需要保持。
- 修改版本时同步 `manifest.json` 与 `package.json`，更新 CHANGELOG 和发布说明。
- 不提交私钥、凭据、真实 IP 诊断、个人路径、浏览器配置、原生宿主机生成的本机文件。

PR 描述说明问题、改动和验证；仓库 CI 准备检查自动测试及发布清单。主分支保护尚需维护者在 GitHub 设置。

贡献采用仓库中的 MIT 许可证；请确认贡献内容拥有相应使用和授权权利。
