# 安装与更新

适用于 Chrome 125 及以上版本。扩展只改变选定网页看到的时区，电脑系统时区保持原样。

## 从 ZIP 安装

1. 下载本项目提供的 `proxy-timezone-sync-版本号.zip` 并完整解压到固定目录。
2. 打开 `chrome://extensions/`，开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择直接包含 `manifest.json` 的目录。
4. 固定工具栏图标，打开弹窗，点击“立即重新检测”。
5. 刷新目标网页。默认作用范围是 `chatgpt.com`、`openai.com` 及其子域。

不需要安装 Node.js、Python 或运行 build。只有使用可选原生宿主机时才需要 Python；宿主机源文件需从本项目源码中的 `native-host/` 单独取得。

GitHub 自动提供的 Source code ZIP 会多一层仓库目录，也可以使用，但要选其中包含 manifest 的目录。不要删除 `src/content/zone-seeds/`。

## 更新

用新版本替换原安装目录中的扩展文件，在扩展管理页点击“重新加载”，再刷新所有目标网页。使用同一个目录有助于保留已解压安装的扩展身份及设置。

当前发布候选为 1.1.3，弹窗页脚可核对版本。

## 检查是否生效

弹窗的“浏览器目标时区”应显示具体 IANA 名称，例如 `Asia/Singapore`。在作用范围内网页的控制台执行：

```js
Intl.DateTimeFormat().resolvedOptions().timeZone
```

新加坡和上海目前都为 UTC+8，钟面时间相同并不表示切换失败。若目标时区为空，展开“诊断详情”看接口失败原因，或在设置中手动指定时区。

## 关于 CRX

CRX 是签名安装包。普通 Windows／macOS Chrome 对商店外安装有限制，生成 CRX 不等于可以直接拖入安装。自用开发请选择上述已解压加载方式；正式面向普通用户分发请使用 Chrome 扩展商店。

参考：[Chrome 分发说明](https://developer.chrome.com/docs/extensions/how-to/distribute)。
