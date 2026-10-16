/**
 * 可选：原生宿主机探测
 * ------------------------------------------------------------------
 * 扩展本身拿不到「本机开了哪些进程」，只能看到端口。
 * 装上 native-host/ 里的宿主程序后，就能直接读到进程名 + 系统代理设置，
 * 软件识别从「猜」变成「看着答案选」。
 * 没装也不影响使用，这里会安静地返回 available:false。
 */

export const NATIVE_HOST_NAME = 'com.fj.tz.proxy_probe';

export async function hasNativePermission() {
  try {
    return await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  } catch {
    return false;
  }
}

/**
 * 和原生宿主机通讯一次
 * @returns {Promise<{available:boolean, reason?:string, processes?:Array, systemProxy?:object}>}
 */
export async function probeNative(timeoutMs = 4000) {
  if (!(await hasNativePermission())) {
    return { available: false, reason: '未授予 nativeMessaging 权限' };
  }
  return new Promise((resolve) => {
    let port = null;
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        if (port) port.disconnect();
      } catch {
        /* 忽略 */
      }
      resolve(value);
    };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      finish({ available: false, reason: String((e && e.message) || e) });
      return;
    }

    timer = setTimeout(() => finish({ available: false, reason: '原生宿主机响应超时' }), timeoutMs);

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') {
        finish({ available: false, reason: '原生宿主机返回了非法数据' });
        return;
      }
      finish({
        available: true,
        processes: Array.isArray(msg.processes) ? msg.processes : [],
        systemProxy: msg.systemProxy || null,
        platform: msg.platform || '',
        raw: msg
      });
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish({ available: false, reason: (err && err.message) || '原生宿主机已断开（未安装？）' });
    });

    try {
      port.postMessage({ cmd: 'probe' });
    } catch (e) {
      finish({ available: false, reason: String((e && e.message) || e) });
    }
  });
}
