import { afterEach, describe, expect, it, vi } from "vitest"
import type { Client, GroupMessage, MessageElem } from "icqq"
import { genGroupMessageId } from "icqq"
import type { AdapterHost, LoginSession, IncomingEvent } from "@yunzai-ng/types"
import { validateAccount } from "./config.js"
import { encode, decode, flatten, mediaFile } from "./codec.js"
import { genDmMessageId as localDmId, genGroupMessageId as localGroupId, messageEvent, otherEvent } from "./events.js"
import { loginClient } from "./login.js"
import { createIcqqBot } from "./bot.js"
import { loadSdk, resetSdk } from "./sdk.js"
import { fileId, parseFileId, uploadFile } from "./media.js"

function fakeClient() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const peer = {
    sendMsg: vi.fn(async () => ({ message_id: "sent", time: 10 })),
    sendFile: vi.fn(async () => "file"), makeForwardMsg: vi.fn(async () => ({ type: "json", data: "{}" })),
    shareUrl: vi.fn(), shareMusic: vi.fn(), getChatHistory: vi.fn(async () => [])
  }
  const client = {
    uin: 123456, nickname: "测试账号", logger: {},
    on(name: string, callback: (...args: unknown[]) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name)!.add(callback)
      return () => { handlers.get(name)?.delete(callback) }
    },
    emit(name: string, data?: unknown) { for (const fn of [...handlers.get(name) ?? []]) fn(data) },
    count() { return [...handlers.values()].reduce((sum, set) => sum + set.size, 0) },
    off(name: string) { handlers.delete(name) },
    login: vi.fn(async () => { client.emit("system.online") }),
    terminate: vi.fn(), isOnline: () => true,
    queryQrcodeResult: vi.fn(async () => ({ retcode: 0 })), qrcodeLogin: vi.fn(async () => { client.emit("system.online") }),
    submitSlider: vi.fn(async () => { client.emit("system.online") }),
    sendSmsCode: vi.fn(), submitSmsCode: vi.fn(async () => { client.emit("system.online") }),
    pickGroup: vi.fn(() => peer), pickFriend: vi.fn(() => peer), pickMember: vi.fn(() => peer),
    getMsg: vi.fn(async () => undefined as unknown), deleteMsg: vi.fn(async () => true),
    fl: new Map(), gl: new Map(), peer
  }
  return { fake: client, sdk: client as unknown as Client }
}

function fakeHost() {
  const controller = new AbortController()
  const submitted: IncomingEvent[] = []
  const cache = new Map<string, unknown>()
  const host = {
    signal: controller.signal, submit: (event: IncomingEvent) => submitted.push(event),
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), mark: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
    setStatus: vi.fn(), onDispose: vi.fn(),
    createCache: () => ({
      get: (key: string) => cache.get(key), set: (key: string, value: unknown) => cache.set(key, value),
      delete: (key: string) => cache.delete(key), clear: () => cache.clear(),
      fetch: async (key: string, loader: () => Promise<unknown>) => cache.get(key) ?? loader()
    })
  } as unknown as AdapterHost
  return { host, controller, submitted }
}

function fakeSession(ask = vi.fn(async () => "ticket")) {
  return { id: "test", signal: new AbortController().signal, push: vi.fn(), ask } as unknown as LoginSession
}

