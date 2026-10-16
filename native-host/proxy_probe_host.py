#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chrome 原生消息宿主：代理进程 / 系统代理探测
==================================================================
给「代理时区自动切换」扩展用。扩展只能看到本地端口，看不到进程，
装上这个宿主之后就能直接报出：谁在跑、PID 多少、监听哪些端口、
系统代理指向谁。软件识别从「猜」变成「看着答案选」。

协议：Chrome 原生消息（stdin/stdout，小端 4 字节长度前缀 + UTF-8 JSON）。
只读操作，不修改任何系统设置，不联网。
"""

import json
import os
import re
import struct
import subprocess
import sys

HOST_VERSION = "1.0.0"

# 需要关注（会上报）的进程名关键字，全部小写
KEYWORDS = [
    "clash", "mihomo", "verge", "v2ray", "xray", "sing-box", "singbox",
    "shadowsocks", "ssr", "ss-local", "sslocal", "naive", "trojan", "hysteria",
    "tuic", "netch", "proxifier", "shock", "sura", "hiddify", "nekobox",
    "nekoray", "qv2ray", "winxray", "tor.exe", "privoxy", "fiddler", "charles",
    "burpsuite", "mitmproxy", "openvpn", "wireguard", "softether", "anyconnect",
    "gost", "brook", "juicity", "shadow-tls", "warp", "cloudflared", "zerotier",
    "tailscale", "v2raya", "flclash", "clashn", "shadowrocket", "karing",
    "outline", "psiphon", "lantern", "proxycap", "sockscap", "tun2socks",
    "chinadns", "pdnsd", "dns2socks", "simple-obfs", "obfs4"
]

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def run(cmd, timeout=8):
    """执行命令并返回 stdout 文本，失败返回空串"""
    try:
        p = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
            shell=False,
        )
        out = p.stdout
        for enc in ("utf-8", "gbk", "cp936", "latin-1"):
            try:
                return out.decode(enc, errors="strict")
            except Exception:
                continue
        return out.decode("utf-8", errors="replace")
    except Exception:
        return ""


# ----------------------------------------------------------------------
# 进程列表
# ----------------------------------------------------------------------
def list_processes():
    """返回 [(name, pid, path)]，尽量拿到可执行文件路径"""
    if os.name == "nt":
        # 1) psutil（如果用户装了，最省事）
        try:
            import psutil  # type: ignore

            out = []
            for p in psutil.process_iter(["pid", "name", "exe"]):
                try:
                    info = p.info
                    out.append((info.get("name") or "", int(info.get("pid") or 0), info.get("exe") or ""))
                except Exception:
                    continue
            if out:
                return out
        except Exception:
            pass

        # 2) PowerShell
        ps = (
            "$ErrorActionPreference='SilentlyContinue';"
            "Get-Process | ForEach-Object {"
            "  $p=$_.Path; if(-not $p){$p=''};"
            "  '{0}`t{1}`t{2}' -f $_.ProcessName,$_.Id,$p }"
        )
        text = run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps])
        parsed = []
        for line in text.splitlines():
            parts = line.strip().split("\t")
            if len(parts) >= 2 and parts[1].strip().isdigit():
                parsed.append((parts[0].strip(), int(parts[1]), parts[2].strip() if len(parts) > 2 else ""))
        if parsed:
            return parsed

        # 3) tasklist 兜底（没有路径）
        text = run(["tasklist", "/FO", "CSV", "/NH"])
        parsed = []
        for line in text.splitlines():
            cells = [c.strip('"') for c in line.strip().split('","')]
            if len(cells) >= 2:
                name = cells[0].strip('"')
                pidtxt = cells[1].strip('"')
                if pidtxt.isdigit():
                    parsed.append((name, int(pidtxt), ""))
        return parsed

    # macOS / Linux
    text = run(["ps", "-eo", "comm,pid,args"])
    parsed = []
    for line in text.splitlines()[1:]:
        m = re.match(r"\s*(\S+)\s+(\d+)\s*(.*)$", line)
        if not m:
            continue
        parsed.append((os.path.basename(m.group(1)), int(m.group(2)), m.group(3).strip()))
    return parsed


def interesting(name, path):
    hay = (name + " " + path).lower()
    return any(k in hay for k in KEYWORDS)


# ----------------------------------------------------------------------
# 监听端口
# ----------------------------------------------------------------------
def listening_ports(pids):
    """返回 {pid: [port, ...]}"""
    result = {}
    if not pids:
        return result
    want = set(int(p) for p in pids)

    if os.name == "nt":
        text = run(["netstat", "-ano", "-p", "tcp"])
        for line in text.splitlines():
            cells = line.split()
            if len(cells) < 5:
                continue
            if cells[0].upper() != "TCP":
                continue
            state = cells[3].upper()
            if state not in ("LISTENING", "LISTEN"):
                continue
            local = cells[1]
            pidtxt = cells[4]
            if not pidtxt.isdigit():
                continue
            pid = int(pidtxt)
            if pid not in want:
                continue
            port = 0
            if local.startswith("["):
                m = re.search(r"\]:(\d+)$", local)
                port = int(m.group(1)) if m else 0
            elif ":" in local:
                port = int(local.rsplit(":", 1)[1] or 0)
            if port:
                result.setdefault(pid, [])
                if port not in result[pid]:
                    result[pid].append(port)
        return result

    text = run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]) or run(["ss", "-ltnp"])
    for line in text.splitlines():
        m = re.search(r":(\d+)\s", line + " ")
        pm = re.search(r"(?:pid=|pid,)(\d+)", line)
        if not m or not pm:
            continue
        pid = int(pm.group(1))
        if pid not in want:
            continue
        port = int(m.group(1))
        result.setdefault(pid, [])
        if port not in result[pid]:
            result[pid].append(port)
    return result


# ----------------------------------------------------------------------
# 系统代理
# ----------------------------------------------------------------------
def system_proxy():
    info = {"enabled": False, "server": "", "pacUrl": "", "source": "", "raw": ""}

    if os.name == "nt":
        try:
            import winreg  # type: ignore

            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            )
            def get(name):
                try:
                    return winreg.QueryValueEx(key, name)[0]
                except Exception:
                    return None

            enabled = get("ProxyEnable")
            server = get("ProxyServer") or ""
            pac = get("AutoConfigURL") or ""
            override = get("ProxyOverride") or ""
            winreg.CloseKey(key)
            info.update(
                enabled=bool(enabled),
                server=str(server),
                pacUrl=str(pac),
                source="registry",
                raw="ProxyOverride=%s" % override,
            )
            return info
        except Exception as e:
            info["source"] = "registry-failed: %s" % e
            return info

    if sys.platform == "darwin":
        text = run(["scutil", "--proxy"])
        if text:
            info["raw"] = text
            info["enabled"] = "Enabled : 1" in text
            m = re.search(r"HTTPServer\s*:\s*(\S+).*?HTTPSPort\s*:\s*(\d+)", text, re.S)
            if not m:
                m = re.search(r"HTTPProxy\s*:\s*(\S+).*?HTTPPort\s*:\s*(\d+)", text, re.S)
            if m:
                info["server"] = "%s:%s" % (m.group(1), m.group(2))
            pm = re.search(r"ProxyAutoConfigURLString\s*:\s*(\S+)", text)
            if pm:
                info["pacUrl"] = pm.group(1)
            info["source"] = "scutil"
        return info

    env = {k: v for k, v in os.environ.items() if k.lower().endswith("_proxy") or k.lower() == "all_proxy"}
    if env:
        info["enabled"] = True
        info["server"] = env.get("https_proxy") or env.get("HTTPS_PROXY") or env.get("http_proxy") or env.get("HTTP_PROXY") or ""
        info["pacUrl"] = env.get("auto_proxy") or ""
        info["source"] = "env"
        info["raw"] = json.dumps(env)
    return info


# ----------------------------------------------------------------------
# 主逻辑
# ----------------------------------------------------------------------
def probe():
    procs = list_processes()
    hits = [(n, p, path) for (n, p, path) in procs if interesting(n, path)]
    ports = listening_ports([p for (_, p, _) in hits])

    processes = []
    for name, pid, path in hits:
        processes.append(
            {
                "name": name,
                "pid": pid,
                "path": path,
                "ports": sorted(ports.get(pid, [])),
            }
        )
    # 端口多的排前面，方便扩展打分
    processes.sort(key=lambda x: (-len(x["ports"]), x["name"]))

    return {
        "ok": True,
        "host": "proxy_probe_host",
        "version": HOST_VERSION,
        "platform": sys.platform,
        "processes": processes[:60],
        "processCount": len(procs),
        "systemProxy": system_proxy(),
        "notes": [
            "只上报关键字命中的进程；",
            "端口来自 netstat/lsof 的监听列表；",
            "本宿主不修改任何系统设置，也不联网。",
        ],
    }


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    if length <= 0 or length > 64 * 1024 * 1024:
        return None
    data = sys.stdin.buffer.read(length)
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        return None


def write_message(obj):
    payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def main():
    if os.name == "nt":
        try:
            import msvcrt

            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        except Exception:
            pass

    msg = read_message()
    cmd = (msg or {}).get("cmd", "probe")
    try:
        if cmd in ("probe", "ping"):
            write_message(probe())
        else:
            write_message({"ok": False, "error": "unknown cmd: %s" % cmd})
    except Exception as e:
        write_message({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    main()
