import type { Client, GroupMessage, PrivateMessage, MessageRet, Forwardable } from "icqq"
import type { AdapterHost, BotDriver, BotCapability, SendTarget, MessageContent, SendOptions, SendResult, MemberListOptions, ForwardNode } from "@yunzai-ng/types"
import type { IcqqAccount } from "./config.js"
import { createClient, disposeClient, updateCmdWhitelist } from "./sdk.js"
import { loginClient } from "./login.js"
import { encode, flatten } from "./codec.js"
import { uploadFile, parseFileId } from "./media.js"
import { userInfo, memberInfo, groupInfo, messageEvent, otherEvent } from "./events.js"

/** 将协议返回统一成毫秒时间戳和字符串消息 id。 */
function result(raw: MessageRet): SendResult {
  return { ok: true, messageId: raw.message_id, time: raw.time * 1000, raw }
}

/** 创建单账号驱动；可注入协议客户端以离线测试生命周期。 */
export async function createIcqqBot(account: IcqqAccount, host: AdapterHost, injected?: Client): Promise<BotDriver> {
  const client = injected ?? await createClient(account)
  client.logger = {
    trace: (...args) => host.logger.trace(args), debug: (...args) => host.logger.debug(args),
    info: (...args) => host.logger.info(args), mark: (...args) => host.logger.mark(args),
    warn: (...args) => host.logger.warn(args), error: (...args) => host.logger.error(args),
    fatal: (...args) => host.logger.fatal(args), off: () => {}
  }
  const members = host.createCache<ReturnType<typeof memberInfo>>({ max: 2000, ttl: "5m" })
  const controller = new AbortController()
  let connected = false
  let disposed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const listeners: Array<() => void> = []
  let connecting: Promise<void> | undefined
  const on = (event: string, listener: (...args: never[]) => void) => {
    listeners.push(client.on(event, listener))
  }
  const submit = (event: Parameters<AdapterHost["submit"]>[0]) => {
    if (connected && !disposed && !host.signal.aborted) host.submit(event)
  }
  const pick = (target: SendTarget) => {
    if (target.scene === "guild") throw new Error("ICQQ 适配器暂不支持频道")
    if (target.scene === "group") return client.pickGroup(Number(target.gid))
    return target.gid ? client.pickMember(Number(target.gid), Number(target.uid)) : client.pickFriend(Number(target.uid))
  }
  const checked = async (operation: Promise<unknown>) => {
    if (await operation === false) throw new Error("ICQQ 拒绝了操作")
  }
  const disconnect = async () => {
    if (disposed) return
    disposed = true
    connected = false
    controller.abort(new Error("ICQQ 账号已断开"))
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const dispose of listeners) dispose()
    listeners.length = 0
    host.signal.removeEventListener("abort", abort)
    members.clear()
    // terminate 保留 token 和设备文件，不发 logout 使已保存的凭据失效。
    disposeClient(client)
  }
  const abort = () => { void disconnect() }
  host.signal.addEventListener("abort", abort, { once: true })
  host.onDispose(disconnect)

  on("message", ((data: GroupMessage | PrivateMessage) => {
    if (data.message_type !== "private" && data.message_type !== "group") return
    submit(messageEvent(data))
  }) as (...args: never[]) => void)
  for (const event of ["notice", "request"]) on(event, ((data: Record<string, unknown>) => {
    if (data.group_id !== undefined && data.user_id !== undefined) members.delete(`${data.group_id}:${data.user_id}`)
    submit(otherEvent(data))
  }) as (...args: never[]) => void)
  on("system.offline", ((data: { message?: string }) => {
    if (!connected || disposed) return
    connected = false
    host.setStatus("offline", { error: data.message ?? "ICQQ 连接已断开" })
  }) as (...args: never[]) => void)

  const caps = new Set<BotCapability>(["recall", "forward", "poke", "groupFile", "groupCard", "groupMute", "groupKick", "groupWholeMute", "groupAdmin", "groupName", "groupSign", "friendRequest", "groupRequest", "fetchHistory", "getFileUrl", "markdown", "keyboard"])
  const driver: BotDriver = {
    get selfId() { return String(client.uin || account.uin) },
    platform: "icqq", adapterId: "icqq",
    get nickname() { return client.nickname ?? "" },
    get online() { return connected && !disposed && client.isOnline() },
    caps,
    connect() {
      if (disposed) return Promise.reject(new Error("驱动已释放，请创建新实例"))
      if (connected) return Promise.resolve()
      return connecting ??= loginClient(client, account, controller.signal).then(() => {
        controller.signal.throwIfAborted()
        if (String(client.uin) !== account.uin) throw new Error("实际登录账号与配置的 QQ 号不一致")
        connected = true
        void updateCmdWhitelist(client, account.signApiAddr, host.logger)
        host.setStatus("online", { nickname: client.nickname })
        submit({ kind: "meta", metaType: "connect" })
      }).catch(async error => { await disconnect(); throw error })
    },
    disconnect,
    async sendMessage(target: SendTarget, content: MessageContent, options?: SendOptions) {
      if (!driver.online) throw new Error("ICQQ 账号未在线")
      const peer = pick(target)
      const segments = flatten(content)
      const quoteId = options?.quote ?? segments.find(item => item.type === "reply")?.messageId
      const quote = quoteId ? await client.getMsg(quoteId) : undefined
      if (quoteId && !quote) throw new Error("无法取得被引用的消息")
      const receipts: SendResult[] = []
      let pending: typeof segments = []
      const flush = async () => {
        if (!pending.length) return
        receipts.push(result(await peer.sendMsg(encode(pending), quote)))
        pending = []
      }
      for (const item of segments) {
        if (item.type === "reply") continue
        if (item.type === "file") {
          await flush()
          const fileRef = item.file.kind === "id" ? { kind: "url" as const, url: await driver.getFileUrl!(item.file.id) } : item.file
          const file = await uploadFile(fileRef, controller.signal)
          if (target.scene === "group") await client.pickGroup(Number(target.gid)).sendFile(file, "/", item.name)
          else if (target.scene === "private" && !target.gid) await client.pickFriend(Number(target.uid)).sendFile(file, item.name)
          else throw new Error("临时会话不支持文件上传")
          receipts.push({ ok: true, messageId: "", time: Date.now() })
        } else if (item.type === "share" || (item.type === "music" && item.platform !== "custom")) {
          await flush()
          if (item.type === "share") await peer.shareUrl(item)
          else {
            if (!item.id) throw new Error("音乐分享需要歌曲 id")
            if (item.platform === "custom") throw new Error("自定义音乐应以卡片发送")
            await peer.shareMusic(item.platform, item.id)
          }
          receipts.push({ ok: true, messageId: "", time: Date.now() })
        } else if (item.type === "forward") {
          await flush()
          if (!item.nodes?.length) throw new Error("发送合并转发需要提供 nodes")
          receipts.push(await driver.sendForward!(target, item.nodes))
        } else pending.push(item)
      }
      await flush()
      if (!receipts.length) throw new Error("消息内容为空")
      if (options?.recallAfter && options.recallAfter > 0) for (const receipt of receipts) {
        if (!receipt.messageId) continue
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!disposed) void client.deleteMsg(receipt.messageId).catch(error => host.logger.warn("自动撤回失败", error))
        }, options.recallAfter)
        timer.unref()
        timers.add(timer)
      }
      return receipts.length === 1 ? receipts[0]! : { ...receipts[receipts.length - 1]!, raw: receipts }
    },
    async recallMessage(id) { return client.deleteMsg(id) },
    async getSelfInfo() { return { uid: driver.selfId, name: driver.nickname, avatar: client.pickUser(Number(driver.selfId)).getAvatarUrl() } },
    async getFriend(uid) { const info = client.fl.get(Number(uid)); return info ? userInfo(info) : undefined },
    async getFriendList() { return [...client.fl.values()].map(userInfo) },
    async getGroup(gid) { const info = client.gl.get(Number(gid)); return info ? groupInfo(info) : undefined },
    async getGroupList() { return [...client.gl.values()].map(groupInfo) },
    async getGroupMember(gid, uid) {
      return members.fetch(`${gid}:${uid}`, async () => {
        const info = await client.pickMember(Number(gid), Number(uid)).renew()
        return info ? memberInfo(info) : undefined
      })
    },
    async getGroupMemberList(gid: string, options?: MemberListOptions) {
      const map = await client.pickGroup(Number(gid)).getMemberMap(options?.refresh)
      const list = []
      for (const info of map.values()) {
        if (options?.limit !== undefined && list.length >= options.limit) break
        const member = memberInfo(info)
        members.set(`${gid}:${member.uid}`, member)
        list.push(member)
      }
      return list
    },
    async sendForward(target: SendTarget, nodes: ForwardNode[]) {
      const peer = pick(target)
      const forward: Forwardable[] = []
      for (const node of nodes) {
        if (node.messageId) {
          const message = await client.getMsg(node.messageId)
          if (!message) throw new Error(`转发消息不存在：${node.messageId}`)
          forward.push(message)
        } else forward.push({ user_id: Number(node.uid ?? driver.selfId), nickname: node.name ?? driver.nickname, time: node.time, message: encode(node.message ?? []) })
      }
      return result(await peer.sendMsg(await peer.makeForwardMsg(forward)))
    },
    async setGroupCard(gid, uid, card) { await checked(client.pickMember(Number(gid), Number(uid)).setCard(card)); members.delete(`${gid}:${uid}`) },
    async muteGroupMember(gid, uid, seconds) { await client.pickMember(Number(gid), Number(uid)).mute(seconds); members.delete(`${gid}:${uid}`) },
    async muteGroupAll(gid, enable) { await checked(client.pickGroup(Number(gid)).muteAll(enable)) },
    async kickGroupMember(gid, uid, reject) { await checked(client.setGroupKick(Number(gid), Number(uid), reject)); members.delete(`${gid}:${uid}`) },
    async quitGroup(gid) { await checked(client.pickGroup(Number(gid)).quit()) },
    async handleFriendRequest(flag, approve, remark) { await checked(client.setFriendAddRequest(flag, approve, remark)) },
    async handleGroupRequest(flag, approve, reason) { await checked(client.setGroupAddRequest(flag, approve, reason)) },
    async uploadGroupFile(gid, file, name, folder) { await client.pickGroup(Number(gid)).sendFile(file, folder ?? "/", name) },
    async getFileUrl(id) {
      const [scene, peer, resource] = parseFileId(id)
      const url = scene === "group" ? await client.pickGroup(Number(peer)).getFileUrl(resource) : await client.pickUser(Number(peer)).getFileUrl(resource)
      if (!url) throw new Error("ICQQ 未返回文件下载地址")
      return url
    },
    async fetchHistory(target, count, before) {
      const message = before ? await client.getMsg(before) : undefined
      const peer = pick(target)
      const history = await peer.getChatHistory(target.scene === "group" ? message?.seq : message?.time, Math.max(1, Math.min(100, count)))
      return history.map(data => {
        const event = messageEvent(data)
        return { messageId: event.messageId, time: event.time!, sender: event.sender, message: event.message, group: event.group }
      }).sort((a, b) => a.time - b.time)
    },
    async getMessage(id) {
      const data = await client.getMsg(id)
      if (!data) return undefined
      const event = messageEvent(data)
      return { messageId: event.messageId, time: event.time!, sender: event.sender, message: event.message, group: event.group }
    },
    async callApi<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
      // 常见的 OneBot 风格调用，供按 OneBot 写的 QQ 插件复用。
      switch (action) {
        case "set_group_admin": return await client.pickMember(Number(params.group_id), Number(params.user_id)).setAdmin(params.enable !== false) as T
        case "set_group_name": return await client.pickGroup(Number(params.group_id)).setName(String(params.group_name)) as T
        case "send_group_sign": return await client.sendGroupSign(Number(params.group_id)) as T
        case "send_group_poke": return await client.sendGroupPoke(Number(params.group_id), Number(params.user_id)) as T
      }
      // 参数显式用 args 数组，避免依赖对象属性顺序，也禁止读取任意属性。
      const allowed = new Set(["sendUni", "sendOidb", "getSystemMsg", "getStatus", "setOnlineStatus", "setNickname", "sendLike", "sendGroupSign", "sendGroupPoke", "setGroupAdmin", "setGroupName", "getForwardMsg"])
      if (!allowed.has(action)) throw new Error(`不支持的 ICQQ API：${action}`)
      const method = (client as unknown as Record<string, unknown>)[action]
      if (typeof method !== "function") throw new Error(`当前协议库不支持 ${action}`)
      if (params.args !== undefined && !Array.isArray(params.args)) throw new Error("args 必须是数组")
      return await Reflect.apply(method, client, params.args ?? []) as T
    }
  }
  if (host.signal.aborted) await disconnect()
  return driver
}