const account = () => validateAccount({ uin: "123456" })
const message = () => ({
  message_type: "group", sub_type: "normal", message_id: "incoming", seq: 1, time: 100,
  group_id: 654321, group_name: "测试群", sender: { user_id: 77777, nickname: "用户", role: "admin", card: "名片" },
  message: [{ type: "text", text: "hello" }]
}) as unknown as GroupMessage

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe("配置与协议补丁", () => {
  it("规范化账号，默认不保留完整群成员表", () => {
    expect(validateAccount({ uin: " 123456 ", signApiAddr: " https://sign.test/?key=abc " })).toMatchObject({ uin: "123456", cacheGroupMember: false, platform: 3 })
  })
  it.each(["", "abc", "0", "123.45", "12345678901234567890"])("拒绝非法账号 %s", uin => {
    expect(() => validateAccount({ uin })).toThrow()
  })
  it("拒绝非法签名地址和设备号", () => {
    expect(() => validateAccount({ uin: "123456", signApiAddr: "file:///x" })).toThrow()
    expect(() => validateAccount({ uin: "123456", platform: 99 })).toThrow()
  })
  it("真实协议库加载补丁且幂等", async () => {
    const loaded = await loadSdk()
    expect(await loadSdk()).toBe(loaded)
    expect(loaded).toMatchObject({ version: "0.6.10", patched: true })
    expect(loaded.sdk.Parser.prototype).toHaveProperty("parseNewImgElem")
    expect(loaded.sdk.Parser.prototype).toHaveProperty("core", loaded.sdk.core)
  })
  it("按顺序跳过不存在的目录；1.x 不打补丁；全部失败时可重试", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const root = await mkdtemp(join(tmpdir(), "icqq-sdk-"))
    try {
      const fake = join(root, "v1")
      await mkdir(join(fake, "lib"), { recursive: true })
      await writeFile(join(fake, "package.json"), JSON.stringify({ name: "@icqqjs/icqq", version: "1.2.3", main: "lib/index.js" }))
      await writeFile(join(fake, "lib", "index.js"), "module.exports = { marker: 1 }")
      resetSdk()
      await expect(loadSdk([join(root, "missing")])).rejects.toThrow("找不到可用的 icqq")
      const loaded = await loadSdk([join(root, "missing"), fake])
      expect(loaded).toMatchObject({ version: "1.2.3", patched: false, dir: fake, sdk: { marker: 1 } })
    } finally {
      resetSdk()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("消息转换", () => {
  it("展平输入，保留 0 并过滤条件空项", () => {
    expect(flatten(["a", [0, false, null, undefined]])).toEqual([{ type: "text", text: "a" }, { type: "text", text: "0" }])
  })
  it("转换 atAll、图片 headers 和位置字段，不修改输入", () => {
    const input = [{ type: "atAll" }, { type: "image", file: { kind: "url", url: "https://x/a", headers: { Referer: "x" } } }, { type: "location", lat: 1, lon: 2, title: "地点" }] as const
    expect(encode([...input])).toEqual([{ type: "at", qq: "all" }, expect.objectContaining({ file: "https://x/a", headers: { Referer: "x" } }), { type: "location", lat: 1, lng: 2, name: "地点", address: "地点" }])
    expect(input[1].file.kind).toBe("url")
  })
  it("保持未知消息段、NT 图片地址与二进制媒体", () => {
    expect(decode([{ type: "image", file: "opaque", url: "https://x/image" }, { type: "new-type", value: 1 }] as unknown as MessageElem[])).toEqual([
      expect.objectContaining({ file: { kind: "url", url: "https://x/image" } }),
      { type: "raw", platform: "icqq", platformType: "new-type", data: { type: "new-type", value: 1 } }
    ])
    expect(mediaFile({ kind: "base64", base64: "YWJj" })).toEqual(Buffer.from("abc"))
  })
  it("拒绝跨平台 raw", () => {
    expect(() => encode([{ type: "raw", platform: "telegram", platformType: "x", data: {} }])).toThrow()
  })
  it("保留群角色和正确编码引用 id", () => {
    const data = message()
    data.source = { user_id: 88888, seq: 3, rand: 4, time: 5, message: "quoted" }
    expect(messageEvent(data)).toMatchObject({ scene: "group", time: 100000, sender: { uid: "77777", role: "admin" }, quote: { messageId: genGroupMessageId(654321, 88888, 3, 4, 5), message: [{ type: "text", text: "quoted" }] } })
  })
  it("本地消息 id 编码与 icqq 逐字节一致", async () => {
    const { sdk } = await loadSdk()
    for (const [a, b, c, d, e] of [[654321, 88888, 3, 4, 5], [4294967295, 1, -1, -2147483648, 1700000000]]) {
      expect(localGroupId(a!, b!, c!, d!, e!)).toBe(sdk.genGroupMessageId(a!, b!, c!, d!, e!))
      expect(localGroupId(a!, b!, c!, d!, e!, 3)).toBe(sdk.genGroupMessageId(a!, b!, c!, d!, e!, 3))
      expect(localDmId(b!, c!, d!, e!, 1)).toBe(sdk.genDmMessageId(b!, c!, d!, e!, 1))
    }
  })
  it("转换撤回、戳一戳与入群申请", () => {
    expect(otherEvent({ notice_type: "group", sub_type: "poke", user_id: 1, operator_id: 2, target_id: 1, group_id: 3 })).toMatchObject({ noticeType: "poke", uid: "2", targetId: "1" })
    expect(otherEvent({ post_type: "request", request_type: "group", sub_type: "invite", user_id: 1, group_id: 2, flag: "flag" })).toMatchObject({ requestType: "group.invite", flag: "flag" })
    expect(otherEvent({ notice_type: "group", sub_type: "recall", user_id: 1, message_id: "id" })).toMatchObject({ noticeType: "message.recall", messageId: "id" })
  })
})

describe("交互登录", () => {
  it("正常上线后释放全部登录监听器", async () => {
    const { fake, sdk } = fakeClient()
    await loginClient(sdk, account(), new AbortController().signal)
    expect(fake.count()).toBe(0)
  })
  it("后台登录遇到验证立即失败", async () => {
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => { fake.emit("system.login.slider", { url: "https://captcha.test" }) })
    await expect(loginClient(sdk, account(), new AbortController().signal)).rejects.toThrow("面板")
    expect(fake.count()).toBe(0)
  })
  it("面板提交滑块 ticket 后继续登录", async () => {
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => { fake.emit("system.login.slider", { url: "https://captcha.test" }) })
    const session = fakeSession()
    await loginClient(sdk, account(), session.signal, session)
    expect(fake.submitSlider).toHaveBeenCalledWith("ticket")
    expect(fake.count()).toBe(0)
  })
  it("短信验证", async () => {
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => { fake.emit("system.login.device", { url: "https://device.test" }) })
    const session = fakeSession(vi.fn().mockResolvedValueOnce("sms").mockResolvedValueOnce("123456"))
    await loginClient(sdk, account(), session.signal, session)
    expect(fake.sendSmsCode).toHaveBeenCalledOnce()
    expect(fake.submitSmsCode).toHaveBeenCalledWith("123456")
  })
  it("取消时拒绝登录并移除监听器", async () => {
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => {})
    const controller = new AbortController()
    const promise = loginClient(sdk, account(), controller.signal)
    controller.abort(new Error("已取消"))
    await expect(promise).rejects.toThrow("已取消")
    expect(fake.count()).toBe(0)
  })
  it("等待用户输入期间取消，迟到的 ticket 不再提交", async () => {
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => { fake.emit("system.login.slider", { url: "https://captcha.test" }) })
    let answer!: (value: string) => void
    const session = fakeSession(vi.fn(() => new Promise<string>(resolve => { answer = resolve })))
    const controller = new AbortController()
    const promise = loginClient(sdk, account(), controller.signal, session)
    controller.abort(new Error("取消"))
    await expect(promise).rejects.toThrow("取消")
    answer("late-ticket")
    await Promise.resolve()
    expect(fake.submitSlider).not.toHaveBeenCalled()
  })
  it("登录错误不悬挂", async () => {
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => { fake.emit("system.login.error", { code: 45, message: "验证失败" }) })
    await expect(loginClient(sdk, account(), new AbortController().signal)).rejects.toThrow("45")
    expect(fake.count()).toBe(0)
  })
  it("二维码过期会停止轮询", async () => {
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => { fake.emit("system.login.qrcode", { image: Buffer.from("png") }) })
    fake.queryQrcodeResult.mockResolvedValue({ retcode: 17 })
    const session = fakeSession()
    await expect(loginClient(sdk, account(), session.signal, session)).rejects.toThrow("过期")
    expect(fake.count()).toBe(0)
    expect(fake.qrcodeLogin).not.toHaveBeenCalled()
  })
  it("登录超时会清理监听器", async () => {
    vi.useFakeTimers()
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => {})
    const promise = loginClient(sdk, { ...account(), loginTimeout: 10 }, new AbortController().signal)
    const rejected = expect(promise).rejects.toThrow("超时")
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(fake.count()).toBe(0)
  })
})

