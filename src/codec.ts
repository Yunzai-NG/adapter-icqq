import type { MediaRef, MessageContent, Segment } from "@yunzai-ng/types"
import type { MessageElem, Sendable } from "icqq"

/** 转为 ICQQ 可直接消费的媒体来源，保留 URL 请求头。 */
export function mediaFile(file: MediaRef): string | Buffer {
  switch (file.kind) {
    case "url": return file.url
    case "path": return file.path
    case "id": return file.id
    case "buffer": return Buffer.from(file.data)
    case "base64": return Buffer.from(file.base64, "base64")
  }
}

/** 展平宽松输入，不改写调用方的消息段。 */
export function flatten(content: MessageContent): Segment[] {
  if (Array.isArray(content)) return content.flatMap(item => flatten(item))
  if (content === undefined || content === null || content === false) return []
  if (typeof content === "string" || typeof content === "number") return [{ type: "text", text: String(content) }]
  return [content as Segment]
}

/** 编码消息段；文件、引用和转发由发送层处理。 */
export function encode(segments: Segment[]): Sendable {
  return segments.map(segment => {
    switch (segment.type) {
      case "at": return { type: "at", qq: Number(segment.uid), text: segment.name }
      case "atAll": return { type: "at", qq: "all" }
      case "image": case "record": case "video": return { ...segment, file: mediaFile(segment.file), ...(segment.file.kind === "url" ? { headers: segment.file.headers } : {}) }
      case "dice": case "rps": return { type: segment.type, id: segment.result }
      case "contact": return { type: "xml", data: `<msg serviceID="${segment.scene === "group" ? 15 : 14}" templateID="-1" action="web" brief="推荐${segment.scene === "group" ? "群" : "好友"}"><item layout="0"><title>${segment.id.replace(/[<>&"']/g, "")}</title></item><source name="推荐" action="${segment.scene === "group" ? "group" : "plugin"}" actionData="${segment.id.replace(/\D/g, "")}" /></msg>` }
      case "location": return { type: "location", lat: segment.lat, lng: segment.lon, name: segment.title, address: segment.content ?? segment.title ?? "" }
      case "poke": return { type: "poke", id: segment.pokeType ?? 0 }
      case "markdown": return { type: "markdown", content: segment.content }
      case "keyboard": return { type: "button", content: { rows: segment.rows.map(row => ({ buttons: row.map(button => ({
        id: button.id,
        render_data: { label: button.label, visited_label: button.visitedLabel ?? button.label, style: 1 },
        action: { type: button.action === "link" ? 0 : 2, permission: { type: 2 }, data: button.data, enter: button.enter }
      })) })) } }
      case "raw":
        if (segment.platform !== "icqq") throw new Error(`不能发送来自 ${segment.platform} 的私有消息段`)
        return segment.data
      case "reply": case "forward": case "file": throw new Error(`${segment.type} 必须由发送层处理`)
      case "music": return { type: "json", data: JSON.stringify({ app: "com.tencent.structmsg", view: "music", ver: "0.0.0.1", prompt: `[分享]${segment.title ?? "音乐"}`, meta: { music: { title: segment.title, desc: segment.singer, jumpUrl: segment.url, musicUrl: segment.audio, preview: segment.image } }, config: { type: "normal", autosize: true, forward: true } }) }
      default: return { ...segment }
    }
  }) as Sendable
}

/** 将 ICQQ 接收段转换为通用模型，未知类型保留原始数据。 */
export function decode(elements: readonly MessageElem[]): Segment[] {
  return elements.map(element => {
    const item = element as unknown as Record<string, unknown>
    switch (item.type) {
      case "text": return { type: "text", text: String(item.text ?? "") }
      case "at": return item.qq === "all" ? { type: "atAll" } : { type: "at", uid: String(item.qq), name: item.text as string }
      case "face": return { type: "face", id: Number(item.id), big: item.big as boolean }
      case "image": case "record": case "video": {
        const value = String(item.url || item.file || "")
        return { ...item, type: item.type, file: /^https?:\/\//.test(value) ? { kind: "url", url: value } : { kind: "id", id: value } } as Segment
      }
      case "file": return { type: "file", name: String(item.name ?? ""), size: item.size as number, file: { kind: "id", id: String(item.fid) } }
      case "dice": case "rps": return { type: item.type, result: Number(item.id) }
      case "json": case "xml": return { type: item.type, data: String(item.data) }
      case "markdown": return { type: "markdown", content: String(item.content ?? "") }
      default: return { type: "raw", platform: "icqq", platformType: String(item.type), data: element }
    }
  })
}
