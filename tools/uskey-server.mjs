// 最小出票服务：给 magpie 插件（或 Docker 里的插件）提供 uskey。
//
// 用法（需要插件根目录 native/ 的 4 个文件）：
//   node tools/uskey-server.mjs --port 4617
//
// 然后在 magpie 插件所在环境设置：
//   MARVIS_USKEY_URL=http://127.0.0.1:4617/uskey
//
// 请求：POST /uskey
// {"busid":"marvis","businfo":"marvisAgentTag=main&...","common":{"guid":"...","login_openid":"...","login_type":"6"}}
// 响应：{"uskey":"..."}
//
// 这个服务不保存凭据；common 只在本次请求里传给 Beacon SDK。

import http from "node:http"
import { uskeyOf, fingerprintStatus } from "../src/marvis/fingerprint.mjs"

process.env.MARVIS_ALLOW_RANDOM_USKEY = "0"
process.env.MARVIS_USKEY_URL = ""

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const host = argOf("host", process.env.MARVIS_USKEY_HOST || "127.0.0.1")
const port = Number(argOf("port", process.env.MARVIS_USKEY_PORT || "4617"))

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ""
    req.setEncoding("utf8")
    req.on("data", (c) => {
      buf += c
      if (buf.length > 1024 * 1024) {
        reject(new Error("body too large"))
        req.destroy()
      }
    })
    req.on("end", () => resolve(buf))
    req.on("error", reject)
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    return send(res, 200, { status: "ok", ...fingerprintStatus() })
  }
  if (req.method !== "POST" || !req.url.startsWith("/uskey")) {
    return send(res, 404, { error: "not_found" })
  }
  try {
    const raw = await readBody(req)
    const body = JSON.parse(raw || "{}")
    const common = body.common || {}
    const acct = {
      guid: String(common.guid || ""),
      openid: String(common.login_openid || ""),
      loginType: String(common.login_type || "6"),
    }
    const uskey = await uskeyOf(acct, {
      busInfo: String(body.businfo || ""),
      loginType: String(common.login_type || "6"),
    })
    return send(res, 200, { uskey })
  } catch (err) {
    return send(res, 503, { error: String(err?.message ?? err) })
  }
})

server.listen(port, host, () => {
  console.log(`[uskey-server] http://${host}:${port}/uskey`)
  console.log(`[uskey-server] native: ${fingerprintStatus().native ? "ok" : "not ready"}`)
})
