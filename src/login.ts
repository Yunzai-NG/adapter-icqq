import { setTimeout as delay } from "node:timers/promises"
import type { Client } from "icqq"
import type { LoginSession } from "@yunzai-ng/types"
import type { IcqqAccount } from "./config.js"
import { authVerify, sliderCode, sliderNT, sliderProxy, sliderWeb, waitTicket } from "./captcha.js"
import type { AuthChallenge, CaptchaContext, TicketSource } from "./captcha.js"

/** 验证辅助站点的覆盖项（测试用） */
export type CaptchaOptions = Pick<CaptchaContext, "endpoints" | "interval">

/** 等待上线；登录挑战、超时和取消均会回收监听器与轮询任务。 */
export function loginClient(client: Client, account: IcqqAccount, signal: AbortSignal, session?: LoginSession, options: CaptchaOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const listeners: Array<() => void> = []
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      controller.abort()
      for (const dispose of listeners) dispose()
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(signal.reason ?? new Error("登录已取消"))
    const timer = setTimeout(() => finish(new Error("ICQQ 登录超时，请通过面板重新登录")), account.loginTimeout * 1000)
    const on = (event: string, listener: (...args: never[]) => void) => {
      listeners.push(client.on(event, listener))
    }
    const challenge = <T>(event: string, work: (data: T) => Promise<void>) => {
      on(event, ((data: T) => {
        if (!session) { finish(new Error("需要交互验证，请在面板使用 ICQQ 登录")); return }
        void work(data).catch(error => { if (!controller.signal.aborted) finish(error) })
      }) as (...args: never[]) => void)
    }
    const check = () => controller.signal.throwIfAborted()
    on("system.online", () => finish())
    on("system.login.error", ((data: { message: string; code: number }) => finish(new Error(`ICQQ 登录失败：${data.message} (${data.code})`))) as (...args: never[]) => void)
    on("system.offline", () => finish(new Error("登录期间连接断开")))
    challenge<{ image: Uint8Array }>("system.login.qrcode", async data => {
      session!.push({ type: "qrcode", image: { kind: "buffer", data: data.image, mime: "image/png" }, text: "请用手机 QQ 扫码并确认登录" })
      while (true) {
        await delay(3000, undefined, { signal: controller.signal })
        const { retcode } = await client.queryQrcodeResult()
        check()
        if (retcode === 0) { await client.qrcodeLogin(); return }
        if (retcode === 17 || retcode === 54) throw new Error(retcode === 17 ? "二维码已过期" : "扫码已取消")
      }
    })
    const captcha = (): CaptchaContext => ({ uin: account.uin, signal: controller.signal, logger: session!.logger, push: step => session!.push(step), ...options })
    const nt = () => (client as Client & { /** 协议库是否走 NT 登录 */ useNTLogin?: boolean }).useNTLogin === true
    challenge<{ url: string }>("system.login.slider", async data => {
      let source: TicketSource
      if (nt()) source = await sliderNT(captcha(), data.url)
      else {
        session!.push({ type: "url", url: data.url, text: "收到滑动验证。Bot 与浏览器处于同一网络下推荐网页验证，否则网页反代" })
        const mode = await session!.ask({ type: "select", label: "滑动验证方式", timeout: `${account.loginTimeout}s`, options: [
          { value: "proxy", label: "网页反代验证" }, { value: "web", label: "网页验证" },
          { value: "code", label: "请求码验证" }, { value: "manual", label: "手动填写 ticket" }
        ] })
        check()
        if (mode === "proxy") source = sliderProxy(captcha(), data.url)
        else if (mode === "web") source = await sliderWeb(captcha(), data.url)
        else if (mode === "code") source = await sliderCode(captcha(), data.url)
        else {
          // 认不出的答复按 ticket 处理
          const ticket = mode === "manual" ? await session!.ask({ type: "text", label: "滑块 ticket", timeout: `${account.loginTimeout}s` }) : String(mode)
          check()
          if (!ticket.trim()) throw new Error("ticket 不能为空")
          await client.submitSlider(ticket.trim())
          return
        }
      }
      const ticket = await waitTicket(captcha(), source)
      check()
      await client.submitSlider(ticket)
    })
    challenge<{ url: string }>("system.login.device", async data => {
      if (nt()) {
        session!.push({ type: "url", url: data.url, text: "触发设备验证。请在 QQ 内点击下方链接完成验证，复制到浏览器无效" })
        const confirmed = await session!.ask<boolean>({ type: "confirm", label: "已完成验证，继续登录" })
        check()
        if (!confirmed) throw new Error("设备验证已取消")
        await client.login(Number(account.uin), account.password || undefined)
        return
      }
      session!.push({ type: "url", url: data.url, text: "请在手机 QQ 内完成设备验证，或选择短信验证" })
      const method = await session!.ask({ type: "select", label: "设备锁验证方式", options: [{ value: "continue", label: "已完成验证，继续登录" }, { value: "sms", label: "短信验证码" }] })
      check()
      if (method === "sms") {
        await client.sendSmsCode()
        check()
        const code = await session!.ask({ type: "code", label: "短信验证码" })
        check()
        await client.submitSmsCode(code)
      } else await client.login(Number(account.uin), account.password || undefined)
    })
    challenge<AuthChallenge>("system.login.auth", async data => {
      await authVerify(captcha(), data, client.apk.ver, async () => {
        check()
        await client.login(Number(account.uin), account.password || undefined)
      })
    })
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) { abort(); return }
    void client.login(Number(account.uin), account.password || undefined).catch(finish)
  })
}
