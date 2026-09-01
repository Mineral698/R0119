# Float 小手机 · 安卓壳（FloatShell）

一个极薄的安卓 App 壳：全屏 WebView 直接加载你自己的线上站点，外加一个**不依赖 Google 服务**的
离线推送长连接。目标用户：安卓机上收不到 Web Push 的用户
（国行机无 GMS、或所在网络到不了 Google 推送服务器）。

## 它解决什么

| 能力 | 网页版（安卓 Chrome） | 安卓壳 |
| --- | --- | --- |
| 页面功能 | ✅ | ✅ 完全一致（加载同一网页） |
| 离线推送 | 依赖 FCM（需 GMS + 能连 Google） | ✅ 自建 Supabase Realtime 长连接，无 GMS 也能收 |
| 网页更新 | 自动 | ✅ 同样自动（壳只是浏览器，部署即生效） |

推送链路：`push-generate` 边缘函数生成完离线消息后，除了发 Web Push，
还会向 Supabase Realtime 的个人频道 `shellpush:<userId>` 广播一份；
壳内前台服务保持一条 WebSocket 长连接订阅该频道，收到即弹系统通知。
设置页的「测试」按钮走同一条链路，可直接验证。

## 一键构建（GitHub Actions）

仓库已带工作流 `.github/workflows/android-shell.yml`：

1. 在仓库 **Settings → Secrets and variables → Actions → Variables** 新建
   `SHELL_SITE_URL`，值为你的 HTTPS 站点地址。手动运行工作流时也可以临时填写
   `site_url`，它会覆盖仓库变量。
2. GitHub 仓库页 → **Actions** → **Build Android Shell APK** → **Run workflow**。
   （改动 `android-shell/**` 并推到 main 也会自动触发。）
3. 跑完后在该次运行的 **Artifacts** 里下载：
   - `float-shell-debug` —— debug 签名，**下载即可直接安装**，日常自用选这个；
   - `float-shell-release` —— 未配置签名密钥时是未签名包（装不了），配置后是正式签名包。

### 正式签名（可选，想长期分发再做）

本地生成一个密钥库（一次性）：

```bash
keytool -genkeypair -v -keystore shell.keystore -alias floatshell \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 shell.keystore   # 得到一长串 base64
```

在仓库 **Settings → Secrets and variables → Actions** 添加四个 Secret：

| Secret | 内容 |
| --- | --- |
| `SHELL_KEYSTORE_BASE64` | 上面 base64 输出 |
| `SHELL_KEYSTORE_PASSWORD` | 密钥库密码 |
| `SHELL_KEY_ALIAS` | `floatshell`（或你起的别名） |
| `SHELL_KEY_PASSWORD` | 密钥密码 |

之后每次构建的 release 包即为已签名版。注意：debug 包和 release 包
签名不同，互相覆盖安装前要先卸载旧的。

## 安装与首次设置

1. 把 APK 传到手机（微信文件传输助手 / 网盘 / 数据线均可），点开安装，
   系统提示「未知来源」时允许本次安装。
2. 打开 App → 正常登录账号。
3. 允许**通知权限**（首次启动会弹）。
4. 保活（收推送的关键，尤其国产 ROM）：
   - 系统设置里把「小手机」加入**电池优化白名单 / 无限制后台**；
   - 允许**自启动**（小米/华为/OPPO/vivo 在各自的手机管家里）;
   - 最近任务里把它**锁定**（下拉卡片 → 锁），避免一键清理杀掉。
5. 通知栏会有一条「小手机 · 后台连接」的常驻小通知——这是长连接保活的
   代价。不想看到可以长按它 → 把「后台连接」这个通知渠道关掉显示，
   **不要关「角色消息」渠道**。

设置 → 离线推送里点「测试」：杀掉后台，约 6 秒后应收到系统通知即为连通。

## 数据存放与迁移

壳内网页数据（聊天记录、角色等）存在 App 自己的 WebView 沙箱里，
和手机浏览器**不互通**。从浏览器搬家：

- 浏览器里 设置 → 数据管理 → **导出备份**，壳里同一入口**导入**；
- 或两边都登录同一账号，用**云端备份**过渡。

卸载 App 会清掉壳内数据，卸载前记得先导出或云备份。

## 更新模型

- **网页功能更新**：零成本。壳加载的是线上站点，Netlify 一部署，壳里即刻生效。
- **APK 更新**：只有改壳本身（推送逻辑、原生能力）才需要重新构建安装，预期很少。

## 实现速览

```
android-shell/
├── app/src/main/java/app/floatphone/shell/
│   ├── MainActivity.kt   # 全屏 WebView：站内导航/外链/文件选择/下载/返回键
│   ├── PushService.kt    # 前台服务：个人云 configurePush 或站点 config → WS 订阅 shellpush:<userId>
│   └── BootReceiver.kt   # 开机自启
└── ...gradle 工程
```

- 壳的 UA 追加了 ` FloatShell/<版本>`，网页可借 `window.AndroidShell`
  或 UA 识别壳环境；桥上有 `getVersion()` / `configurePush()` /
  `openAppSettings()` / `requestIgnoreBatteryOptimization()` 四个方法。
- 自部署个人云：网页把用户自己的 Supabase 地址交给 `configurePush`，
  壳直连该项目的 Realtime 频道 `shellpush:owner`，并登记合成订阅
  `shell:owner`。旧壳（1.0）只会去连站点联机库，自部署收不到离线消息，
  需要重新打包 1.1+。
- 推送服务连上后会向个人云（或站点回退通道）登记合成订阅 `shell:<userId>`，
  让离线消息排期的「账号已订阅」门控放行；服务端只做 Realtime 广播，
  不做 Web Push 投递。
- 官方托管（站点已配 Supabase）仍可走原来的 `/api/online/config` 回退。
- 壳内设置页的「离线推送」开关由壳自动接管（显示为已开启且不可关），
  Web Push 在 WebView 里本来就不可用。

## 服务端前提

自部署（`NEXT_PUBLIC_SELF_HOSTED_MODE=true`）请走**个人云**，不要指望给站点填 `SUPABASE_URL` 来收离线消息：

1. 把网站部署到 Netlify / Vercel，用 GitHub Actions 按上面步骤打 APK，`SHELL_SITE_URL` 填你的站点。
2. 安装 APK，打开后到 **设置 → 云服务部署**，用自己的 Supabase Access Token 创建个人云并勾选「离线推送」。
3. 到某个角色的聊天信息页打开「离线推送与定时消息」，创建「长时间没消息时」或「固定时间后」规则。
4. 允许通知、关掉电池优化（见上文）。设置页点「测试」：杀掉后台，约 6 秒后应收到系统通知。

角色之后就会按规则在随机/定时时间主动发消息；生成在个人云的 `push-generate` 上完成，壳的前台服务负责弹系统通知。

个人云改动后若测试按钮失败，到云服务部署里**重新部署一次离线推送**（会更新边缘函数）。

官方托管站点若已按 `docs/push-supabase.sql` 配好站点级离线推送，壳仍兼容那条旧链路。
