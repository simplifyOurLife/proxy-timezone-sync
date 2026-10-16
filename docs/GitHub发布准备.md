# GitHub 仓库与发布准备

本文件记录仓库创建信息、发布材料和后续打包步骤。用户已授权首次提交和推送 main；版本标签、签名打包及公开 Release 作为后续发布步骤单独执行。

仓库：[simplifyOurLife/proxy-timezone-sync](https://github.com/simplifyOurLife/proxy-timezone-sync)。只读 git ls-remote 核对时没有远端分支。

## 创建仓库时填写

| 字段 | 内容 |
|---|---|
| Owner | `simplifyOurLife` |
| Repository name | `proxy-timezone-sync` |
| Description | Chrome 扩展：根据目标网站出口 IP 自动同步网页时区，支持域名范围、手动时区和诊断。 |
| Visibility | Public（用户已确认） |
| 默认分支 | `main` |
| Topics | `chrome-extension`、`timezone`、`proxy`、`manifest-v3` |
| Add a README | 不勾选；本地已有 README.md |
| Add .gitignore | 不勾选；本地已有 .gitignore |
| Choose a license | 创建页面先不选；本地已有用户确认的 MIT LICENSE |
| Website | 暂留空，已有正式网站或商店地址后再填 |

package.json 已填写真实 repository、homepage 和 bugs 地址，README 已添加仓库、发布和问题反馈链接。日常推送 main 只触发检查，不触发标签打包。

## 材料清单

| 文件 | 用途 |
|---|---|
| README.md | 项目介绍、示例截图、安装、生效范围和限制 |
| INSTALL.md | 可随 ZIP 分发的独立安装指南 |
| LICENSE | MIT 标准条款，权利人 qiyifeng |
| PRIVACY.md | 实际网络请求、本机数据、本地保存与删除说明 |
| CHANGELOG.md | 当前版本变更记录 |
| CONTRIBUTING.md、SECURITY.md | 开发检查与安全反馈说明 |
| docs/releases/v1.1.3.md | 首个 GitHub Release 的待发布文案 |
| docs/images/popup.png | 使用测试 IP 的示例弹窗，无真实出口数据 |
| documentation/architecture.md | 工程、权限、配置和测试索引 |
| .github/ISSUE_TEMPLATE/bug.yml | 脱敏问题反馈表单 |
| .github/pull_request_template.md | PR 描述模板 |
| .github/workflows/ci.yml | 推送 main、PR 或手动触发的自动检查 |
| .github/workflows/package.yml | 版本标签或手动触发的打包配置 |
| tools/package-plan.mjs | 只读发布清单与边界校验 |
| tools/package.ps1 | ZIP／可选 CRX、校验和生成脚本 |

## Actions 打包行为

首次提交普通 main 分支只会运行代码检查；打包需要手动运行“扩展打包”，或推送与 manifest 版本完全一致的标签（本次为 `v1.1.3`）。手动触发入口需要工作流先出现在默认分支。

工作流先执行 `npm test`，然后使用白名单复制扩展文件。ZIP 根目录直接包含 manifest.json，运行文件为 src、icons，附带 INSTALL、PRIVACY、LICENSE。原生宿主机留在仓库源码中，不进入扩展安装包。

- 未配置签名密钥：生成 ZIP、SHA256SUMS.txt 和 package-files.json，日志说明没有生成 CRX。
- 已配置签名密钥：额外调用 Chrome 生成 CRX3，检查文件头，并加入校验和。
- 产物保存在 Actions 的 Artifacts 中，保留期配置为 30 天。
- 手动运行可选 none（仅产物）、draft（草稿，默认）、publish（正式发布）；推送版本标签时正式发布。
- 手动运行的 include_crx 默认关闭，关闭时即使仓库有签名 Secret 也只生成 ZIP；开启需预先配置固定密钥。标签事件保留已配置密钥时生成 CRX 的行为。
- 发布步骤使用对应版本文案，上传实际生成的 ZIP、可选 CRX、校验和和清单；已存在的版本拒绝覆盖。
- Releases 用于扩展下载附件；GitHub Packages 是 npm、容器等包注册表，本项目不向该栏目发布扩展安装包。

首次提交说明：`初始化代理出口时区同步扩展及 GitHub 发布配置`。

## CRX 密钥配置（后续由用户操作）

1. 在自己的可信环境首次使用 Chrome“打包扩展程序”生成 PEM，或沿用此前保存的同一份 RSA PEM 私钥；当前材料准备没有生成密钥。
2. 将完整 PEM 内容放入仓库 Settings → Secrets and variables → Actions → New repository secret。
3. Secret 名称为 `CRX_PRIVATE_KEY`。值是完整私钥文本，不是路径，不是公钥，也不是 Base64 编码后的 ZIP。
4. 在 GitHub 外安全保留原始密钥。后续版本沿用同一密钥，以维持签名身份；不要每次重新生成。

私钥通过单个打包步骤的环境变量传入，仅临时写入 runner 的临时目录；不复制到源码或扩展目录，不打印到日志，不上传到 Artifacts。临时文件在 finally 中清理。GitHub 自动提供工作流 token，本配置不需要另建 PAT。

## 本地校验与待办

```powershell
$env:TZ = 'Asia/Shanghai'
npm test
pwsh -NoProfile -File .\tools\package.ps1 -CheckOnly
```

CheckOnly 不创建 dist，不读取密钥，不运行 Chrome。实际打包将使用 `pwsh -NoProfile -File .\tools\package.ps1`，本次不执行；dist 已存在时脚本拒绝覆盖，需先自行保存或清理旧文件。

- [x] 确认公开仓库与 MIT 许可。
- [x] 确认仓库级 Git 身份为 qiyifeng，邮箱使用个人邮箱。
- [x] 准备文档、示例截图、工作流及发布清单。
- [x] 本地 313 项自动检查、485 文件清单、YAML／PowerShell 语法、文档链接及常见敏感模式检查通过；只读复核未发现实质缺陷。
- [x] 用户创建空仓库并提供 URL，本地已关联 origin。
- [x] 用户已授权首次提交及推送，仓库级身份为个人身份；提交结果以 Git 历史和远端 main 为准。
- [ ] CRX 暂缓；用户已选择本次只发布 ZIP，不生成或配置签名密钥。
- [ ] 首次运行远端 Actions，核验实际 ZIP／CRX 文件及解压加载行为。
- [ ] 用户通知发布后再创建 Release；需要正式分发时另行准备 Chrome 商店材料。

主分支保护、Secret scanning 和私密漏洞报告可在仓库创建后启用；本次没有更改远端设置。

## 已核对的官方资料

- [GitHub 工作流触发](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [GitHub Artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
- [Chrome 打包命令](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux#package-through-command-line)
- [Chrome 分发限制](https://developer.chrome.com/docs/extensions/how-to/distribute)
- [MIT 标准条款](https://opensource.org/license/mit)
