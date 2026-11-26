/**
 * dsh-connect-loomy — 把本机登录的讯飞 Loomy 模型接入 DeepSeek Harness。
 *
 * 设计要点（对照 dsh-connect-workbuddy 的最小 provider 范式）：
 *   - 复用 Loomy 桌面端登录态：读 userData/auth-session.json 里的 session。
 *   - Loomy 上游是标准 OpenAI 兼容网关，chat 端点直接接受 Authorization: Bearer，
 *     所以砍掉 workbuddy 的 loopback shim — baseUrl 直指网关，session 当 apiKey，
 *     pi-ai 的 openAICompletionsApi 自己发 Bearer 头。这一刀省掉几千行。
 *   - 模型目录从 /api/v1/models 拉取（token 头），内置 9 个模型的静态兜底目录。
 *
 * 所有宿主包都是 bare import（由 DSH 运行时注入），本插件不打包依赖。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

/** Loader 条目名 / 注入的服务 */
export const name = 'dsh-connect-loomy'
export const inject = ['llm']

/** 这个 bundle 拥有的 provider 路由 */
const PROVIDER = 'loomy'
const DISPLAY = 'Loomy · 讯飞'
/** pi-ai stamp 在模型上的 provider 身份（与路由 id 相同，单路由无需区分） */
const IDENTITY = 'loomy'
/** Loomy 聚合网关（OpenAI 兼容），实测可用 */
const BASE_URL = 'https://loomyad.xunfei.cn/api/v1'
/** settings 命名空间回落值；实际值优先取 Loader 条目 id */
const NS = 'dsh-connect-loomy'
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const DEFAULT_CONTEXT = 262144
const DEFAULT_MAX_TOKENS = 32000
const REFRESH_MS = 10 * 60 * 1000

/** 唯一允许的思考档位（pi-ai 词汇） */
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 宿主按精确匹配查 settings 命名空间：宣告错会让配置与模型发现双双静默失效。
 * ctx.fiber.entry 由 Loader 注入，测试宿主可能没有，故带回落。
 */
function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : NS
}

/** 静态兜底模型目录：来自 /api/v1/models 的实测快照，上游拉不到时先顶上 */
const FALLBACK_MODELS = [
  { id: 'spark-x2.6', name: 'Spark-X2.6 正式版(x2.5)', contextLength: 1048576, maxOutput: 131072, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], vision: false, isDefault: true, isSmall: true },
  { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek-V4.1-Flash(x2.0)', contextLength: 1048576, maxOutput: 384000, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], vision: true },
  { id: 'deepseek-v4-flash-1017', name: 'deepseek-v4-flash-1017(x2.0)', contextLength: 1048576, maxOutput: 384000, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], vision: true },
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash(x0.8)', contextLength: 1048576, maxOutput: 131072, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], vision: true },
  { id: 'qwen3.8-flash', name: 'qwen3.8-flash(x0.8)', contextLength: 1000000, maxOutput: 131072, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], vision: true },
  { id: 'Hy-Image-3.5-preview', name: 'Hy-Image-3.5-preview', contextLength: 100000, maxOutput: 32000, efforts: [], vision: false, imageOutput: true },
  { id: 'doubao-seedream-5-lite', name: 'doubao-seedream-5-lite', contextLength: 128000, maxOutput: 32000, efforts: [], vision: false, imageOutput: true },
  { id: 'qwen-image-3.0-pro', name: 'qwen-image-3.0-pro', contextLength: 262144, maxOutput: 32000, efforts: [], vision: false, imageOutput: true },
  { id: 'auto', name: '自动·均衡', contextLength: DEFAULT_CONTEXT, maxOutput: DEFAULT_MAX_TOKENS, efforts: [], vision: false },
]

/** 上游 /api/v1/models 的一条记录 → 内部模型描述 */
function fromUpstreamModel(m) {
  const caps = m?.capabilities ?? {}
  const input = Array.isArray(caps.input_modalities) ? caps.input_modalities : []
  const efforts = Array.isArray(m?.reasoning_efforts) ? m.reasoning_efforts : []
  return {
    id: String(m.id),
    name: String(m.name ?? m.id),
    contextLength: Number(m.context_length) || DEFAULT_CONTEXT,
    maxOutput: Number(m.max_output_tokens) || DEFAULT_MAX_TOKENS,
    efforts,
    vision: input.includes('image'),
    isDefault: m.is_default_model === true,
    isSmall: m.is_default_small_model === true,
    imageOutput: Array.isArray(caps.output_modalities) && caps.output_modalities.includes('image'),
  }
}