describe("驱动生命周期与发送", () => {
  it("只连接一次，接收事件；下线上报 offline 交给内核重连", async () => {
    const { fake, sdk } = fakeClient()
    const { host, submitted } = fakeHost()
    const bot = await createIcqqBot(account(), host, sdk)
    await Promise.all([bot.connect(), bot.connect()])
    expect(fake.login).toHaveBeenCalledOnce()
    fake.emit("message", message())
    expect(submitted).toHaveLength(2)
    fake.emit("system.offline", { message: "断网" })
    expect(host.setStatus).toHaveBeenLastCalledWith("offline", { error: "断网" })
    await bot.disconnect()
    fake.emit("message", message())
    expect(submitted).toHaveLength(2)
    expect(fake.count()).toBe(0)
    expect(fake.terminate).toHaveBeenCalledOnce()
  })
  it("引用使用原始消息，发送文本与文件保留顺序", async () => {
    const { fake, sdk } = fakeClient()
    const { host } = fakeHost()
    const bot = await createIcqqBot(account(), host, sdk)
    await bot.connect()
    const quote = { seq: 7, rand: 8, time: 9, user_id: 1, message: "引用" }
    fake.getMsg.mockResolvedValue(quote)
    const result = await bot.sendMessage({ scene: "group", gid: "654321" }, ["a", { type: "file", file: { kind: "buffer", data: Buffer.from("abc") }, name: "a.txt" }, "b"], { quote: "quoted" })
    expect(fake.peer.sendMsg).toHaveBeenNthCalledWith(1, [{ type: "text", text: "a" }], quote)
    expect(fake.peer.sendFile).toHaveBeenCalledWith(Buffer.from("abc"), "/", "a.txt")
    expect(fake.peer.sendMsg).toHaveBeenNthCalledWith(2, [{ type: "text", text: "b" }], quote)
    expect(result.ok).toBe(true)
    await bot.disconnect()
  })
  it("发送失败向调用方抛错，不重复已发送内容", async () => {
    const { fake, sdk } = fakeClient()
    const { host } = fakeHost()
    const bot = await createIcqqBot(account(), host, sdk)
    await bot.connect()
    fake.peer.sendMsg.mockRejectedValue(new Error("风控"))
    await expect(bot.sendMessage({ scene: "private", uid: "77777" }, "hello")).rejects.toThrow("风控")
    expect(fake.peer.sendMsg).toHaveBeenCalledOnce()
    await bot.disconnect()
  })
  it("宿主取消终止正在连接的客户端", async () => {
    const { fake, sdk } = fakeClient()
    fake.login.mockImplementation(async () => {})
    const { host, controller } = fakeHost()
    const bot = await createIcqqBot(account(), host, sdk)
    const connecting = bot.connect()
    controller.abort()
    await expect(connecting).rejects.toThrow()
    expect(fake.terminate).toHaveBeenCalledOnce()
    expect(fake.count()).toBe(0)
  })
  it("已取消的宿主不会重新挂监听器", async () => {
    const { fake, sdk } = fakeClient()
    const { host, controller } = fakeHost()
    controller.abort()
    const bot = await createIcqqBot(account(), host, sdk)
    await expect(bot.connect()).rejects.toThrow()
    expect(fake.count()).toBe(0)
  })
  it("断开后清除自动撤回和 ICQQ token 重试定时器", async () => {
    vi.useFakeTimers()
    const { fake, sdk } = fakeClient()
    const lateLogin = vi.fn()
    Object.assign(fake, { login_timer: setTimeout(lateLogin, 3000) })
    const { host } = fakeHost()
    const bot = await createIcqqBot(account(), host, sdk)
    await bot.connect()
    await bot.sendMessage({ scene: "group", gid: "654321" }, "a", { recallAfter: 1000 })
    await bot.disconnect()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fake.deleteMsg).not.toHaveBeenCalled()
    expect(lateLogin).not.toHaveBeenCalled()
  })
})

