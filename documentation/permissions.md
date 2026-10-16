# 权限与范围

运行时只有当前浏览器配置的本地用户，没有应用角色、远端授权服务器或数据库行权限。

| 权限／资源 | 用途 | 边界或拒绝行为 |
|---|---|---|
| storage | 设置、最近状态和同步时区 | 保存在当前扩展配置 |
| proxy | 读取浏览器代理设置 | 不写代理配置 |
| tabs | 读取 URL，选择应用标签页 | included／excluded 域名规则约束 |
| scripting | 持久化启动脚本、现有页面应用 | 只在允许范围传入有效时区；关闭时撤销 |
| alarms | 周期检测 | 关闭时不发起定位请求 |
| webNavigation | 导航时应用／恢复 CDP | 不允许的域名恢复并断开 |
| debugger | CDP 时区及关联子目标控制 | 用户选 CDP 引擎才接管；关闭或不匹配时恢复 |
| host_permissions: all_urls | 可配置 HTTPS 探测、本机接口、网页覆盖 | 安装授权较广，默认运行范围仍限目标域名 |
| nativeMessaging（可选） | 与单独安装的宿主机通信 | 未授权／未安装时不可用；宿主 allowed_origins 限定扩展 ID |
| GitHub contents: read | CI 和打包检出源码 | 工作流没有提交、推送或 Release 写权限 |
| CRX_PRIVATE_KEY | 维护者签名身份 | 仅打包步骤读取；不暴露给 PR 检查或扩展 |

网页消息不能给网页增加 Chrome 扩展权限。CDP 与补丁的范围在后台和内容脚本共同检查，但浏览器进程共享行为仍存在已说明的边界。功能范围限制不等于缩小 manifest 的安装授权。
