// 设备指纹 —— uskey / qimei36 的来源
//
// 2026-11-17 16:42 之后，腾讯 Marvis 的 `/v1/chat/completions` 会校验
// `Ual-Access-MarvisExt.uskey` 是否由 Beacon/Qimei SDK 按**本次请求上下文**现算。
// 随机 uskey 第一次请求就会 4100404（issue #70 / #71 / #72）。
//
// 本模块按优先级走三条路：
//   1. native/ 里的官方 Beacon SDK（beacon_napi.node）—— 推荐；
//   2. MARVIS_USKEY_URL 指向的外部出票服务（Docker / 容器场景）；
//   3. 仅开发兜底：MARVIS_ALLOW_RANDOM_USKEY=1 时随机生成。
//
// native/ 需要的 4 个文件：beacon_napi.node / qimei.dll / beacon_sdk.dll / beacon_wrapper.dll
// 从本机 Marvis 客户端的 win32-native 目录复制。qimei36 可以放在 native/qimei36.txt，
// 也可以用环境变量 MARVIS_QIMEI36 传入。

import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件根目录下的 native/；可用 MARVIS_NATIVE_DIR 指到外部目录 */
export const NATIVE_DIR = process.env.MARVIS_NATIVE_DIR || join(HERE, "..", "..", "native")

/** 四个文件一起才工作（beacon_napi.node 靠同目录兄弟 DLL 动态加载） */
const REQUIRED = ["beacon_napi.node", "qimei.dll", "beacon_sdk.dll", "beacon_wrapper.dll"]

/** 上游 appKey —— 来自 Marvis 的 resources/.env 的 MARVIS_QIMEI_APPKEY */
const APP_KEY = process.env.MARVIS_QIMEI_APPKEY || "0WIN06Y06DKV1IUQ"
/** Beacon SDK 初始化版本；Marvis 1.60.3400.x 实测可用 */
const APP_VERSION = process.env.MARVIS_APP_VERSION || "1.60.3400.35"

/** native SDK 的业务 id（不是 /v3 的 marvis_client） */
export const USKEY_BUS_ID = process.env.MARVIS_USKEY_BUSID || "marvis"

/** 旧版随机兜底的字节长度；只在开发兜底时使用 */
export const USKEY_BYTES = 376

/** @type {{ getUskey?: Function, getQimei?: Function, init?: Function, setCommonParams?: Function } | null} */
let beacon = null
let beaconTried = false
let beaconError = ""
let commonKey = ""
let qimeiCache = ""
let externalQimei = ""
let androidLib = null
let androidCtx = 0
let androidError = ""
let warnedAndroid = false
let warnedRandom = false
let warnedNative = false

function warnOnce(msg) {
  if (warnedNative) return
  warnedNative = true
  try {
    console.warn(`[marvis-fingerprint] ${msg}`)
  } catch {
    /* 日志失败不影响请求 */
  }
}

function applyCommon(common) {
  if (!beacon || !common) return
  const key = JSON.stringify(common)
  if (key === commonKey) return
  if (typeof beacon.setCommonParams === "function") {
    try {
      beacon.setCommonParams(common)
      commonKey = key
    } catch (err) {
      beaconError = `setCommonParams: ${err?.message ?? err}`
    }
  }
}

/**
 * 加载官方 Beacon SDK。
 *
 * 注意：`beacon_napi.node` 的真实签名是 `init(appKey, appVersion)`，
 * 不是 `init({ appKey, appVersion })`；`getUskey` 的第二参是 `busInfo` 字符串，
 * 不是 `{ reqScene, taskType }`。旧实现这两处都传错了，所以即使放了 native/
 * 也拿不到与请求上下文绑定的票。
 *
 * @param {{ guid?: string, login_openid?: string, login_type?: string }} [common]
 * @returns {object | null}
 */
function loadBeacon(common = {}) {
  if (beaconTried) {
    applyCommon(common)
    return beacon
  }
  beaconTried = true
  try {
    if (!REQUIRED.every((f) => existsSync(join(NATIVE_DIR, f)))) {
      beaconError = `native/ 缺少文件：${REQUIRED.join(" / ")}（目录 ${NATIVE_DIR}）`
      return null
    }
    const mod = require(join(NATIVE_DIR, "beacon_napi.node"))
    // 有的版本 init 返回 0，有的返回 undefined；调用失败也继续试着出票。
    try {
      mod.init(APP_KEY, APP_VERSION)
    } catch (err) {
      beaconError = `init: ${err?.message ?? err}`
    }
    beacon = mod
    applyCommon(common)
    return mod
  } catch (err) {
    beaconError = `${err?.name ?? "Error"}: ${err?.message ?? err}`
    return null
  }
}

/**
 * 外部出票服务地址：环境变量优先，其次插件 native/uskey-url.txt。
 * Android 手机上没有环境变量时，可以把 URL 写在文件里。
 */
