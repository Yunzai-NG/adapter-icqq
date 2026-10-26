import { readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Client } from "icqq"
import type { Logger } from "@yunzai-ng/types"
import type { IcqqAccount } from "./config.js"

/** 插件根目录 */
const ROOT = resolve(import.meta.dirname, "..")

/**
 * 协议库的查找位置，依次尝试
 *
 * `Model/icqq` 放手动解压的协议库，`node_modules/icqq` 是包管理器装的
 * （含 `pnpm add icqq@npm:@icqqjs/icqq` 这种别名安装）。
 */
export const SDK_DIRS = [resolve(ROOT, "Model", "icqq"), resolve(ROOT, "node_modules", "icqq")]

/** 已装载的协议库 */
export interface LoadedSdk {
  /** 协议库入口导出 */
  sdk: typeof import("icqq")
  /** 版本号 */
  version: string
  /** 所在目录 */
  dir: string
  /** 是否打了 vendor 补丁（仅 0.x） */
  patched: boolean
}

let initialized: Promise<LoadedSdk> | undefined

/**
 * 从一个目录装载协议库
 * @param dir 协议库目录
 * @returns 装载结果
 */
async function loadFrom(dir: string): Promise<LoadedSdk> {
  const pkg = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8")) as { version?: string; main?: string }
  const version = String(pkg.version ?? "")
  // 按目录建 require：Model/icqq 不在插件的 node_modules 里，裸包名解析不到它
  const require = createRequire(resolve(dir, "package.json"))
  const entry = resolve(dir, pkg.main ?? "lib/index.js")
  const sdk = require(entry) as typeof import("icqq")
  // 1.x 自带新版协议表与解析器，补丁只给 0.x 打
  if (!version.startsWith("0")) return { sdk, version, dir, patched: false }

  const lib = dirname(entry)
  const vendor = (name: string) => import(pathToFileURL(resolve(ROOT, "vendor", `${name}.js`)).href)
  const device = require(resolve(lib, "core/device.js"))
  device.getApkInfoList = (await vendor("device")).getApkInfoList
  const parser = require(resolve(lib, "message/parser.js"))
  Object.assign(parser, await vendor("parser"))
  Object.assign(parser.Parser.prototype, {
    core: sdk.core,
    face: require(resolve(lib, "message/face.js")),
    image: require(resolve(lib, "message/image.js"))
  })
  return { sdk, version, dir, patched: true }
}

/**
 * 装载协议库，按 `SDK_DIRS` 的顺序取第一个能用的
 * @param dirs 查找位置（测试用）
 * @returns 装载结果
 * @throws 所有位置都装载失败时，带上最后一个错误
 */
export function loadSdk(dirs: readonly string[] = SDK_DIRS): Promise<LoadedSdk> {
  initialized ??= (async () => {
    let last: unknown
    for (const dir of dirs) {
      try {
        await stat(dir)
      } catch {
        continue
      }
      try {
        return await loadFrom(dir)
      } catch (error) {
        last = error
      }
    }
    throw new Error(
      `找不到可用的 icqq 协议库（查找了 ${dirs.join("、")}）。请在插件目录执行 pnpm install --ignore-workspace`,
      { cause: last }
    )
  })()
  // 失败不缓存：装好协议库后重载插件即可重试，不必重启进程
  initialized.catch(() => (initialized = undefined))
  return initialized
}

/** 清空装载缓存（测试用） */
export function resetSdk(): void {
  initialized = undefined
}

/** 创建客户端，重连统一交给内核。 */
export async function createClient(account: IcqqAccount): Promise<Client> {
  const { sdk } = await loadSdk()
  return sdk.createClient({
    platform: account.platform,
    ...(account.ver ? { ver: account.ver } : {}),
    sign_api_addr: account.signApiAddr,
    data_dir: resolve(account.dataDir, account.uin),
    ignore_self: account.ignoreSelf,
    cache_group_member: account.cacheGroupMember,
    reconn_interval: 0
  })
}

/**
 * 上线后从签名服务器取需要签名的命令表
 *
 * 0.6.10 的 `getCmdWhiteList()` 固定返回空数组，不补这一步时只签内置的几条命令。
 * 不阻塞上线，取不到只记 debug。
 * @param client 已上线的客户端
 * @param signApiAddr 签名服务器地址；空串时跳过
 * @param logger 日志器
 */
export async function updateCmdWhitelist(
  client: Client,
  signApiAddr: string,
  logger: Pick<Logger, "debug">
): Promise<void> {
  if (!signApiAddr) return
  try {
    const url = new URL(signApiAddr)
    if (!url.pathname.endsWith("/")) url.pathname += "/"
    url.pathname += "cmd_whitelist"
    url.searchParams.set("ver", client.apk.ver)
    url.searchParams.set("fekit_ver", String((client.apk as { /** 签名所需的 fekit 版本 */ fekit_ver?: string }).fekit_ver ?? ""))
    url.searchParams.set("uin", String(client.uin ?? 0))
    const res = (await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json()) as { data?: { list?: string[] } }
    const list = res.data?.list
    if (Array.isArray(list) && list.length > 0) {
      ;(client as unknown as { /** 需要签名的命令 */ signCmd: string[] }).signCmd = list
      logger.debug("cmd_whitelist 已更新", list)
    }
  } catch (error) {
    logger.debug("cmd_whitelist 获取失败", error)
  }
}

/** 关闭客户端并清理旧协议库不受 reconn_interval 控制的 token 重试。 */
export function disposeClient(client: Client): void {
  const internal = client as Client & { /** 旧版 ICQQ 的登录重试定时器。 */ login_timer?: ReturnType<typeof setTimeout> | null }
  if (internal.login_timer) clearTimeout(internal.login_timer)
  internal.login_timer = null
  // 0.6.x 在 token 过期、二维码错误时会独立重试，停用账号后必须阻止它重建连接。
  for (const event of ["internal.error.token", "internal.error.login", "internal.error.qrcode", "internal.error.network"]) client.off(event)
  client.terminate()
}
