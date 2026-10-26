import { setTimeout as sleep } from "node:timers/promises"
import WebSocket from "ws"
import type { Logger, LoginStep } from "@yunzai-ng/types"

/**
 * 验证辅助站点
 *
 * 均由第三方运营。站点停服时对应的验证方式不可用，
 * 手动填写 ticket 不受影响。
 */
export const CAPTCHA_ENDPOINTS = {
  /** 网页验证与网页反代 */
  slider: "https://GT.928100.xyz/captcha/slider",
  /** 请求码验证：把腾讯验证码域名替换成这个 */
  codeHost: "txhelper.glitch.me",
  /** NT 登录的滑块 ticket 查询 */
  ntApi: "https://captcha-nt-api.928100.xyz/",
  /** NT 登录的滑块页面 */
  ntPage: "https://CapNT.928100.xyz",
  /** 登录认证接口 */
  authApi: "https://captcha-api.928100.xyz",
  /** 登录认证页面 */
  authPage: "https://Auth.928100.xyz"
}

/** 验证辅助站点地址表 */
export type CaptchaEndpoints = typeof CAPTCHA_ENDPOINTS

/** 验证流程的运行环境 */
export interface CaptchaContext {
  /** QQ 号 */
  uin: string
  /** 登录结束或取消时 abort */
  signal: AbortSignal
  /** 日志器 */
  logger: Logger
  /** 向面板推送一步 */
  push(step: LoginStep): void
  /** 覆盖辅助站点地址（测试用） */
  endpoints?: Partial<CaptchaEndpoints>
  /** 轮询间隔毫秒，缺省 3000 */
  interval?: number
}

/** 一个等待中的 ticket 来源 */
export interface TicketSource {
  /** 取一次 ticket；尚未就绪时 undefined */
  ticket(): Promise<string | undefined>
  /** 释放连接 */
  close(): void
}

/** 单次请求超时 */
const REQUEST_TIMEOUT = 15_000

/**
 * 取环境里的站点地址
 * @param ctx 环境
 * @returns 合并后的地址表
 */
function endpoints(ctx: CaptchaContext): CaptchaEndpoints {
  return { ...CAPTCHA_ENDPOINTS, ...ctx.endpoints }
}

/**
 * 发一次请求，随登录取消或超时中止
 * @param ctx 环境
 * @param url 地址
 * @param init 请求参数
 * @returns 响应
 */
async function request(ctx: CaptchaContext, url: string, init: RequestInit = {}): Promise<Response> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
  const response = await fetch(url, { ...init, signal })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`请求 ${new URL(url).host} 失败：HTTP ${response.status}`)
  }
  return response
}

/**
 * 请求并解析 JSON
 * @param ctx 环境
 * @param url 地址
 * @param body 有则以 JSON POST
 * @returns 响应数据
 */
async function json<T>(ctx: CaptchaContext, url: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  return (await (await request(ctx, url, init)).json()) as T
}

/**
 * 按间隔等待，可被取消
 * @param ctx 环境
 * @param ms 毫秒；缺省用环境的轮询间隔
 */
async function wait(ctx: CaptchaContext, ms = ctx.interval ?? 3000): Promise<void> {
  await sleep(ms, undefined, { signal: ctx.signal })
}

/**
 * 网页验证：把滑块地址交给辅助站点，用户在浏览器里完成，再按 QQ 号取回 ticket
 * @param ctx 环境
 * @param captchaUrl icqq 给出的滑块地址
 * @returns ticket 来源
 */
export async function sliderWeb(ctx: CaptchaContext, captchaUrl: string): Promise<TicketSource> {
  const url = `${endpoints(ctx).slider}?key=${ctx.uin}`
  await json(ctx, url, { url: captchaUrl })
  ctx.push({ type: "url", url, text: "请打开下方链接完成滑动验证" })
  return {
    ticket: async () => (await json<{ data?: { ticket?: string } }>(ctx, url, { submit: ctx.uin })).data?.ticket,
    close: () => undefined
  }
}

/**
 * 请求码验证：辅助站点给出一段请求码，验证完成后同一地址返回 ticket
 * @param ctx 环境
 * @param captchaUrl icqq 给出的滑块地址
 * @returns ticket 来源
 */
