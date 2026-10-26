import type { MediaRef } from "@yunzai-ng/types"
import { mediaFile } from "./codec.js"

/** 为群文件上传下载 URL；限时、限大小，取消账号时终止请求。 */
export async function uploadFile(file: MediaRef, signal: AbortSignal): Promise<string | Buffer> {
  if (file.kind !== "url") return mediaFile(file)
  const response = await fetch(file.url, { headers: file.headers, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`文件下载失败：HTTP ${response.status}`) }
  const limit = 64 * 1024 * 1024
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new Error("远程文件超过 64 MiB，请下载到本地后上传")
  }
  if (!response.body) throw new Error("文件下载响应为空")
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new Error("远程文件超过 64 MiB，请下载到本地后上传")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

/** 文件 id 带上会话，后续才能调用对应的群/好友下载接口。 */
export function fileId(scene: "group" | "private", peer: string, id: string): string {
  return `icqq-file:${Buffer.from(JSON.stringify([scene, peer, id])).toString("base64url")}`
}

/** 解出适配器生成的文件标识，拒绝不完整或跨平台资源。 */
export function parseFileId(id: string): ["group" | "private", string, string] {
  if (!id.startsWith("icqq-file:")) throw new Error("资源 id 不含 ICQQ 会话信息")
  const value: unknown = JSON.parse(Buffer.from(id.slice(10), "base64url").toString())
  if (!Array.isArray(value) || value.length !== 3 || !["group", "private"].includes(value[0]) || typeof value[1] !== "string" || !/^\d+$/.test(value[1]) || typeof value[2] !== "string" || !value[2]) throw new Error("无效的 ICQQ 文件 id")
  return value as ["group" | "private", string, string]
}
