# dsh-no-telemetry

[English](https://github.com/scarletkc/dsh-no-telemetry/blob/main/README.md) | **中文**

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 bundle，会关闭 DSH 里我能找到的全部遥测和会话日志上传，并去掉 DSH 加在 DeepSeek API 请求上的身份请求头。仓库附带一个在沙盒里抓包的验证脚本，效果可以自己检查，不用只听我说。

> 已在 DeepSeek Harness **0.2.2-rc.5**（Windows）上测试。与 DeepSeek 官方无关。

## 原版 DSH 会发出什么

以下全部默认开启，每一项都对照过 `app.asar` 里的源码，并抓包确认。

| 通道 | 发出的内容 | 应用内开关 |
|---|---|---|
| 官方 DeepSeek API 请求里的 `dsh_session_log` 字段 | 完整会话日志：你的消息、模型回复、system prompt、工具调用和结果（文件内容、命令输出），以及工作目录的绝对路径 | 有开关，但关掉**只是暂停**。关闭期间写入的内容，重新打开后会补传；fork 出来的会话会把继承的历史从第 0 条重传 |
| 同一字段，混用模型的会话 | 同一会话里此前用第三方模型（Claude、GPT 等）跑的轮次 | – |
| 同一字段，自定义 baseURL | DeepSeek 适配器用的是哪个地址就发给哪个地址，中转站也一样 | – |
| `dsh_plugin_packages` 字段 | 你装的全部插件及版本，第三方插件也算 | 无 |
| `x-deepseek-harness-user-id` / `-session-id` 请求头 | 每个 DeepSeek 请求都带一个固定的匿名 ID（`~/.dsh/.anonymous-user-id`）和会话 ID | 无 |
| 反馈 → OTLP（`dsh-otel-collector.deepseeksvc.com`） | 整段会话，不管用的是哪家模型，外加 `user.id` | 只有 `DSH_TELEMETRY_DISABLED` 环境变量 |
| 桌面版产品埋点（同一个收集端） | 使用事件、模型名（第三方的也报）、CPU、内存、系统版本号、账号 `user_id` 和 `device_id` | 无（源码注释原文是 "no user settings surface"） |

## 这个 bundle 做了什么

`cordis.patch.yml` 作为 bundle 层叠加在官方 bundle 之后，禁用以下这些行：

| 行 | 作用 |
|---|---|
| `deepseek-llm-api-extensions` | 移除给 DeepSeek 请求附加顶层字段的注册表。没了它，适配器一个 `dsh_*` 字段都不会发 |
| `session-log-deepseek`、`plugin-package-inventory-deepseek` | 两个字段的来源，再按名字单独禁用一次 |
| `session-telemetry-otel` | 反馈时的整段会话上传 |
| `product-analytics`、`desktop-product-telemetry` | 桌面版埋点 |
| `otel` | 共用的 OTLP 服务，只有上面两个遥测行在用 |

另外在 Host 进程里插入一个小的 **fetch 过滤器**（`index.js`）作为第二道防线，它会：

- 去掉所有 `x-deepseek-harness-*` 请求头（这些是写死的，没有配置开关）；
- 去掉 JSON 请求体里所有顶层 `dsh_*` 字段，以后版本新增的这类字段也能挡住；
- 拒绝发往 `*.deepseeksvc.com` 的 `fetch` 请求。

不涉及以上内容的请求原样放行。你的消息、API Key 和所选模型照常发给模型。

设置页只会改一行的 `config`，碰不到 `disabled` 标记，所以应用里没有任何开关能把这些行重新打开。

## 验证结果

在 0.2.2-rc.5 上运行 `verify/run.ps1` 的结果：

| 检查项 | 原版 DSH | 装了本 bundle |
|---|---|---|
| `dsh_*` 请求字段 | `dsh_plugin_packages`、`dsh_session_log` | 无 |
| `x-deepseek-harness-*` 请求头 | `-session-id`、`-user-id` | 无 |
| 关闭上传期间写的内容，之后被补传 | 会 | 不会 |
| fork 重传继承的历史 | 会 | 不会 |
| 反馈时 OTLP 上传整段会话（测试中为 81 KB） | 会 | 不会 |
| 模型请求照常工作 | ✔ | ✔ |

## 安装

1. 在 DeepSeek Harness 里打开 **插件** → **添加插件**，粘贴 `https://github.com/ScarletKc/dsh-no-telemetry` 并安装。
2. 完全退出 DeepSeek Harness，再重新打开。
3. 可选但建议：**设置 → 通用 → 上传 Session Log** 也保持关闭。万一以后移除了本 bundle，原版的上传模块会恢复；那时开关如果是开着的，旧会话会被补传。

命令行（headless 或自定义 profile）：`dsh plugin --profile <name> add github:ScarletKc/dsh-no-telemetry`

## 自己验证

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File verify\run.ps1
```
```sh
# macOS（路径尚未实测，必要时设置 DSH_APP_RESOURCES）
sh verify/run.sh
```

脚本用的是 DeepSeek Harness 自带的 Electron 运行时，不需要另装 Node.js。它用一个临时的 `DSH_HOME` 启动 DSH 命令行，把 DeepSeek API 和所有遥测地址都指向本地的记录服务器，然后在临时 profile 里，分别在装本 bundle 前后跑同一组场景。**不会有任何数据发到互联网，你真实的 `~/.dsh` 完全不会被动到。** 设置 `DSH_KEEP_TEMP=1` 可以保留抓到的请求。

每次 DSH 更新后请重新跑一遍：官方改名或新增的行，要等本 bundle 更新后才能覆盖。验证失败的话，请开 issue 并附上 `captured.json`。

## 不覆盖的部分

- 桌面版自动更新检查（`download.deepseek.com`）在 Electron 主进程里运行，插件管不到。
- 用 DeepSeek 账号登录时，登录流程本身会提交设备 ID、设备型号和系统版本。改用 API Key 就能避开。
- 服务端本来就能看到的东西：你的 IP、API Key、`User-Agent`，以及你发给模型的对话本身。
- 已经上传过的数据。可以发邮件到 `harness-privacy@deepseek.com` 要求删除（欧盟用户可依据 GDPR 第 15、17 条）。

## 卸载

在 **插件** 里移除，然后重启。这会恢复原版行为，**包括尚未上传的会话日志积压**（见安装第 3 步）。

## 许可证

MIT