describe("文件资源", () => {
  it("文件标识保留会话与原始资源，拒绝非法标识", () => {
    expect(parseFileId(fileId("group", "123456", "/a:b"))).toEqual(["group", "123456", "/a:b"])
    expect(() => parseFileId("foreign-id")).toThrow()
    expect(() => parseFileId("icqq-file:e30")).toThrow()
  })
  it("远程文件携带请求头并保留二进制内容", async () => {
    const fetcher = vi.fn(async () => new Response(Buffer.from([0, 1, 255])))
    vi.stubGlobal("fetch", fetcher)
    expect(await uploadFile({ kind: "url", url: "https://files.test/a", headers: { Referer: "test" } }, new AbortController().signal)).toEqual(Buffer.from([0, 1, 255]))
    expect(fetcher).toHaveBeenCalledWith("https://files.test/a", expect.objectContaining({ headers: { Referer: "test" } }))
  })
  it("拒绝 HTTP 失败和超大远程文件", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })))
    await expect(uploadFile({ kind: "url", url: "https://files.test/a" }, new AbortController().signal)).rejects.toThrow("403")
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "content-length": String(65 * 1024 * 1024) } })))
    await expect(uploadFile({ kind: "url", url: "https://files.test/a" }, new AbortController().signal)).rejects.toThrow("64 MiB")
  })
})
