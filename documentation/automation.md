# GitHub Actions

项目没有嵌入 AI 代理、LLM 调用或由模型控制的工具。这里记录仓库自动化。

| 工作流 | 触发／责任人 | 允许的动作与结果 |
|---|---|---|
| 代码检查 | main 推送、PR、维护者手动 | 官方 checkout／setup-node；执行本地测试及只读发布清单 |
| 扩展打包 | v* 标签、维护者手动 | 测试、白名单复制、ZIP、可选 Chrome CRX 签名、上传固定路径产物；可创建 Release 并上传附件 |

CI 只有 contents: read，打包／发布工作流有 contents: write 以创建 Release。签名 secret 只在打包步骤作为环境变量提供，CI PR 不读取密钥，不使用 pull_request_target。手动打包的 include_crx 默认关闭，关闭时不传入签名 Secret；标签打包在已配置密钥时可生成 CRX。标签必须与 manifest 版本完全一致，缺少密钥时明确只生成 ZIP。

输出为 ZIP、可选 CRX、SHA256SUMS.txt、package-files.json；Artifacts 保留期配置为 30 天。手动发布模式可选 none、draft、publish，默认 draft；版本标签触发正式发布并上传附件。已有 Release 不覆盖。工作流不创建代码提交或发布到扩展商店。失败日志及产物在 GitHub Actions 查看；维护者可在仓库中禁用工作流。远端实际检查和打包状态以该仓库的 Actions 记录为准。
