import { definePlugin } from "@yunzai-ng/core"
import type { AdapterProvider, PluginDefinition } from "@yunzai-ng/types"
import { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
import { createIcqqBot } from "./bot.js"
import { createClient, disposeClient, loadSdk } from "./sdk.js"
import { loginClient } from "./login.js"

export { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
export type { IcqqAccount } from "./config.js"
export { createIcqqBot } from "./bot.js"

const definition: PluginDefinition<Record<string, never>> = definePlugin({
  name: "adapter-icqq", version: "0.1.0", priority: 10,
  description: "ICQQ 直连 QQ，支持面板扫码、密码登录及设备验证",
  async setup(ctx) {
    // 协议库在加载时就装好，装不上则插件加载失败，面板上能看到原因
    const loaded = await loadSdk()
    ctx.logger.info(`icqq v${loaded.version}（${loaded.dir}）${loaded.patched ? "，已应用补丁" : ""}`)
    const provider: AdapterProvider<ReturnType<typeof validateAccount>> = {
      id: "icqq", name: "ICQQ", platform: "icqq",
      description: "使用 ICQQ 协议库直连 QQ；账号、签名与设备信息在面板管理",
      accountSchema: ACCOUNT_SCHEMA.describe(), validateAccount,
      loginModes: [{ id: "qrcode", name: "扫码登录" }, { id: "password", name: "密码登录" }],
      createBot: createIcqqBot,
      async login(session, mode) {
        if (mode !== "qrcode" && mode !== "password") throw new Error("不支持的登录方式")
        const uin = await session.ask({ type: "text", label: "QQ 号" })
        const password = mode === "password" ? await session.ask({ type: "password", label: "QQ 密码" }) : ""
        const platform = mode === "qrcode" ? "3" : await session.ask({ type: "select", label: "登录设备", options: [{ value: "1", label: "安卓手机" }, { value: "2", label: "安卓平板" }, { value: "3", label: "安卓手表" }, { value: "6", label: "TIM" }] })
        const signApiAddr = await session.ask({ type: "text", label: "签名服务器地址（可留空）" })
        const ver = await session.ask({ type: "text", label: "协议版本（留空使用默认）" })
        const account = validateAccount({ uin, password, platform: Number(platform), signApiAddr, ver })
        const client = await createClient(account)
        try {
          await loginClient(client, account, session.signal, session)
          if (String(client.uin) !== account.uin) throw new Error("扫码账号与填写的 QQ 号不一致，请重新登录")
          session.push({ type: "info", text: `登录成功：${client.nickname}（${client.uin}）` })
          return account
        } finally { disposeClient(client) }
      }
    }
    ctx.registerAdapter(provider as unknown as AdapterProvider)
    ctx.command(/^#[Qq]+账号$/, { desc: "ICQQ 账号状态", master: true }).action(async event => {
      const accounts = ctx.app.accounts.list().filter(state => state.record.adapterId === "icqq")
      await event.reply(accounts.length ? accounts.map(state => `${state.nickname ?? state.record.label ?? state.record.config.uin}：${state.status}`).join("\n") : "尚未配置 ICQQ 账号，请在面板的账号页面添加")
    })
    ctx.command(/^#[Qq]+(设置|签名).*$/, { desc: "ICQQ 面板管理指引", master: true, hidden: true }).action(async event => {
      await event.reply("请在面板 → 账号中添加 ICQQ 账号或修改签名服务器；需要验证时使用面板的交互登录")
    })
  }
})

export default definition