/** Loomy 的 reasoning_efforts → pi-ai 的 thinkingLevelMap（none→off，未知档为 null） */
function thinkingLevelMap(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const set = new Set(efforts)
  const map = {}
  let any = false
  for (const level of LEVELS) {
    if (set.has(level)) {
      map[level] = level
      any = true
    } else {
      map[level] = null
    }
  }
  if (set.has('none')) {
    map.off = 'off'
    any = true
  } else {
    map.off = null
  }
  return any ? map : undefined
}

/** 内部模型描述 → pi-ai Model<Api> */
function toPiModel(info) {
  const tlm = thinkingLevelMap(info.efforts)
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: IDENTITY,
    baseUrl: BASE_URL,
    input: info.vision ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextLength,
    maxTokens: info.maxOutput,
    reasoning: tlm !== undefined,
    ...(tlm === undefined ? {} : { thinkingLevelMap: tlm }),
    compat: { supportsReasoningEffort: tlm !== undefined },
  }
}

/** 宿主侧发现回调要的精简描述 */
function toDiscovered(info) {
  return {
    id: info.id,
    name: info.name,
    contextWindow: info.contextLength,
    maxTokens: info.maxOutput,
    inputModalities: info.vision ? ['text', 'image'] : ['text'],
  }
}

/** 定位 Loomy 的 userData 目录：C:\Users\Public\Loomy\<sha256(username)[0:12]>\userData */
function candidateUserDataDirs() {
  const dirs = []
  const publicRoot = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Loomy')
  const names = new Set()
  for (const n of [os.userInfo?.().username, process.env.USERNAME, process.env.USER]) {
    if (typeof n === 'string' && n !== '') names.add(n)
  }
  for (const n of names) {
    const hash = crypto.createHash('sha256').update(n).digest('hex').slice(0, 12)
    dirs.push(path.join(publicRoot, hash, 'userData'))
  }
  return { publicRoot, dirs }
}

/** 读登录 session：优先显式配置，其次按用户名 hash 定位，最后扫目录兜底 */
async function readSession(config) {
  if (typeof config?.authFile === 'string' && config.authFile !== '') {
    const json = JSON.parse(await fs.readFile(config.authFile, 'utf8'))
    const token = json?.session
    if (typeof token === 'string' && token !== '') return token
    throw new Error(`auth-session 文件缺少 session 字段: ${config.authFile}`)
  }
  const { publicRoot, dirs } = candidateUserDataDirs()
  const tried = []
  for (const dir of dirs) {
    const file = path.join(dir, 'auth-session.json')
    tried.push(file)
    try {
      const json = JSON.parse(await fs.readFile(file, 'utf8'))
      if (typeof json?.session === 'string' && json.session !== '') return json.session
    } catch {
      // 换下一个候选
    }
  }
  // 兜底：扫描 Public\Loomy\*\userData\auth-session.json
  try {
    const entries = await fs.readdir(publicRoot, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const file = path.join(publicRoot, e.name, 'userData', 'auth-session.json')
      if (tried.includes(file)) continue
      try {
        const json = JSON.parse(await fs.readFile(file, 'utf8'))
        if (typeof json?.session === 'string' && json.session !== '') return json.session
      } catch {
        // 继续
      }
    }
  } catch {
    // 目录不存在
  }
  throw new Error(
    `找不到 Loomy 登录态（auth-session.json）。Loomy 是否已登录？已尝试: ${tried.join(', ')}`,
  )
}

/** 从上游拉模型目录；models/points 端点要 token 头 */
async function fetchModels(session, signal) {
  const resp = await fetch(`${BASE_URL}/models`, {
    headers: { token: session, accept: 'application/json' },
    signal,
  })
  if (!resp.ok) throw new Error(`模型目录请求失败: HTTP ${resp.status}`)
  const json = await resp.json()
  if (json?.code && json.code !== '000000' && json.code !== 0) {
    throw new Error(`模型目录返回错误: ${json.code} ${json.desc ?? ''}`)
  }
  if (!Array.isArray(json?.data) || json.data.length === 0) throw new Error('模型目录为空')
  return json.data.map(fromUpstreamModel)
}