export async function sliderCode(ctx: CaptchaContext, captchaUrl: string): Promise<TicketSource> {
  const url = captchaUrl.replace("ssl.captcha.qq.com", endpoints(ctx).codeHost)
  const code = await (await request(ctx, url)).text()
  ctx.push({ type: "info", text: `请求码：${code}` })
  return {
    ticket: async () => {
      const text = await (await request(ctx, url)).text()
      return text === code ? undefined : text
    },
    close: () => undefined
  }
}

/**
 * 网页反代验证：经 WebSocket 由本机代辅助站点发出验证请求
 *
 * 站点下发的 `handle` 请求会由本机原样发出并回传响应。
 * 这样验证请求出自机器人的 IP，代价是该站点能经本机访问任意地址。
 * @param ctx 环境
 * @param captchaUrl icqq 给出的滑块地址
 * @returns ticket 来源
 */
export function sliderProxy(ctx: CaptchaContext, captchaUrl: string): TicketSource {
  const url = `${endpoints(ctx).slider}?key=${ctx.uin}`
  const ws = new WebSocket(url.replace(/^http/i, "ws"))
  let ticket: string | Error | undefined
  const close = (): void => ws.terminate()
  const send = (data: unknown): void => {
    ctx.logger.debug(`发送 ${url}`, data)
    ws.send(JSON.stringify(data))
  }
  ctx.signal.addEventListener("abort", close, { once: true })

  ws.on("open", () => {
    send({ type: "register", payload: { url: captchaUrl } })
    ctx.push({ type: "url", url, text: "请打开下方链接完成滑动验证" })
  })
  ws.on("close", () => {
    ctx.logger.debug(`连接关闭 ${url}`)
    ticket ??= new Error(`连接关闭 ${url}`)
  })
  ws.on("error", error => {
    ctx.logger.debug(`连接错误 ${url}`, error)
    ticket ??= new Error(`连接错误 ${url}`, { cause: error })
    close()
  })
  ws.on("message", raw => {
    void (async () => {
      const data = JSON.parse(String(raw)) as { type?: string; payload?: Record<string, unknown> }
      ctx.logger.debug(`收到 ${url}`, data)
      switch (data.type) {
        case "ticket":
          ticket = String(data.payload?.["ticket"] ?? "")
          close()
          break
        case "handle": {
          const { url: target, ...init } = (data.payload ?? {}) as unknown as RequestInit & { url: string }
          const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
          const response = await fetch(target, { ...init, signal })
          data.payload = {
            result: Buffer.from(await response.arrayBuffer()).toString("base64"),
            headers: Object.fromEntries(response.headers.entries())
          }
          send(data)
          break
        }
        default:
          ctx.logger.info(data)
      }
    })().catch(error => ctx.logger.error(error))
  })

  return {
    ticket: async () => {
      if (ticket instanceof Error) throw ticket
      return ticket
    },
    close
  }
}

/**
 * NT 登录的滑块：等辅助站点就绪后推送验证页，完成后取回 `ticket,randstr`
 * @param ctx 环境
 * @param captchaUrl icqq 给出的滑块地址
 * @returns ticket 来源
 */
export async function sliderNT(ctx: CaptchaContext, captchaUrl: string): Promise<TicketSource> {
  const { ntApi, ntPage } = endpoints(ctx)
  const url = `${ntApi}?key=${ctx.uin}`
  type Status = { status?: string | number; ticket?: string; randstr?: string }
  for (;;) {
    const res = await json<Status>(ctx, url)
    ctx.logger.debug("Ticket", res)
    if (String(res.status) === "0") break
    await wait(ctx)
  }
  ctx.push({ type: "url", url: `${ntPage}?${new URL(captchaUrl).searchParams.toString()}`, text: "请打开下方链接完成滑动验证" })
  return {
    ticket: async () => {
      const res = await json<Status>(ctx, url)
      ctx.logger.debug("Ticket", res)
      return String(res.status) !== "0" && res.ticket && res.randstr ? `${res.ticket},${res.randstr}` : undefined
    },
    close: () => undefined
  }
}

/**
 * 轮询 ticket，最多 60 次
 * @param ctx 环境
 * @param source ticket 来源
 * @returns ticket
 * @throws 超时或来源出错时
 */
