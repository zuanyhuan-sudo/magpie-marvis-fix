// 从本机已安装的 Marvis Windows 客户端提取 Beacon SDK 的 4 个文件到插件 native/。
// 用法：node tools/extract-native.mjs
//
// 默认搜索：
//   %ProgramFiles%\Tencent\Marvis\Application\<version>\win32-native
//   %ProgramFiles(x86)%\Tencent\Marvis\Application\<version>\win32-native
//   C: ~ H: 盘的 Program Files 下同样的路径
//
// 只复制，不改客户端。复制前请确认你使用本插件的方式符合腾讯的服务条款。

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NATIVE = join(ROOT, "native")
const FILES = ["beacon_napi.node", "qimei.dll", "beacon_sdk.dll", "beacon_wrapper.dll"]

function candidates() {
  const bases = []
  for (const env of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    if (process.env[env]) bases.push(process.env[env])
  }
  for (const drive of ["C", "D", "E", "F", "G", "H"]) {
    bases.push(`${drive}:\\Program Files`, `${drive}:\\Program Files (x86)`)
  }
  const out = []
  for (const base of bases) {
    const app = join(base, "Tencent", "Marvis", "Application")
    if (!existsSync(app)) continue
    for (const ver of readdirSync(app).sort().reverse()) {
      const dir = join(app, ver, "win32-native")
      if (existsSync(join(dir, "beacon_napi.node"))) out.push(dir)
    }
  }
  return out
}

const dirs = candidates()
if (dirs.length === 0) {
  console.error("没有找到 Marvis 的 win32-native 目录。")
  console.error("请手动把 beacon_napi.node / qimei.dll / beacon_sdk.dll / beacon_wrapper.dll 放进 native/。")
  process.exit(1)
}

mkdirSync(NATIVE, { recursive: true })
const src = dirs[0]
for (const file of FILES) {
  const from = join(src, file)
  if (!existsSync(from)) {
    console.error(`缺少 ${file}（目录 ${src}）`)
    process.exit(1)
  }
  copyFileSync(from, join(NATIVE, file))
  console.log(`copied ${file}`)
}
console.log(`完成：${NATIVE}`)
console.log("可选：把真实 qimei36 写进 native/qimei36.txt，或设置 MARVIS_QIMEI36。")