/** 读积分余额：token 头；返回 { balance, dailyBalance, availableBalance } 或 null */
async function fetchPoints(session) {
  const resp = await fetch(`${BASE_URL}/points/balance`, {
    headers: { token: session, accept: 'application/json' },
  })
  if (!resp.ok) return null
  const json = await resp.json()
  if (json?.code && json.code !== '000000' && json.code !== 0) return null
  return json?.data ?? null
}

/** pi-ai 的 inert auth plane：本插件自己管凭据，不让 pi-ai 发现环境凭证 */
const INERT_AUTH = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() { throw new Error('Loomy 凭据只读') },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** 最小 Config：一个可选的凭据文件覆盖 + 可选的轮询开关 */
export const Config = z.object({
  authFile: z.string().description('Loomy auth-session.json 路径（默认自动定位）'),
  refreshIntervalMs: z.number().description('模型目录刷新间隔（毫秒）'),
})

export function apply(ctx, config) {
  let models = FALLBACK_MODELS.slice()
  let sessionPromise

  /** session 惰性加载，失败不缓存以便下次重试（Loomy 可能稍后才登录） */
  const getSession = () => {
    if (sessionPromise === undefined) {
      sessionPromise = readSession(config).catch((err) => {
        sessionPromise = undefined
        throw err
      })
    }
    return sessionPromise
  }

  const buildModels = () => models.map(toPiModel)

  const base = createProvider({
    id: PROVIDER,
    name: DISPLAY,
    auth: {
      apiKey: {
        name: 'Loomy 登录态 session',
        async resolve({ credential }) {
          const key = credential?.key
          return key === undefined || key.length === 0 ? undefined : { auth: { apiKey: key }, source: 'Loomy' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })
  const provider = { ...base, getModels: buildModels }

  const profileFor = () => ({
    provider: PROVIDER,
    displayName: DISPLAY,
    streamIdleTimeoutMs: 300000,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-loomy.retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    reasoning: 'high',
    piProvider: provider,
  })

  const profiles = new Map([[PROVIDER, profileFor()]])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => getSession(),
  })

  const settingsNs = settingsNamespaceOf(ctx)
  const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter)
  const releaseDirectory = ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DISPLAY, settingsNs, settingsPath: [], declared: false },
  ])
  ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    if (request?.provider && request.provider !== PROVIDER) return []
    return models.map(toDiscovered)
  })

  /** 后台刷新：登录后拉一次真实目录，其后按间隔刷新；失败保留上一次目录 */
  let stopped = false
  const refresh = async () => {
    try {
      const session = await getSession()
      const live = await fetchModels(session)
      if (live.length > 0) models = live
    } catch {
      // 保留兜底目录，静默
    }
  }
  void refresh()
  const intervalMs = Number(config?.refreshIntervalMs) || REFRESH_MS
  const timer = setInterval(() => { if (!stopped) void refresh() }, intervalMs)
  if (timer.unref) timer.unref()

  /** 只读积分读数：登录后顺带取一次，写进宿主日志（不打印 token） */
  const reportPoints = async (session) => {
    try {
      const points = await fetchPoints(session)
      if (points) {
        ctx.logger?.info?.(
          `[dsh-connect-loomy] 积分余额: ${points.balance ?? '?'} / 每日 ${points.dailyBalance ?? '?'} / 可用 ${points.availableBalance ?? '?'}`,
        )
      }
    } catch {
      // 积分接口失败不影响主流程
    }
  }
  void (async () => {
    try {
      await reportPoints(await getSession())
    } catch {
      // 未登录时跳过
    }
  })()

  const dispose = () => {
    stopped = true
    clearInterval(timer)
    releaseAdapter?.()
    releaseDirectory?.()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)

  ctx.logger?.info?.(`[dsh-connect-loomy] provider ${PROVIDER} 已注册（${models.length} 个模型）`)
}
