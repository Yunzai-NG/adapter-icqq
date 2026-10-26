import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer } from "ws"
import { fakeLogger } from "@yunzai-ng/core/testing"
import type { Client } from "icqq"
import type { LoginSession, LoginStep } from "@yunzai-ng/types"
import { authVerify, sliderCode, sliderNT, sliderProxy, sliderWeb, waitTicket } from "./captcha.js"
import type { CaptchaContext } from "./captcha.js"
import { validateAccount } from "./config.js"
import { loginClient } from "./login.js"
import { updateCmdWhitelist } from "./sdk.js"

/** 一次收到的请求 */
interface Seen {
  method: string
  path: string
  body: unknown
}

/** 本地辅助站点 */
interface FakeSite {
  base: string
  seen: Seen[]
  server: Server
  wss: WebSocketServer
}

let sites: FakeSite[] = []

afterEach(async () => {
  for (const site of sites) {
    for (const client of site.wss.clients) client.terminate()
    await new Promise(resolve => site.wss.close(resolve))
    await new Promise(resolve => site.server.close(resolve))
  }
  sites = []
})

/**
 * 启动一个按路径应答的本地站点
 * @param reply 由请求算出应答；字符串原样返回，其余按 JSON
 * @returns 站点
 */
async function startSite(reply: (req: Seen) => unknown): Promise<FakeSite> {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ""
    req.on("data", chunk => (raw += chunk))
    req.on("end", () => {
      const entry: Seen = { method: req.method ?? "", path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined }
      seen.push(entry)
      const out = reply(entry)
      res.setHeader("x-test", "1")
      res.end(typeof out === "string" ? out : JSON.stringify(out ?? {}))
    })
  })
  const wss = new WebSocketServer({ server })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const site = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server, wss }
  sites.push(site)
  return site
}

/**
 * 构造验证环境
 * @param site 本地站点
 * @param signal 取消信号
 * @returns 环境与推送记录
 */
function context(site: FakeSite, signal = new AbortController().signal): CaptchaContext & { steps: LoginStep[] } {
  const steps: LoginStep[] = []
  return {
    uin: "123456",
    signal,
    logger: fakeLogger(),
    push: step => steps.push(step),
    interval: 5,
    endpoints: {
      slider: `${site.base}/captcha/slider`,
      codeHost: new URL(site.base).host,
      ntApi: `${site.base}/nt/`,
      ntPage: `${site.base}/ntpage`,
      authApi: `${site.base}/auth`,
      authPage: `${site.base}/authpage`
    },
    steps
  }
}