function uskeyUrl() {
  const env = String(process.env.MARVIS_USKEY_URL || "").trim()
  if (env) return env
  // Android / ARM64 的 magpie App：默认找本机 DSH 出票守护进程（启动脚本会自动拉起）。
  if (process.platform === "android" || (process.platform === "linux" && process.arch === "arm64")) {
    return "http://127.0.0.1:4617/uskey"
  }
  for (const name of ["uskey-url.txt", "uskey_url.txt"]) {
    try {
      const v = readFileSync(join(NATIVE_DIR, name), "utf8").trim()
      if (v) return v
    } catch {
      /* 文件不存在就继续 */
    }
  }
  return ""
}

/**
 * 从外部出票服务取一张 uskey。
 *
 * 请求：POST `MARVIS_USKEY_URL`
 * body：{"busid":"marvis","businfo":"...","common":{"guid":"...","login_openid":"...","login_type":"6"}}
 * 响应：{"uskey":"..."} 或纯文本 uskey。
 *
 * @param {{ guid?: string, login_openid?: string, login_type?: string }} common
 * @param {string} busInfo
 * @returns {Promise<string>}
 */
async function externalUskey(common, busInfo) {
  const url = uskeyUrl()
  if (!url) return ""
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ busid: USKEY_BUS_ID, businfo: busInfo, common }),
    })
    if (!res.ok) return ""
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      const q = String(json?.qimei36 || json?.data?.qimei36 || "").trim()
      if (q) externalQimei = q
      return String(json?.uskey || json?.data?.uskey || "").trim()
    } catch {
      return text.trim()
    }
  } catch {
    return ""
  }
}

const QIMEI_RX = /qimei36\W{0,3}([0-9a-f]{36,40})\b/i
const CLIENT_FILE_RX = /(\.log$|\.txt$|\.ldb$|\.sst$|\.json$|manifest|current)/i
const SKIP_DIR_RX = /(node_modules|Cache|GPUCache|Code Cache|Crashpad)/i
const MAX_SCAN_FILE = 8 * 1024 * 1024

/** 从 Marvis 客户端数据目录里找 qimei36（Windows 安装后通常已经有真值） */
function detectQimeiFromClient() {
  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.TEMP]
    .filter(Boolean)
    .map((base) => join(String(base), "Tencent", "Marvis"))

  const scan = (dir, depth) => {
    if (depth > 5) return ""
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return ""
    }
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIR_RX.test(entry.name)) continue
        const found = scan(file, depth + 1)
        if (found) return found
        continue
      }
      if (!entry.isFile() || !CLIENT_FILE_RX.test(entry.name)) continue
      try {
        if (statSync(file).size > MAX_SCAN_FILE) continue
        const text = readFileSync(file, "utf8")
        const m = QIMEI_RX.exec(text)
        if (m) return m[1]
      } catch {
        /* 单个文件读不了就跳过 */
      }
    }
    return ""
  }

  for (const root of roots) {
    const found = scan(root, 0)
    if (found) return found
  }
  return ""
}

/**
 * 设备 qimei36。
 *
 * 取真值顺序：MARVIS_QIMEI36 → native/qimei36.txt → native/qimei.txt →
 * Marvis 客户端数据目录 → Beacon SDK 的 getQimei()。
 * 取不到就返回空串；调用方据此决定要不要把该字段放进请求。
 *
 * @param {{ guid?: string, login_openid?: string, login_type?: string }} [common]
 * @returns {string}
 */
export function qimei36(common = {}) {
  if (qimeiCache) return qimeiCache
  if (externalQimei) return externalQimei

  const env = String(process.env.MARVIS_QIMEI36 || "").trim()
  if (env) {
    qimeiCache = env
    return env
  }

  for (const name of ["qimei36.txt", "qimei.txt"]) {
    try {
      const v = readFileSync(join(NATIVE_DIR, name), "utf8").trim()
      if (v) {
        qimeiCache = v
        return v
      }
    } catch {
      /* 文件不存在就继续 */
    }
  }

  const b = loadBeacon(common)
  if (b && typeof b.getQimei === "function") {
    try {
      const v = String(b.getQimei() ?? "").trim()
      if (v) {
        qimeiCache = v
        return v
      }
    } catch {
      /* 继续从客户端数据里找 */
    }
  }

  const fromClient = detectQimeiFromClient()
  if (fromClient) {
    qimeiCache = fromClient
    return fromClient
  }
  return ""
}

/**
 * 本地随机 uskey —— 只用于开发兜底。
 * 2026-11-17 之后上游会按请求上下文校验，随机值在正式环境会 4100404。
 * @returns {string}
 */
export function localUskey() {
  return randomBytes(USKEY_BYTES).toString("base64")
}

/** `localUskey()` 的别名，保留旧名字方便迁移。 */
export function syntheticUskey() {
  return localUskey()
}

