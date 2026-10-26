import { s, SchemaError } from "@yunzai-ng/core"
import type { Infer } from "@yunzai-ng/core"

/** 面板中的 ICQQ 账号表单。 */
export const ACCOUNT_SCHEMA = s.object({
  uin: s.string().default("").title("QQ 号"),
  password: s.password().default("").title("密码").desc("留空使用本地登录凭据或扫码；扫码请选择安卓手表"),
  platform: s.number().int().min(1).max(6).default(3).title("登录设备").desc("1 安卓手机、2 平板、3 手表、4 iMac、5 iPad、6 TIM"),
  ver: s.string().default("").title("协议版本").desc("留空使用设备默认版本"),
  signApiAddr: s.string().default("").title("签名服务器地址"),
  dataDir: s.string().default("data/icqq").title("登录数据目录").desc("每个 QQ 号独立存储设备信息和登录凭据"),
  ignoreSelf: s.boolean().default(true).title("忽略自己的消息"),
  cacheGroupMember: s.boolean().default(false).title("ICQQ 缓存完整群成员列表"),
  loginTimeout: s.number().int().min(10).max(1800).default(180).title("登录超时（秒）")
})

/** 持久化的账号配置。 */
export type IcqqAccount = Infer<typeof ACCOUNT_SCHEMA>

/** 校验 QQ 号、设备与签名服务器配置。 */
export function validateAccount(input: unknown): IcqqAccount {
  const value = ACCOUNT_SCHEMA.parse(input)
  value.uin = value.uin.trim()
  value.ver = value.ver.trim()
  value.signApiAddr = value.signApiAddr.trim()
  value.dataDir = value.dataDir.trim()
  const fail = (path: string, message: string): never => { throw new SchemaError([{ path, message, severity: "error" }]) }
  if (!/^[1-9]\d{4,10}$/.test(value.uin) || !Number.isSafeInteger(Number(value.uin))) fail("uin", "请输入有效 QQ 号")
  if (!value.dataDir) fail("dataDir", "登录数据目录不能为空")
  if (value.signApiAddr) {
    try {
      const url = new URL(value.signApiAddr)
      if (!["http:", "https:"].includes(url.protocol)) fail("signApiAddr", "签名地址必须使用 HTTP 或 HTTPS")
    } catch { fail("signApiAddr", "请输入有效的 HTTP / HTTPS 签名地址") }
  }
  return value
}