export async function waitTicket(ctx: CaptchaContext, source: TicketSource): Promise<string> {
  try {
    for (let i = 0; i < 60; i++) {
      await wait(ctx)
      const ticket = await source.ticket()
      if (ticket) return ticket
    }
  } catch (error) {
    if (ctx.signal.aborted) throw error
    throw new Error("滑动验证错误，请重新登录", { cause: error })
  } finally {
    source.close()
  }
  throw new Error("滑动验证超时，请重新登录")
}

/** `system.login.auth` 的事件数据 */
export interface AuthChallenge {
  /** 验证地址，含 sig */
  url: string
  /** 设备标识 */
  device?: { guid?: unknown; qimei?: unknown; subappid?: unknown }
}

/**
 * 登录认证：经辅助站点取 ticket、上传设备信息，等待验证通过后重新登录
 *
 * 会把 sig、ticket、guid、qimei、subappid 与协议版本上传给辅助站点。
 * @param ctx 环境
 * @param data 认证事件数据
 * @param version 协议版本
 * @param login 验证通过后调用
 * @throws 各阶段超时时
 */
export async function authVerify(
  ctx: CaptchaContext,
  data: AuthChallenge,
  version: string,
  login: () => Promise<void>
): Promise<void> {
  const { authApi, authPage } = endpoints(ctx)
  const api = (path: string): string => `${authApi}/${path}?uin=${ctx.uin}`
  const interval = ctx.interval ?? 5000
  ctx.push({ type: "url", url: `${authPage}?uin=${ctx.uin}`, text: "请打开下方链接完成登录验证" })

  const checkStatus = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await json<{ status?: number }>(ctx, api("get-verify-status"))
        if (res.status === 1) return login()
        if (res.status !== 0) ctx.logger.warn("验证错误", res)
      } catch (error) {
        ctx.signal.throwIfAborted()
        ctx.logger.error("验证请求错误", error)
      }
      await wait(ctx, interval)
    }
    throw new Error("登录验证超时，请重新登录")
  }

  try {
    const res = await json<{ retcode?: number }>(ctx, api("query-bound-phone"))
    if (res.retcode === 0) {
      ctx.logger.info("存在设备信息缓存，开始登录验证")
      return checkStatus()
    }
  } catch (error) {
    ctx.signal.throwIfAborted()
    ctx.logger.warn("查询设备信息缓存失败", error)
  }

  let ticket: { ticket: string; randstr: string } | undefined
  for (let i = 0; i < 60 && ticket === undefined; i++) {
    try {
      const res = await json<{ status?: number; data?: { ticket?: string; randstr?: string } }>(ctx, api("get-ticket"))
      if (res.status === 0 && res.data?.ticket && res.data.randstr) {
        ticket = { ticket: res.data.ticket, randstr: res.data.randstr }
        break
      }
      if (res.status !== 1) ctx.logger.warn("ticket 错误", res)
    } catch (error) {
      ctx.signal.throwIfAborted()
      ctx.logger.error("ticket 请求错误", error)
    }
    await wait(ctx, interval)
  }
  if (ticket === undefined) throw new Error("ticket 验证超时，请重新登录")

  const sig = /sig=([^&]+)/.exec(decodeURIComponent(data.url))?.[1]
  if (!sig) ctx.logger.warn("sig 提取失败", data)
  const payload = {
    version,
    sig,
    ticket: ticket.ticket,
    randstr: ticket.randstr,
    guid: data.device?.guid,
    qimei: data.device?.qimei,
    appid: data.device?.subappid
  }
  ctx.logger.info("上传设备信息")

  for (let i = 0; i < 5; i++) {
    try {
      const res = await json<{ status?: number }>(ctx, api("upload-qqInfo"), payload)
      if (res.status === 0) {
        ctx.logger.info("设备信息上传成功，开始登录验证")
        return checkStatus()
      }
      ctx.logger.warn("设备信息错误", res)
    } catch (error) {
      ctx.signal.throwIfAborted()
      ctx.logger.error("设备信息上传错误", error)
    }
    await wait(ctx, interval)
  }
  throw new Error("设备信息上传超时，请重新登录")
}
