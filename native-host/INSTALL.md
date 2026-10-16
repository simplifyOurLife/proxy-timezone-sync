# 原生宿主机安装说明（可选）

装这个是为了让扩展能**直接看到进程名和系统代理设置**，而不只是靠端口猜。

- 不装：扩展仍可切换网页时区，软件识别使用端口指纹和可用的 Clash 控制台信息；
- 装了：扩展增加 `clash-verge.exe`、`v2rayN.exe`、`xray.exe` 等进程证据，仍不能仅凭共享内核或端口唯一确定所有代理软件。

宿主运行时只做只读探测：列进程、读监听端口、读系统代理设置，不联网。安装器会创建本机启动文件并写当前用户注册表；不修改系统时区。

---

## 一、前置条件

需要本机有 **Python 3**。

检查：

```powershell
python --version
```

没有的话去 <https://www.python.org/downloads/windows/> 装一个，安装时记得勾 **Add python.exe to PATH**。

---

## 二、拿到扩展 ID

1. 打开 `chrome://extensions/`
2. 找到「Proxy Timezone Sync · 代理时区自动切换」，打开「开发者模式」
3. 复制卡片上的 **ID**（32 个小写字母，形如 `pabcdefghijklmnopabcdefghijklmnop`）

或者直接打开本扩展的**设置页**，里面有一个「本扩展 ID + 复制」的框。

---

## 三、安装

在本目录下开 PowerShell（**不需要管理员**，只写当前用户的注册表）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId 你的扩展ID
```

想给多个浏览器都注册（Chrome + Edge + Brave + Chromium）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId 你的扩展ID -Browser all
```

脚本会自动做完这些事：

| 步骤 | 产物 |
| --- | --- |
| 找 Python | 记录 `python.exe` 绝对路径 |
| 生成启动器 | `native-host/run_host.bat`（Chrome 只能启动可执行文件，不能直接跑 `.py`） |
| 生成宿主清单 | `native-host/com.fj.tz.proxy_probe.json` |
| 写注册表 | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.fj.tz.proxy_probe` |
| 自检 | 真的给宿主发一条 probe 消息，打印命中的进程和端口 |

看到类似输出就成功了：

```
[1/4] Python: C:\Users\xxx\AppData\Local\Programs\Python\Python312\python.exe
[2/4] 启动器: ...\native-host\run_host.bat
[3/4] 清单: ...\native-host\com.fj.tz.proxy_probe.json
[4/4] 已注册 chrome -> HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.fj.tz.proxy_probe

自检中（真的跟宿主通讯一次）…
自检通过：命中 2 个代理相关进程
   - clash-verge.exe (PID 12345) 监听端口 [7897, 9097]
   - clash-verge-service.exe (PID 1200) 监听端口 []
   系统代理: 127.0.0.1:7897 (enabled=True)
```

---

## 四、在扩展里启用

1. **完全退出 Chrome 再打开**（原生宿主的注册表是启动时读取的）
2. 打开扩展设置页 → 「探测」区块
3. 点「授权 nativeMessaging 权限」（Chrome 会弹一次确认）
4. 勾上「启用原生宿主机探测」
5. 点「保存并重新检测」

弹窗里「代理软件识别」的置信度应该会变成**高置信**，证据里出现 `[process] 检测到进程 clash-verge.exe（PID xxx）`。

---

## 五、卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId 你的扩展ID -Uninstall
```

会删掉注册表项和生成的两个文件（`run_host.bat`、`*.json`）。宿主脚本本身不删，你自己删掉就行。

---

## 六、排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 扩展里提示 `原生宿主机已断开（未安装？）` | 注册表没写成功，或 Chrome 没重启 |
| `没有找到可用的 Python` | Python 没装或没进 PATH；也可以 `-Python C:\full\path\python.exe` 指定 |
| 授权按钮点了没反应 | 设置页刷新一下再点；或者 `chrome://extensions` 里看扩展有没有报错 |
| 自检没有输出进程 | 你的代理软件进程名不在关键字表里。直接编辑 `proxy_probe_host.py` 顶部的 `KEYWORDS` 加进去（小写关键字） |
| 想调试宿主 | 在 `proxy_probe_host.py` 里加日志写到文件里，别往 stdout 打（stdout 是协议通道） |

---

## 七、安全说明

- 宿主清单里的 `allowed_origins` 只允许**你填的那个扩展 ID** 调用，别的扩展调不动；
- 注册表只写 `HKCU`（当前用户），不需要管理员，也不影响其他用户；
- 宿主所有操作都是读取：`winreg` 读代理设置、`netstat`/`tasklist`/`ps` 读进程，没有写入或联网代码。