describe("滑动验证辅助", () => {
  it("网页验证：提交滑块地址，推送链接，按 QQ 号取回 ticket", async () => {
    let polls = 0
    const site = await startSite(req => {
      const body = req.body as Record<string, unknown> | undefined
      if (body?.["submit"] === "123456") return ++polls < 2 ? {} : { data: { ticket: "t-web" } }
      return {}
    })
    const ctx = context(site)
    const source = await sliderWeb(ctx, "https://ssl.captcha.qq.com/x?sid=1")
    expect(site.seen[0]).toMatchObject({ method: "POST", path: "/captcha/slider?key=123456", body: { url: "https://ssl.captcha.qq.com/x?sid=1" } })
    expect(ctx.steps[0]).toMatchObject({ type: "url", url: `${site.base}/captcha/slider?key=123456` })
    expect(await waitTicket(ctx, source)).toBe("t-web")
  })

  it("请求码验证：推送请求码，返回内容变化后即为 ticket", async () => {
    let calls = 0
    const site = await startSite(() => (++calls < 3 ? "CODE-1" : "t-code"))
    const ctx = context(site)
    const source = await sliderCode(ctx, "http://ssl.captcha.qq.com/cap?aid=1")
    expect(site.seen[0]?.path).toBe("/cap?aid=1")
    expect(ctx.steps[0]).toEqual({ type: "info", text: "请求码：CODE-1" })
    expect(await waitTicket(ctx, source)).toBe("t-code")
  })

  it("网页反代：注册滑块地址，代发请求并回传 base64 与响应头，收到 ticket 后断开", async () => {
    const site = await startSite(req => (req.path === "/target" ? "proxied" : {}))
    const relayed: Record<string, unknown>[] = []
    site.wss.on("connection", (socket, req) => {
      expect(req.url).toBe("/captcha/slider?key=123456")
      socket.on("message", raw => {
        const data = JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> }
        if (data.type === "register") socket.send(JSON.stringify({ type: "handle", id: 1, payload: { url: `${site.base}/target`, method: "GET" } }))
        else if (data.type === "handle") {
          relayed.push(data.payload)
          socket.send(JSON.stringify({ type: "ticket", payload: { ticket: "t-proxy" } }))
        }
      })
    })
    const ctx = context(site)
    const source = sliderProxy(ctx, "https://ssl.captcha.qq.com/x")
    expect(await waitTicket(ctx, source)).toBe("t-proxy")
    expect(relayed[0]).toMatchObject({ result: Buffer.from("proxied").toString("base64"), headers: expect.objectContaining({ "x-test": "1" }) })
    expect(ctx.steps[0]).toMatchObject({ type: "url" })
  })

  it("网页反代连不上时报验证错误", async () => {
    const site = await startSite(() => ({}))
    const ctx = context(site)
    ctx.endpoints = { ...ctx.endpoints, slider: "http://127.0.0.1:1/captcha/slider" }
    await expect(waitTicket(ctx, sliderProxy(ctx, "https://ssl.captcha.qq.com/x"))).rejects.toThrow("滑动验证错误")
  })

  it("NT 滑块：等站点就绪后推送验证页，返回 ticket,randstr", async () => {
    let calls = 0
    const site = await startSite(() => {
      calls++
      if (calls < 2) return { status: 1 }
      if (calls < 4) return { status: 0 }
      return { status: 2, ticket: "t-nt", randstr: "r" }
    })
    const ctx = context(site)
    const source = await sliderNT(ctx, "https://ssl.captcha.qq.com/x?sid=9&aid=2")
    expect(ctx.steps[0]).toMatchObject({ type: "url", url: `${site.base}/ntpage?sid=9&aid=2` })
    expect(await waitTicket(ctx, source)).toBe("t-nt,r")
  })

  it("轮询 60 次仍无 ticket 时超时并释放来源", async () => {
    const site = await startSite(() => ({}))
    const ctx = context(site)
    const close = vi.fn()
    await expect(waitTicket({ ...ctx, interval: 0 }, { ticket: async () => undefined, close })).rejects.toThrow("超时")
    expect(close).toHaveBeenCalledOnce()
  })

  it("取消时不改写成验证错误", async () => {
    const site = await startSite(() => ({}))
    const controller = new AbortController()
    const ctx = context(site, controller.signal)
    const close = vi.fn()
    const waiting = waitTicket(ctx, { ticket: async () => undefined, close })
    controller.abort(new Error("用户取消"))
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" })
    expect(close).toHaveBeenCalledOnce()
  })
})

describe("面板登录接入辅助验证", () => {
  /**
   * 只实现登录用到的几个成员的客户端
   * @param event 登录后触发的挑战
   * @param data 挑战数据
   * @returns 客户端与调用记录
   */
  function challengeClient(event: string, data: unknown) {
    const handlers = new Map<string, (arg: unknown) => void>()
    const emit = (name: string, arg?: unknown): void => handlers.get(name)?.(arg)
    const client = {
      apk: { ver: "9.3.5" },
      on: (name: string, fn: (arg: unknown) => void) => { handlers.set(name, fn); return () => handlers.delete(name) },
      login: vi.fn(async () => emit(event, data)),
      submitSlider: vi.fn(async () => emit("system.online"))
    }
    return { client, sdk: client as unknown as Client }
  }

  /**
   * 依次给出答复的登录会话
   * @param answers 答复
   * @returns 会话
   */
  function session(...answers: unknown[]): LoginSession {
    return { id: "t", logger: fakeLogger(), signal: new AbortController().signal, push: vi.fn(), ask: vi.fn(async () => answers.shift()) } as unknown as LoginSession
  }

  it("滑块选「网页验证」后自动取回 ticket 并提交", async () => {
    const site = await startSite(req => ((req.body as Record<string, unknown> | undefined)?.["submit"] ? { data: { ticket: "t-auto" } } : {}))
    const { client, sdk } = challengeClient("system.login.slider", { url: "https://ssl.captcha.qq.com/x" })
    const s = session("web")
    await loginClient(sdk, validateAccount({ uin: "123456" }), s.signal, s, { endpoints: context(site).endpoints, interval: 5 })
    expect(client.submitSlider).toHaveBeenCalledWith("t-auto")
  })
})

