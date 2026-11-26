# dsh-connect-loomy

把本机登录的 **讯飞 Loomy** 桌面端接成 DeepSeek Harness（DSH）的模型提供方。

插件复用 Loomy 桌面端已经写好的登录态（`auth-session.json` 里的 `session`），直接调用 Loomy 的 OpenAI 兼容网关，因此不需要另外申请 API Key，也不在插件里保存任何凭据。

## 功能

- **模型接入**：从 Loomy 网关的 `/api/v1/models` 拉取真实模型目录（含上下文长度、最大输出、思考档位、视觉能力），拉不到时使用内置快照兜底。
- **对话**：走标准 OpenAI 兼容 `/chat/completions`，支持流式输出与思考档位（reasoning effort）。
- **积分读数**：读取 `/api/v1/points/balance`，登录后在宿主日志里报告余额，不打印 token。
- **零配置**：自动按当前用户名定位 Loomy 的 userData 目录。

## 要求

- DeepSeek Harness `>= 0.1.7`（在 `0.2.1` / `0.2.2` 上验证）
- 本机已安装并登录 **Loomy 桌面端**（项目在 `0.9.39` 上验证）
- Node.js `^22.19.0 || >= 24`

## 安装

```sh
dsh plugin add dsh-connect-loomy
```

或从仓库源码安装：

```sh
dsh plugin add github:txp2026txp/dsh-connect-loomy
```

安装后重启 DSH，模型选择器里会出现 `Loomy · 讯飞` 提供方与 Loomy 账号下的模型。

## 工作方式

1. 定位 Loomy 的 userData 目录：`C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>\userData\`，读取其中的 `auth-session.json`。
2. 用该文件里的 `session` 作为凭据：对话端点用 `Authorization: Bearer`，模型与积分端点用 `token` 请求头（这是 Loomy 网关的实际约定）。
3. 通过 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` 把 provider 注册进 DSH，模型目录按 10 分钟刷新。

插件只读取 Loomy 自己写下的登录态，不生成、不刷新、不上传凭据；token 不会出现在日志里。

## 配置

| 字段 | 说明 |
| --- | --- |
| `authFile` | 手动指定 `auth-session.json` 路径，默认自动定位 |
| `refreshIntervalMs` | 模型目录刷新间隔，默认 600000（10 分钟） |

## 已知限制

- 只包含宿主侧能力，暂未提供设置页卡片与积分徽标（设置项通过 DSH 配置文件生效）。
- 上游积分按 Loomy 账号计费，模型名里的 `x2.0` 一类是积分倍率标注。
- 登录态由 Loomy 维护；在 Loomy 里退出登录后，本插件会随之失效。

## License

MIT
