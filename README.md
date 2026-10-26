# adapter-icqq

Yunzai NG 的 ICQQ 适配器：用 [icqq](https://github.com/icqqjs/icqq) 协议库直连 QQ，不需要另起
NapCat 之类的客户端。登录在面板里完成（扫码或密码），滑块、设备锁验证也在面板里交互。

对 icqq 0.x 打了两处补丁（协议版本表、NT 消息解析），登录与账号由内核统一管理。

## 安装

克隆或复制到主目录的 `plugins/` 下，装依赖并编译：

```powershell
cd <主目录>\plugins\adapter-icqq
pnpm install --ignore-workspace
pnpm run build
```

然后在面板的插件页重载，或重启内核。`dist/` 不进 git，不编译就没有入口。

缺省依赖 `icqq@0.6.10`。npm 上该版本已标记为 deprecated，但仍可安装。

### 自行安装协议库

可以换成别的协议库。插件按顺序找第一个能装载的：

1. `Model/icqq/`：手动解压的协议库，整个目录放进去即可（已在 `.gitignore` 中）
2. `node_modules/icqq/`：包管理器装的

换用新版协议库 `@icqqjs/icqq`（NT 登录在这个版本里）：

```powershell
cd <主目录>\plugins\adapter-icqq
pnpm login --scope=@icqqjs --auth-type=legacy --registry=https://npm.pkg.github.com
# UserName：GitHub 账号
# Password：到 https://github.com/settings/tokens/new 生成，scopes 勾选 read:packages
# E-Mail：公开邮箱
pnpm add icqq@npm:@icqqjs/icqq --ignore-workspace
```

## 添加账号

面板 → 账号 → 添加账号 → 适配器选「ICQQ」，然后选登录方式：

- **扫码登录**：固定用安卓手表协议（本库里只有手表协议支持扫码）。面板显示二维码，用手机 QQ 扫码确认。
- **密码登录**：可选安卓手机、安卓平板、安卓手表、TIM。注意「安卓手机」会把手机上的 QQ 挤下线，
  与手机同时在线请选平板或手表。

两种方式都会询问签名服务器地址和协议版本，留空即可用默认值。不少协议版本没有签名服务器就登不上，
签名服务器需要自行部署。

登录中可能遇到的验证：

| 验证 | 面板上的操作 |
|---|---|
| 滑块 | 选一种方式，见下表 |
| 滑块（NT 登录） | 自动打开 `CapNT.928100.xyz` 验证页，完成后自动取回 ticket |
| 设备锁 | 选「短信验证码」收短信填回；或在手机 QQ 内完成验证后选「已完成验证，继续登录」 |
| 设备锁（NT 登录） | 在 QQ 内打开给出的链接完成验证（复制到浏览器无效），再点确认 |
| 登录验证（NT 登录） | 打开 `Auth.928100.xyz` 完成验证，其余自动进行 |

滑块的四种方式：

| 方式 | 做法 |
|---|---|
| 网页反代 | Bot 与浏览器不在同一网络时用。验证请求经本机发出 |
| 网页 | Bot 与浏览器在同一网络时推荐。打开给出的链接完成滑块即可 |
| 请求码 | 面板显示一段请求码，按辅助站点的说明完成 |
| 手动 | 打开滑块链接，从浏览器开发者工具的网络请求里取出 `ticket` 填回 |

也可以不走交互登录，直接在账号表单里填写字段。字段说明：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `uin` | — | QQ 号 |
| `password` | 空 | 密码。留空时只能用已有 token 登录；没有 token 时会要求扫码，后台连接做不了 |
| `platform` | `3` | 1 安卓手机、2 平板、3 手表、4 iMac、5 iPad、6 TIM |
| `ver` | 空 | 协议版本，留空用该设备的最新版本 |
| `signApiAddr` | 空 | 签名服务器地址，每个账号单独设置 |
| `dataDir` | `data/icqq` | 设备文件与 token 的存放目录，每个 QQ 号一个子目录 |
| `ignoreSelf` | `true` | 是否忽略自己发出的消息 |
| `cacheGroupMember` | `false` | 让 icqq 上线时拉全部群成员表；千人群多时很占内存 |
| `loginTimeout` | `180` | 单次登录最长等待秒数 |

### 登录数据目录

`<dataDir>/<QQ号>/` 下的 `device.json` 与 `<QQ号>_token` 就是这个账号的登录凭据，**不要删、不要
提交到版本库、不要发给别人**。删掉 `device.json` 相当于换一台新设备，大概率重新触发验证。

相对路径按**内核进程的当前目录**解析，而不是按主目录。用服务、开机自启或 pm2 启动时当前目录可能
不是主目录，此时请把 `dataDir` 改成绝对路径。

从 TRSS-Yunzai 迁移：把旧实例的 `data/icqq/<QQ号>/` 整个复制到新的 `dataDir` 下，保持设备
与协议不变（`platform` 与原来一致），通常可以直接用旧 token 登录，不必重新验证。

### 掉线与重连

掉线后由内核退避重连（全局 `adapter.reconnectLimit` 缺省 5 次，也可在账号上单独设置），icqq
自己的重连已关闭。后台重连时如果 QQ 要求扫码、滑块或设备锁，这次连接会直接失败并提示「需要交互
验证」。内核会继续重试到上限，之后停在离线状态，此时请在面板重新走一遍交互登录。

填了密码的账号，每次重试都是一次真实的密码登录。短时间内反复失败容易触发风控，遇到连续要求
验证时，建议先停用账号，验证完再启用。

账号已存在时，再走交互登录会**另建一条同 QQ 号的账号记录**。两条记录会互相挤下线，请删掉
旧的那条或停用其中一条。

## 使用

- **id 即 QQ 号与群号**，不加前缀。`bot.masterQQ` 里直接填 QQ 号。
- **消息 id** 是 icqq 生成的 base64 字符串，可直接用于撤回、引用与 `getMessage()`。
- **引用回复。** 发送时会先按消息 id 取回原消息（`getMsg`），取不到会报错「无法取得被引用的消息」。
  一条消息里夹着文件、分享或合并转发时会拆成几次发送，其中每段文字都带引用。
- **文件。** 收到的文件段是 `kind: "id"`，id 里带着会话信息，用 `bot.getFileUrl(id)` 换下载地址。
  发送远程文件时由本机下载再上传（带请求头，限 60 秒、64 MiB），更大的文件请给本地路径。
  群临时会话不能发文件。
- **合并转发** 走 icqq 的 `makeForwardMsg`，节点里可以直接引用已有消息 id。
- **分享与音乐。** 链接分享与平台歌曲（`qq` / `163` / `kugou` / `kuwo` / `migu`）各自单独发出，
  返回的消息 id 为空串。自定义音乐编码为 JSON 卡片。
- **平台私有段。** `seg.raw("icqq", type, elem)` 原样透传一个 icqq 消息元素；收到的未知元素
  （闪照、商城表情、长消息等）也以 `raw` 段给出。
- **原生 API。** `bot.callApi` 接受两种写法：

  ```ts
  await bot.callApi("send_group_sign", { group_id: 123456 })   // OneBot 风格命名参数
  await bot.callApi("sendLike", { args: [10001, 10] })          // icqq 方法名 + 参数数组
  ```

  命名参数形式支持 `set_group_admin`、`set_group_name`、`send_group_sign`、`send_group_poke`。
  方法名形式只允许白名单内的方法，见 [src/bot.ts](src/bot.ts) 的 `allowed`。

命令（仅主人）：`#QQ账号` 列出各 ICQQ 账号的状态。`#QQ设置` / `#QQ签名` 只回复一句去面板操作
的指引，不在聊天里接收密码。

能力（`bot.caps`）：`recall`、`forward`、`poke`、`groupFile`、`groupCard`、`groupMute`、`groupKick`、
`groupWholeMute`、`groupAdmin`、`groupName`、`groupSign`、`friendRequest`、`groupRequest`、
`fetchHistory`、`getFileUrl`、`markdown`、`keyboard`。另实现了 `quitGroup` 与 `getMessage`。
其中 `groupAdmin`、`groupName`、`groupSign` 没有通用方法，要经 `callApi` 调用；`markdown` 与
`keyboard` 见下方限制。

## 已知限制

- **JSON、XML、位置、戳一戳、语音、视频不能与文字混发。** icqq 遇到这类元素时只发它一个，
  同一段里的文字会被丢掉。要配文字请分两次 `reply`。
- **Markdown 与按钮多半发不出去。** 普通 QQ 号没有发送权限，按钮还缺少 QQ 机器人的 appid。
  能力表里声明了这两项，但真实账号上通常会发送失败。
- **@ 非 QQ 号的 id**（如别的平台转来的用户）不会提醒到任何人；没给名字时显示成 `@NaN`。
- 戳一戳段发出的是戳一戳动画元素（`pokeType` 0–6），段里的 `uid` 不起作用。要在群里拍一拍某人，
  请用 `callApi("send_group_poke", { group_id, user_id })`。
- **成员已退群时 `getGroupMember()` 会抛错**，不是返回 `undefined`。`getGroupMemberList()` 拉过的群，
  其成员表会一直留在 icqq 内存里，与 `cacheGroupMember` 设置无关。
- 发送失败直接报错，不会自动改成合并转发重发。
- 讨论组、QQ 频道消息不接入。
- 不支持借 QQBot 账号转发按钮回调。
- 多个账号由内核同时连接，不会逐个错开登录。
- 签名服务器只能在每个账号上单独填，没有全局缺省值，也不能用 `#QQ签名` 在聊天里设置。
- 扫码登录固定用手表协议，不能选其他设备。
- @ 没给名字时，不会去查群名片或昵称，显示的是 QQ 号。
- NT 登录流程用本地模拟站点测过，没有在新版协议库与真实辅助站点上测试过。

## 开发

依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`（`peerDependencies`）。框架发布到 npm 之前需先
链接本地框架 checkout，且框架要先 `pnpm run build`：

```powershell
pnpm install --ignore-workspace
pnpm run link:framework # 按 YZNG_FRAMEWORK → ../yunzai-ng → ../../yunzai-ng 查找
pnpm run verify         # build → typecheck:test → lint → test
```

插件直接放在框架仓库的 `plugins/` 下开发时，需显式指定框架位置：
`$env:YZNG_FRAMEWORK = "<框架仓库根>"`。`--ignore-workspace` 不能省：框架的工作区包含
`plugins/*`，不加的话 pnpm 会改写框架自己的 `pnpm-lock.yaml`。

测试全部离线：协议补丁用真实的 icqq 加载验证，登录与收发用替身客户端，验证辅助站点用本机起的
HTTP / WebSocket 服务模拟。能否真的登上、发出消息
取决于账号状态、协议版本与签名服务器，测试证明不了这一点，请在真实账号上手工验证。

## 许可

本插件以 AGPL-3.0-or-later 发布。`vendor/device.js` 与 `vendor/parser.js` 是对 icqq 内部模块的
替换实现，来源仓库未附许可证；icqq 本身为 MPL-2.0。分发前请自行确认这两个文件的授权。
