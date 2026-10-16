/**
 * 全局常量 / 指纹库 / 地理接口定义
 * ---------------------------------------------------------------
 * 这里的端口指纹全部是「候选证据」，不是唯一判据。
 * 最终软件识别结果由四路证据加权：本地端口、PAC/固定代理配置、
 * 控制台 API（Clash 系）、原生宿主机返回的进程名。
 */

/** Chrome 禁止 HTTP 访问的端口（探测这些端口会直接 ERR_UNSAFE_PORT） */
export const CHROME_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87,
  95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139,
  143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659,
  4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080
]);

/**
 * 代理软件指纹库
 * @typedef {Object} ProxySoftware
 * @property {string}   id            内部 ID
 * @property {string}   name          展示名
 * @property {string}   family        同族家族（clash / v2ray / ss / other）
 * @property {number[]} ports         常见本地入站端口（HTTP/SOCKS/mixed）
 * @property {number[]} apiPorts      控制台 REST API 端口（Clash 系 / sing-box clash-api）
 * @property {string[]} pacHints      PAC 地址或配置里可能出现的关键字
 * @property {string[]} processNames  进程名关键字（小写匹配，走原生宿主机时可用）
 * @property {string}   note          备注
 */
export const PROXY_SOFTWARE = [
  {
    id: 'clash-verge',
    name: 'Clash Verge / Clash Verge Rev',
    family: 'clash',
    ports: [7897, 7898, 7899, 7890, 7891, 9097],
    apiPorts: [9097, 9090],
    pacHints: ['clash-verge', 'verge', 'mihomo'],
    processNames: ['clash-verge.exe', 'clash-verge-service.exe', 'verge-mihomo.exe', 'clash-verge'],
    note: '默认 mixed 端口 7897，内核为 Mihomo'
  },
  {
    id: 'clash',
    name: 'Clash / Clash for Windows / ClashX',
    family: 'clash',
    ports: [7890, 7891, 7892, 7893, 7894],
    apiPorts: [9090, 9091],
    pacHints: ['clash'],
    processNames: ['clash.exe', 'clash-win64.exe', 'clash for windows.exe', 'clashx', 'clash-nt.exe'],
    note: '经典组合 HTTP 7890 / SOCKS 7891 / 控制台 9090'
  },
  {
    id: 'mihomo',
    name: 'Mihomo (Clash.Meta 内核)',
    family: 'clash',
    ports: [7890, 7897, 7899],
    apiPorts: [9090, 9097],
    pacHints: ['mihomo', 'meta'],
    processNames: ['mihomo.exe', 'mihomo', 'clash-meta.exe', 'meta.exe'],
    note: '控制台 /version 会返回 {"meta":true}'
  },
  {
    id: 'v2rayn',
    name: 'V2rayN（含 Xray 内核）',
    family: 'v2ray',
    ports: [10809, 10808, 10810, 10811, 1080, 1081],
    apiPorts: [],
    pacHints: ['v2ray'],
    processNames: ['v2rayn.exe', 'v2ray.exe', 'xray.exe', 'v2ray-core.exe', 'wintun'],
    note: 'HTTP 10809 / SOCKS 10808（新版 V2rayN）'
  },
  {
    id: 'v2ray-core',
    name: 'V2Ray Core',
    family: 'v2ray',
    ports: [1080, 1081, 1082, 1086, 1087],
    apiPorts: [],
    pacHints: ['v2ray'],
    processNames: ['v2ray.exe', 'v2ray-core.exe'],
    note: '默认 SOCKS 1080 / HTTP 1081'
  },
  {
    id: 'xray',
    name: 'Xray-core',
    family: 'v2ray',
    ports: [1080, 1081, 10808, 10809],
    apiPorts: [],
    pacHints: ['xray'],
    processNames: ['xray.exe', 'xray'],
    note: '常被 V2rayN / Nekoray 等前端调用'
  },
  {
    id: 'sing-box',
    name: 'sing-box（含 NekoRay/NekoBox 内核）',
    family: 'singbox',
    ports: [2080, 2081, 2082, 1080, 1081],
    apiPorts: [9090, 9091, 9092],
    pacHints: ['sing-box', 'singbox'],
    processNames: ['sing-box.exe', 'sing-box', 'nekobox.exe', 'nekoray.exe'],
    note: '默认 HTTP 2080 / SOCKS 2081，可开 Clash API'
  },
  {
    id: 'shadowsocks',
    name: 'Shadowsocks / Shadowsocks-windows',
    family: 'ss',
    ports: [1080, 1081, 8123, 8388],
    apiPorts: [],
    pacHints: ['shadowsocks', 'sslocal'],
    processNames: ['shadowsocks.exe', 'sslocal.exe', 'shadowsocks-libev.exe', 'shadowsocks-qt5.exe'],
    note: '本地代理端口默认 1080'
  },
  {
    id: 'ssr',
    name: 'ShadowsocksR / SSR',
    family: 'ss',
    ports: [1080, 1081],
    apiPorts: [],
    pacHints: ['shadowsocksr', 'ssr'],
    processNames: ['shadowsocksr.exe', 'ssr.exe', 'shadowsocksr-dotnet4.0.exe'],
    note: '老牌 SSR 客户端'
  },
  {
    id: 'surge',
    name: 'Surge（macOS / iOS）',
    family: 'surge',
    ports: [6152, 6153, 6154],
    apiPorts: [6170],
    pacHints: ['surge'],
    processNames: ['surge'],
    note: 'HTTP 6152 / SOCKS 6153 / API 6170'
  },
  {
    id: 'quantumult',
    name: 'Quantumult X / Shadowrocket（苹果端）',
    family: 'apple',
    ports: [8888, 1082, 1087],
    apiPorts: [],
    pacHints: ['quantumult', 'shadowrocket'],
    processNames: ['quantumult'],
    note: '苹果端代理工具，Windows 上通常不会命中'
  },
  {
    id: 'netch',
    name: 'Netch',
    family: 'tun',
    ports: [2801, 2802, 2803],
    apiPorts: [],
    pacHints: ['netch'],
    processNames: ['netch.exe', 'netch'],
    note: 'SOCKS 2801 / HTTP 2802，多为进程级代理'
  },
  {
    id: 'hiddify',
    name: 'Hiddify / Hiddify-Next',
    family: 'singbox',
    ports: [2334, 2335, 12334, 12335],
    apiPorts: [9090, 9091],
    pacHints: ['hiddify'],
    processNames: ['hiddify.exe', 'hiddify-cli.exe', 'hiddify-core.exe'],
    note: '内部使用 sing-box 内核'
  },
  {
    id: 'proxifier',
    name: 'Proxifier / 透明代理（TUN 模式）',
    family: 'tun',
    ports: [],
    apiPorts: [],
    pacHints: ['proxifier'],
    processNames: ['proxifier.exe', 'proxifierpp.exe', 'wintun', 'tun2socks.exe', 'tap-windows'],
    note: '不监听本地端口，走网卡层转发；只能靠进程名或出口 IP 判定'
  },
  {
    id: 'tor',
    name: 'Tor / Privoxy',
    family: 'tor',
    ports: [9050, 9051, 8118],
    apiPorts: [],
    pacHints: ['tor'],
    processNames: ['tor.exe', 'privoxy.exe'],
    note: 'SOCKS 9050 / 控制口 9051 / Privoxy 8118'
  },
  {
    id: 'mitm',
    name: '抓包代理（Fiddler / Charles / Burp Suite）',
    family: 'mitm',
    ports: [8888, 8889, 8080, 8081, 9090],
    apiPorts: [],
    pacHints: ['fiddler', 'charles', 'burp'],
    processNames: ['fiddler.exe', 'charles.exe', 'charlesproxy', 'burpsuite', 'java.exe'],
    note: '这类不是翻墙代理，出口 IP 通常仍是本机所在地'
  }
];