describe("签名命令表", () => {
  it("上线后按协议版本与 QQ 号取 cmd_whitelist 并替换 signCmd", async () => {
    const site = await startSite(() => ({ data: { list: ["a.b", "c.d"] } }))
    const client = { uin: 123456, apk: { ver: "9.3.5", fekit_ver: "8.603" }, signCmd: ["old"] }
    await updateCmdWhitelist(client as unknown as Client, `${site.base}/sign?key=k`, fakeLogger())
    expect(site.seen[0]?.path).toBe("/sign/cmd_whitelist?key=k&ver=9.3.5&fekit_ver=8.603&uin=123456")
    expect(client.signCmd).toEqual(["a.b", "c.d"])
  })

  it("没配签名服务器时不请求，取不到时保留原表", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const client = { uin: 1, apk: { ver: "1" }, signCmd: ["old"] }
    await updateCmdWhitelist(client as unknown as Client, "", fakeLogger())
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockRejectedValue(new Error("down"))
    await updateCmdWhitelist(client as unknown as Client, "http://127.0.0.1:1/", fakeLogger())
    expect(client.signCmd).toEqual(["old"])
    vi.unstubAllGlobals()
  })
})

describe("登录认证辅助", () => {
  it("取 ticket、上传设备信息，验证通过后重新登录", async () => {
    let status = 0
    const site = await startSite(req => {
      const path = req.path.split("?")[0]
      if (path === "/auth/query-bound-phone") return { retcode: 1 }
      if (path === "/auth/get-ticket") return { status: 0, data: { ticket: "tk", randstr: "rs" } }
      if (path === "/auth/upload-qqInfo") return { status: 0 }
      if (path === "/auth/get-verify-status") return { status: ++status < 2 ? 0 : 1 }
      return {}
    })
    const ctx = context(site)
    const login = vi.fn(async () => undefined)
    await authVerify(ctx, { url: "https://x/?a=1&sig=SIG%3D%3D", device: { guid: "g", qimei: "q", subappid: 7 } }, "9.3.5", login)
    expect(ctx.steps[0]).toMatchObject({ type: "url", url: `${site.base}/authpage?uin=123456` })
    expect(site.seen.find(s => s.path.startsWith("/auth/upload-qqInfo"))?.body).toEqual({
      version: "9.3.5", sig: "SIG==", ticket: "tk", randstr: "rs", guid: "g", qimei: "q", appid: 7
    })
    expect(login).toHaveBeenCalledOnce()
  })

  it("站点已有设备信息缓存时跳过上传", async () => {
    const site = await startSite(req => {
      const path = req.path.split("?")[0]
      if (path === "/auth/query-bound-phone") return { retcode: 0 }
      if (path === "/auth/get-verify-status") return { status: 1 }
      return {}
    })
    const login = vi.fn(async () => undefined)
    await authVerify(context(site), { url: "https://x/?sig=1" }, "9.3.5", login)
    expect(site.seen.map(s => s.path.split("?")[0])).toEqual(["/auth/query-bound-phone", "/auth/get-verify-status"])
    expect(login).toHaveBeenCalledOnce()
  })
})
