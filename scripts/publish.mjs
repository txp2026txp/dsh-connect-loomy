#!/usr/bin/env node
/**
 * 把 dsh-connect-loomy 发布到 GitHub 并提交插件市场收录。
 *
 * 用法（需要 GITHUB_TOKEN，classic PAT，勾选 repo 权限）：
 *   GITHUB_TOKEN=xxx node scripts/publish.mjs repo     # 建仓库 + 推送 + 打 topic
 *   GITHUB_TOKEN=xxx node scripts/publish.mjs market   # fork 市场仓库 + 加条目 + 开 PR
 *   GITHUB_TOKEN=xxx node scripts/publish.mjs status    # 只看状态
 *
 * 网络说明：本机 https://github.com 不通，但 api.github.com 与 SSH(22/443) 可用，
 * 所以 API 走 HTTPS，push 走 SSH。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'txp2026txp';
const REPO = 'dsh-connect-loomy';
const MARKET = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' };
const ENTRY_PATH = 'data/plugins/txp2026txp__dsh-connect-loomy.yml';
const BRANCH = 'add-dsh-connect-loomy';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = process.env.GITHUB_TOKEN;
const API = 'https://api.github.com';

function log(...a) { console.log(...a); }
function die(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'dsh-connect-loomy-publish',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function whoami() {
  const r = await api('/user');
  if (!r.ok) die(`token 无效或权限不足（HTTP ${r.status}）：${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.login;
}

async function repoStatus() {
  const r = await api(`/repos/${OWNER}/${REPO}`);
  if (r.status === 404) return null;
  if (!r.ok) die(`查询仓库失败 HTTP ${r.status}`);
  return r.body;
}

async function phaseRepo() {
  const login = await whoami();
  if (login !== OWNER) log(`⚠ 当前 token 属于 ${login}，而条目写的是 ${OWNER}；后续请把 OWNER 改成 ${login}`);

  let repo = await repoStatus();
  if (!repo) {
    log('→ 创建仓库…');
    const r = await api('/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: REPO,
        description: '把讯飞 Loomy 接成 DeepSeek Harness 的模型提供方：复用桌面端登录态，提供模型目录、对话与积分。',
        private: false,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        auto_init: false,
        topics: ['dsh-plugin', 'deepseek-harness', 'dsh', 'loomy', 'xunfei'],
      }),
    });
    if (!r.ok) die(`创建仓库失败 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    repo = r.body;
    log(`  已创建 ${repo.full_name}`);
  } else {
    log(`→ 仓库已存在：${repo.full_name}`);
  }

  // 注意：本机 git 配置可能把 git@github.com: 改写成 HTTPS（该通道被墙），用 ssh:// 形式可绕过
  const remote = `ssh://git@github.com/${OWNER}/${REPO}.git`;
  try { execFileSync('git', ['remote', 'remove', 'origin'], { cwd: ROOT, stdio: 'ignore' }); } catch {}
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: ROOT });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: ROOT });
  log(`→ 推送 main 到 ${remote}`);
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });

  const topics = ['dsh-plugin', 'deepseek-harness', 'dsh', 'loomy', 'xunfei', 'model-provider'];
  const t = await api(`/repos/${OWNER}/${REPO}/topics`, {
    method: 'PUT',
    body: JSON.stringify({ names: topics }),
  });
  log(t.ok ? `  已设置 topics: ${topics.join(', ')}` : `  ⚠ topics 设置失败 HTTP ${t.status}`);

  const fresh = await repoStatus();
  const ageH = (Date.now() - new Date(fresh.created_at).getTime()) / 36e5;
  log(`\n仓库创建于 ${fresh.created_at}（已 ${ageH.toFixed(1)} 小时）`);
  if (ageH < 24) log(`⚠ 市场 CI 要求仓库存在满 1 天：还需 ${(24 - ageH).toFixed(1)} 小时才能开 PR。`);
  else log('✓ 仓库已满 1 天，可以执行 market 阶段。');
}

async function phaseMarket() {
  const repo = await repoStatus();
  if (!repo) die('仓库还不存在，先执行 repo 阶段。');
  const ageH = (Date.now() - new Date(repo.created_at).getTime()) / 36e5;
  if (ageH < 24) die(`仓库只存在了 ${ageH.toFixed(1)} 小时，市场 CI 要求满 1 天，稍后再来。`);

  const src = join(ROOT, 'market-entry', ENTRY_PATH);
  if (!existsSync(src)) die(`找不到条目文件 ${src}`);
  const content = readFileSync(src, 'utf8');

  log('→ fork 市场仓库（已 fork 会返回现有 fork）…');
  let f = await api(`/repos/${MARKET.owner}/${MARKET.repo}/forks`, { method: 'POST', body: '{}' });
  if (!f.ok && f.status !== 202) die(`fork 失败 HTTP ${f.status}: ${JSON.stringify(f.body).slice(0, 200)}`);

  let fork;
  for (let i = 0; i < 30; i++) {
    const r = await api(`/repos/${OWNER}/${MARKET.repo}`);
    if (r.ok) { fork = r.body; break; }
    await new Promise((s) => setTimeout(s, 2000));
  }
  if (!fork) die('等待 fork 超时');
  log(`  fork: ${fork.full_name}`);

  const base = await api(`/repos/${OWNER}/${MARKET.repo}/git/ref/heads/main`);
  if (!base.ok) die(`读取 fork 主分支失败 HTTP ${base.status}`);
  const sha = base.body.object.sha;

  const exists = await api(`/repos/${OWNER}/${MARKET.repo}/contents/${ENTRY_PATH}?ref=${BRANCH}`);
  if (exists.ok) {
    log(`→ 分支 ${BRANCH} 已含条目，跳过`);
  } else {
    log(`→ 建分支 ${BRANCH} 并写入 ${ENTRY_PATH}`);
    const b = await api(`/repos/${OWNER}/${MARKET.repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha }),
    });
    if (!b.ok && b.status !== 422) die(`建分支失败 HTTP ${b.status}: ${JSON.stringify(b.body).slice(0, 200)}`);
    const put = await api(`/repos/${OWNER}/${MARKET.repo}/contents/${ENTRY_PATH}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Add ${OWNER}/${REPO}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: BRANCH,
      }),
    });
    if (!put.ok) die(`写条目失败 HTTP ${put.status}: ${JSON.stringify(put.body).slice(0, 300)}`);
  }

  const body = [
    '### 这是什么',
    '',
    '`dsh-connect-loomy` 把本机登录的**讯飞 Loomy 桌面端**接成 DSH 的模型提供方：复用桌面端已写下的登录态（`auth-session.json`）调用 Loomy 的 OpenAI 兼容网关，提供真实模型目录、流式对话与积分余额。',
    '',
    '### 与已有条目的区别',
    '',
    '- `2404723600/dsh-router-loomy` 是 dsh-router 的通道，需要先装 dsh-router；本插件是**独立 provider**，不依赖其他插件。',
    '- `1015677515/dsh-cyberegg` 只读取积分；本插件提供完整的模型接入（模型目录 + 对话 + 思考档位 + 积分）。',
    '',
    '### 自检',
    '',
    '- [x] `package.json` 声明 `dsh.bundle.patch`',
    '- [x] 仓库已加 `dsh-plugin` topic',
    '- [x] 真实代码，已有可运行版本（本地 DSH `0.2.1-rc.2` 上 `fiberPhase: active`，上游 `/models`、`/chat/completions`、`/points/balance` 实测 200）',
    '- [x] `peerDependencies` 已为预发布版本显式写分支',
    '',
    '### 安装',
    '',
    '```sh',
    `dsh plugin add github:${OWNER}/${REPO}`,
    '```',
  ].join('\n');

  const pr = await api(`/repos/${MARKET.owner}/${MARKET.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `Add ${OWNER}/${REPO}`,
      head: `${OWNER}:${BRANCH}`,
      base: 'main',
      body,
    }),
  });
  if (pr.ok) {
    log(`\n✓ PR 已创建：${pr.body.html_url}`);
  } else if (pr.status === 422 && String(JSON.stringify(pr.body)).includes('already exists')) {
    const list = await api(`/repos/${MARKET.owner}/${MARKET.repo}/pulls?state=open&head=${OWNER}:${BRANCH}`);
    log(`\n✓ PR 已存在：${list.body?.[0]?.html_url ?? '(见仓库)'}`);
  } else {
    die(`开 PR 失败 HTTP ${pr.status}: ${JSON.stringify(pr.body).slice(0, 400)}`);
  }
}

async function phaseStatus() {
  const repo = await repoStatus();
  if (!repo) return log('本地没有对应远端仓库。');
  const ageH = (Date.now() - new Date(repo.created_at).getTime()) / 36e5;
  log(`仓库      : ${repo.full_name}（${repo.html_url}）`);
  log(`创建时间  : ${repo.created_at}（已 ${ageH.toFixed(1)} 小时，满 24h 才能提 PR）`);
  log(`topics    : ${(repo.topics || []).join(', ') || '(空)'}`);
  const prs = await api(`/repos/${MARKET.owner}/${MARKET.repo}/pulls?state=all&head=${OWNER}:${BRANCH}`);
  if (prs.ok && prs.body?.length) for (const p of prs.body) log(`PR        : #${p.number} ${p.state} ${p.html_url}`);
  else log('PR        : (还没有)');
}

if (!TOKEN) die('缺少 GITHUB_TOKEN。用法：GITHUB_TOKEN=xxx node scripts/publish.mjs repo|market|status');
const phase = process.argv[2] || 'status';
if (phase === 'repo') await phaseRepo();
else if (phase === 'market') await phaseMarket();
else if (phase === 'status') await phaseStatus();
else die(`未知阶段 ${phase}`);
