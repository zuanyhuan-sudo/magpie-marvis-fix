// tests/request-identity.test.mjs —— 4100404 修复的上下文拼装锁
//
// 上游从 2026-11-17 起要求 uskey 与本次请求的 bus_info 绑定：
//   marvisAgentTag / marvisConversationID / marvisResponseID / marvisScene /
//   model / nonce / originOpenID
// 这里只做离线字符串断言，不加载 native、不发网络请求。

import test from "node:test"
import assert from "node:assert/strict"
import { requestIdentity, llmHeaders } from "../src/marvis/protocol.mjs"

const acct = Object.freeze({ openid: "o_test", accessToken: "mv_test", guid: "a".repeat(32) })

test("requestIdentity 按固定顺序拼出 7 段 bus_info", () => {
  const id = requestIdentity(acct, { model: "main-auto" })
  const parts = id.busInfo.split("&")
  assert.equal(parts.length, 7)
  assert.match(parts[0], /^marvisAgentTag=main$/)
  assert.match(parts[1], /^marvisConversationID=conv_[0-9a-f]{32}$/)
  assert.match(parts[2], /^marvisResponseID=resp_[0-9a-f]{32}$/)
  assert.match(parts[3], /^marvisScene=agent_chat$/)
  assert.match(parts[4], /^model=main-auto$/)
  assert.match(parts[5], /^nonce=[0-9a-f-]{36}$/)
  assert.match(parts[6], /^originOpenID=o_test$/)
})

test("llmHeaders 的 Marvis-* 头与 bus_info 使用同一组 id", async () => {
  process.env.MARVIS_ALLOW_RANDOM_USKEY = "1"
  const h = await llmHeaders(acct, { model: "main-auto" })
  assert.equal(h["Marvis-AgentTag"], "main")
  assert.equal(h["Marvis-Scene"], "agent_chat")
  assert.equal(h["Ual-Access-Login-Type"], "6")
  assert.equal(h["Marvis-Model-Level"], "1")
  assert.match(h["Marvis-Conversation-ID"], /^conv_[0-9a-f]{32}$/)
  assert.match(h["Marvis-Response-ID"], /^resp_[0-9a-f]{32}$/)
  assert.equal(h["Ual-Access-Requestid"], h["Marvis-Response-ID"])
  assert.equal(JSON.parse(h["Ual-Access-MarvisExt"]).nonce.length > 0, true)
})
