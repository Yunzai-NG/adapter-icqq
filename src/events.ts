import type { IncomingEvent, IncomingMessageEvent, UserInfo, MemberInfo, GroupInfo } from "@yunzai-ng/types"
import type { FriendInfo, MemberInfo as IcqqMember, GroupInfo as IcqqGroup, GroupMessage, PrivateMessage } from "icqq"
import { decode } from "./codec.js"
import { fileId } from "./media.js"

/**
 * 群消息 id，与 icqq 的 `genGroupMessageId` 字节一致
 *
 * 不从 icqq 导入：那会绕过 `loadSdk()` 的查找顺序，协议库放在 `Model/icqq` 时取到的是另一份，
 * 或者根本取不到。格式自 0.x 至今未变。
 * @param gid 群号
 * @param uid 发送者
 * @param seq 序号
 * @param rand 随机数
 * @param time 秒级时间
 * @param pktnum 分片数
 * @returns base64 消息 id
 */
export function genGroupMessageId(gid: number, uid: number, seq: number, rand: number, time: number, pktnum = 1): string {
  const buf = Buffer.allocUnsafe(21)
  buf.writeUInt32BE(gid)
  buf.writeUInt32BE(uid, 4)
  buf.writeInt32BE(seq & 0xffffffff, 8)
  buf.writeInt32BE(rand & 0xffffffff, 12)
  buf.writeUInt32BE(time, 16)
  buf.writeUInt8(pktnum > 1 ? pktnum : 1, 20)
  return buf.toString("base64")
}

/**
 * 私聊消息 id，与 icqq 的 `genDmMessageId` 字节一致
 * @param uid 对方 QQ 号
 * @param seq 序号
 * @param rand 随机数
 * @param time 秒级时间
 * @param flag 接收为 0，发送为 1
 * @returns base64 消息 id
 */
export function genDmMessageId(uid: number, seq: number, rand: number, time: number, flag = 0): string {
  const buf = Buffer.allocUnsafe(17)
  buf.writeUInt32BE(uid)
  buf.writeInt32BE(seq & 0xffffffff, 4)
  buf.writeInt32BE(rand & 0xffffffff, 8)
  buf.writeUInt32BE(time, 12)
  buf.writeUInt8(flag, 16)
  return buf.toString("base64")
}

/** 联系人资料。 */
export function userInfo(info: Partial<FriendInfo> & { user_id: number }): UserInfo {
  return { uid: String(info.user_id), name: info.nickname, remark: info.remark, avatar: `https://q1.qlogo.cn/g?b=qq&nk=${info.user_id}&s=640` }
}

/** 群成员资料。 */
export function memberInfo(info: IcqqMember): MemberInfo {
  return { ...userInfo(info), gid: String(info.group_id), card: info.card, role: info.role, title: info.title, joinTime: info.join_time, lastSentTime: info.last_sent_time, shutUpTime: info.shutup_time }
}

/** 群资料。 */
export function groupInfo(info: IcqqGroup): GroupInfo {
  return { gid: String(info.group_id), name: info.group_name, owner: String(info.owner_id), memberCount: info.member_count, maxMemberCount: info.max_member_count, avatar: `https://p.qlogo.cn/gh/${info.group_id}/${info.group_id}/640` }
}

/** 消息事件及引用摘要；无需逐条拉取被引用消息。 */
export function messageEvent(data: GroupMessage | PrivateMessage): IncomingMessageEvent {
  const group = data.message_type === "group"
  const sender: UserInfo | MemberInfo = group
    ? { ...userInfo(data.sender), gid: String(data.group_id), role: data.sender.role ?? "member", card: data.sender.card }
    : userInfo(data.sender)
  const event: IncomingMessageEvent = {
    kind: "message", scene: group ? "group" : "private", subType: data.sub_type,
    messageId: data.message_id, seq: data.seq, time: data.time * 1000,
    sender, message: decode(data.message), raw: data
  }
  if (group) event.group = { gid: String(data.group_id), name: data.group_name }
  else if (data.sender.group_id) event.group = { gid: String(data.sender.group_id) }
  for (const segment of event.message) if (segment.type === "file" && segment.file.kind === "id") {
    segment.file = { kind: "id", id: fileId(group ? "group" : "private", String(group ? data.group_id : data.sender.user_id), segment.file.id) }
  }
  if (data.source) {
    const source = data.source
    event.quote = {
      messageId: group
        ? genGroupMessageId(data.group_id, source.user_id, source.seq, source.rand, source.time)
        : genDmMessageId(data.from_id === data.user_id ? data.from_id : data.to_id, source.seq, source.rand, source.time),
      sender: { uid: String(source.user_id) }, time: source.time * 1000,
      message: decode((Array.isArray(source.message) ? source.message : [source.message]).map(item => typeof item === "string" ? { type: "text", text: item } : item))
    }
  }
  return event
}

/** 通知与申请转换；未覆盖的通知仍保留细分类型和原始报文。 */
export function otherEvent(data: Record<string, unknown>): IncomingEvent {
  const uid = data.user_id === undefined ? undefined : String(data.user_id)
  const gid = data.group_id === undefined ? undefined : String(data.group_id)
  const base = { raw: data, ...(typeof data.time === "number" ? { time: data.time * 1000 } : {}) }
  if (data.post_type === "request") return {
    ...base, kind: "request", requestType: data.request_type === "friend" ? "friend" : data.sub_type === "invite" ? "group.invite" : "group.add",
    uid: uid!, gid, flag: String(data.flag), comment: data.comment as string
  }
  const operatorId = data.operator_id === undefined ? undefined : String(data.operator_id)
  switch (data.sub_type) {
    case "increase": return gid
      ? { ...base, kind: "notice", noticeType: "group.increase", gid, uid: uid!, operatorId, way: "other" }
      : { ...base, kind: "notice", noticeType: "friend.add", uid, data }
    case "decrease": return gid
      ? { ...base, kind: "notice", noticeType: "group.decrease", gid, uid: uid!, operatorId, way: operatorId === uid ? "leave" : "kick" }
      : { ...base, kind: "notice", noticeType: "friend.remove", uid, data }
    case "recall": return { ...base, kind: "notice", noticeType: "message.recall", uid: uid!, gid, operatorId, messageId: String(data.message_id) }
    case "poke": return { ...base, kind: "notice", noticeType: "poke", uid: operatorId ?? uid!, gid, targetId: String(data.target_id) }
    case "admin": return { ...base, kind: "notice", noticeType: "group.admin", gid: gid!, uid: uid!, role: data.set ? "admin" : "member" }
    case "ban": return { ...base, kind: "notice", noticeType: "group.mute", gid: gid!, uid, operatorId, duration: Number(data.duration), whole: !Number(data.user_id) }
    default: return { ...base, kind: "notice", noticeType: `${data.notice_type}.${data.sub_type}`, gid, uid, data }
  }
}