/** 默认扫描端口 = 全部软件端口并集（已去掉 Chrome 禁用的端口） */
export const DEFAULT_PROBE_PORTS = Array.from(
  new Set(PROXY_SOFTWARE.flatMap((s) => [...s.ports, ...s.apiPorts]))
)
  .filter((p) => !CHROME_BLOCKED_PORTS.has(p))
  .sort((a, b) => a - b);

/** 探测单个端口时的超时（毫秒）。区分「拒绝连接」和「连上了但不回 HTTP」 */
export const PORT_PROBE_TIMEOUT_MS = 700;
/** 探测控制台 API 的超时 */
export const API_PROBE_TIMEOUT_MS = 1200;
/** 地理接口超时 */
export const GEO_TIMEOUT_MS = 7000;

/**
 * 出口 IP 地理定位接口。
 * urlForIP 用于查询已经确认的目标站点出口，不依赖地理接口自己的分流。
 * url 只在明确允许通用出口查询时使用，不能证明目标网站走同一出口。
 */
export const GEO_ENDPOINTS = [
  {
    id: 'ipwho.is',
    label: 'ipwho.is',
    url: 'https://ipwho.is/',
    urlForIP: ip => `https://ipwho.is/${encodeURIComponent(ip)}`,
    parse(json) {
      if (!json || json.success === false || !json.ip) return null;
      const tz = typeof json.timezone === 'string' ? json.timezone : json.timezone && json.timezone.id;
      return {
        ip: json.ip,
        country: json.country,
        countryCode: json.country_code,
        region: json.region,
        city: json.city,
        timezone: tz || ''
      };
    }
  },
  {
    id: 'ipapi.co',
    label: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    urlForIP: ip => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    parse(json) {
      if (!json || json.error || !json.ip) return null;
      return {
        ip: json.ip,
        country: json.country_name,
        countryCode: json.country_code,
        region: json.region,
        city: json.city,
        timezone: json.timezone || ''
      };
    }
  },
  {
    id: 'ipinfo.io',
    label: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    urlForIP: ip => `https://ipinfo.io/${encodeURIComponent(ip)}/json`,
    parse(json) {
      if (!json || !json.ip) return null;
      return {
        ip: json.ip,
        country: json.country,
        countryCode: json.country,
        region: json.region,
        city: json.city,
        timezone: json.timezone || ''
      };
    }
  },
  {
    id: 'worldtimeapi',
    label: 'worldtimeapi.org',
    url: 'https://worldtimeapi.org/api/ip',
    parse(json) {
      if (!json || !json.timezone) return null;
      return {
        ip: json.client_ip,
        country: '',
        countryCode: '',
        region: '',
        city: '',
        timezone: json.timezone
      };
    }
  },
  {
    id: 'country.is',
    label: 'api.country.is',
    url: 'https://api.country.is/',
    urlForIP: ip => `https://api.country.is/${encodeURIComponent(ip)}`,
    parse(json) {
      if (!json || !json.ip) return null;
      return {
        ip: json.ip,
        country: '',
        countryCode: json.country,
        region: '',
        city: '',
        timezone: ''
      };
    }
  }
];

/** 状态里记录的结果来源 */
export const SOURCE = {
  MANUAL: 'manual',
  GEO_TIMEZONE: 'geo-timezone',
  GEO_SINGLE_TIMEZONE: 'geo-single-timezone',
  GEO_COUNTRY: 'geo-country',
  LOCAL_PROXY_HINT: 'proxy-hint',
  SYSTEM: 'system',
  NONE: 'none'
};