/**
 * Android / Bun 内置出票：直接 dlopen APP 里的 libqimei.so，调用导出的
 * UKInstanceGetDefault / UKInstanceInit / UKInstanceGetUSkey。
 *
 * 这条路只依赖插件 native/libqimei.so，不再需要外部 Python 服务；
 * Node（Windows / Linux）上 process.versions.bun 为空，会跳过。
 */
async function androidBunUskey(busInfo) {
  if (!process.versions?.bun) {
    androidError = "process.versions.bun 不存在（当前不是 Bun 运行时）"
    return ""
  }
  const libPath = join(NATIVE_DIR, "libqimei.so")
  if (!existsSync(libPath)) return ""
  try {
    if (!androidLib) {
      const { dlopen, FFIType } = await import("bun:ffi")
      androidLib = dlopen(libPath, {
        UKInstanceGetDefault: { args: [], returns: FFIType.ptr },
        UKInstanceInit: {
          args: [FFIType.ptr, FFIType.cstring, FFIType.cstring],
          returns: FFIType.void,
        },
        UKInstanceGetUSkey: {
          args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.cstring],
          returns: FFIType.cstring,
        },
      })
      androidCtx = androidLib.symbols.UKInstanceGetDefault()
      androidLib.symbols.UKInstanceInit(androidCtx, APP_KEY, APP_VERSION)
    }
    const ticket = androidLib.symbols.UKInstanceGetUSkey(androidCtx, "marvis", busInfo, "")
    return String(ticket || "").trim()
  } catch (err) {
    androidError = `${err?.name ?? "Error"}: ${err?.message ?? err}`
    if (!warnedAndroid) {
      warnedAndroid = true
      if (process.env.MARVIS_DEBUG_FFI === "1") {
        try {
          console.warn(`[marvis-fingerprint] Android Bun 出票失败：${androidError}`)
        } catch {
          /* 日志失败不影响请求 */
        }
      }
    }
    return ""
  }
}

/**
 * 按本次请求上下文出一张 uskey。
 *
 * @param {{ guid?: string, openid?: string, loginType?: string }} [acct]
 * @param {{ busInfo?: string, loginType?: string }} [identity]
 * @returns {Promise<string>}
 */
export async function uskeyOf(acct = {}, identity = {}) {
  const busInfo = String(identity.busInfo || "")
  if (!busInfo) throw new Error("uskeyOf 需要 identity.busInfo（请求上下文不能为空）")

  const common = {
    guid: String(acct.guid ?? ""),
    login_openid: String(acct.openid ?? ""),
    login_type: String(identity.loginType ?? process.env.MARVIS_LOGIN_TYPE ?? "6"),
  }

  const android = await androidBunUskey(busInfo)
  if (android) return android

  const b = loadBeacon(common)
  if (b && typeof b.getUskey === "function") {
    try {
      const real = String(b.getUskey(USKEY_BUS_ID, busInfo) ?? "").trim()
      if (real && real !== "null") return real
    } catch (err) {
      beaconError = `getUskey: ${err?.message ?? err}`
    }
  }

  const external = await externalUskey(common, busInfo)
  if (external) return external

  // 开发兜底：默认允许（保持旧行为），线上请把 native/ 放好或设置 MARVIS_USKEY_URL。
  // 想强制检查是否真的在出票，设 MARVIS_ALLOW_RANDOM_USKEY=0。
  if (process.env.MARVIS_ALLOW_RANDOM_USKEY !== "0") {
    if (!warnedRandom) {
      warnedRandom = true
      warnOnce(
        `没有可用的 Beacon 出票（${beaconError || "native/ 不可用"}），` +
          "正在使用随机 uskey；2026-11-17 之后上游会返回 4100404。请安装 native/ 或设置 MARVIS_USKEY_URL。",
      )
    }
    return localUskey()
  }

  throw new Error(
    `Marvis uskey 出票失败：请把 Marvis 客户端的 4 个 native 文件放进 ${NATIVE_DIR}，` +
      `或设置 MARVIS_USKEY_URL。${beaconError ? `底层原因：${beaconError}` : ""}`,
  )
}

/** 当前是否在用官方 Beacon SDK 签指纹（诊断用） */
export function usingNativeFingerprint() {
  return loadBeacon() !== null
}

/** 出票/指纹状态（诊断用） */
export function fingerprintStatus() {
  const native = usingNativeFingerprint()
  const qimei = qimei36()
  return {
    native,
    nativeDir: NATIVE_DIR,
    qimei36: qimei ? `${qimei.slice(0, 6)}…` : "",
    qimei36Length: qimei.length,
    backend: androidLib ? "android-bun" : native ? "native" : uskeyUrl() ? "external" : "random",
    error: androidError || beaconError,
  }
}

/** 给用户看的说明 */
export function fingerprintHint() {
  if (usingNativeFingerprint()) return "使用 native/ 里的 Beacon SDK 现签设备指纹"
  if (uskeyUrl()) return "使用外部出票服务（MARVIS_USKEY_URL / native/uskey-url.txt）"
  return "未配置真实出票：随机 uskey 会被上游 4100404 拦截"
}
