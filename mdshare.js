#!/usr/bin/env node
'use strict';
/*
 * mdshare —— 给一篇本机 .md 生成一条手机可读+可批注的链接(供 Codex / Claude Code 调用)
 *
 *   node mdshare.js <绝对路径.md> [--for 姓名] [--days N]
 *
 *   --for   这条链接的批注者署名(默认:你自己,见 .mdread/owner 或 "我")。给别人看就写他名字。
 *   --days  有效期天数(默认不过期)。给外人看建议加,如 --days 3。
 *
 * 输出:最后一行就是可直接发给用户的链接。源文件不动;批注写回 <文件>.annotations.json。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDataDir, getPaths, mutateJson, ReviewStoreError } = require('./lib/review-store');

const PATHS = getPaths();
const DATA_DIR = PATHS.dataDir;
const REG_FILE = PATHS.registry;
const URL_FILE = PATHS.url;

function fail(msg) { console.error('mdshare 错误:' + msg); process.exit(1); }

// 解析参数
const argv = process.argv.slice(2);
let mdPath = null, forName = null, days = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--for') {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('--for 后必须提供署名。');
    forName = argv[++i];
  } else if (a === '--days') {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('--days 后必须提供正整数。');
    const rawDays = argv[++i];
    if (!/^\d+$/.test(rawDays) || !Number.isSafeInteger(Number(rawDays)) || Number(rawDays) < 1 || Number(rawDays) > 36500) {
      fail('--days 必须是 1 到 36500 之间的正整数。');
    }
    days = Number(rawDays);
  } else if (a.startsWith('--')) fail('未知参数:' + a);
  else if (mdPath) fail('只能分享一个 .md 文件，多余路径:' + a);
  else mdPath = a;
}
if (!mdPath) fail('请给出要分享的 .md 文件路径。用法:node mdshare.js <绝对路径.md> [--for 姓名] [--days N]');

const requestedPath = path.resolve(mdPath);
let absPath;
try { absPath = fs.realpathSync(requestedPath); } catch (error) {
  if (error.code === 'ENOENT') fail('文件不存在:' + requestedPath);
  fail('无法解析文件路径:' + requestedPath + ' (' + error.message + ')');
}
if (!/\.md$/i.test(absPath)) fail('只支持 .md 文件(出于安全,不分享其它类型)。');
let sourceStat;
try { sourceStat = fs.statSync(absPath); } catch (error) {
  fail('无法读取文件状态:' + absPath + ' (' + error.message + ')');
}
if (!sourceStat.isFile()) fail('路径不是普通 .md 文件:' + absPath);

function parsePortStrict(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function readRecordedPortStrict() {
  try { return parsePortStrict(fs.readFileSync(PATHS.port, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 署名:--for 优先,否则取 owner 文件 / 环境变量 / 默认"我"
let owner = process.env.MDREAD_OWNER || '我';
try { owner = fs.readFileSync(path.join(DATA_DIR, 'owner'), 'utf8').trim() || owner; } catch {}
const name = forName || owner;

const now = Date.now();
const expiresAt = days ? new Date(now + days * 86400000).toISOString() : null;

async function main() {
  ensureDataDir();
  const { id, link } = await mutateJson(REG_FILE, () => ({ links: {} }), (reg) => {
    let id = Object.keys(reg.links).find((key) => {
      const candidate = reg.links[key];
      return candidate.absPath === absPath && (candidate.name || '') === name &&
        (!candidate.expiresAt || Date.parse(candidate.expiresAt) > now);
    });
    let link;
    if (id) {
      link = reg.links[id];
      if (expiresAt) link.expiresAt = expiresAt;
    } else {
      do { id = crypto.randomBytes(4).toString('hex'); } while (reg.links[id]);
      link = {
        absPath,
        token: crypto.randomBytes(12).toString('base64url'),
        name,
        createdAt: new Date().toISOString(),
        expiresAt,
      };
      reg.links[id] = link;
    }
    return { id, link: { ...link } };
  }, {
    mode: 0o600,
    validate(reg, filePath) {
      if (!reg || typeof reg !== 'object' || Array.isArray(reg) ||
          !reg.links || typeof reg.links !== 'object' || Array.isArray(reg.links)) {
        throw new ReviewStoreError('INVALID_REGISTRY', `分享注册表结构无效，已停止写入: ${filePath}`);
      }
    },
  });

  // 公网基址(serve.command 启动隧道后写入);没有就回退本机地址
  let base = '';
  try { base = fs.readFileSync(URL_FILE, 'utf8').trim(); } catch {}
  let localOnly = false;
  if (!base) {
    base = 'http://localhost:' + (readRecordedPortStrict() || parsePortStrict(process.env.MDREAD_PORT) || 8080);
    localOnly = true;
  }

  const url = `${base}/d/${id}?k=${link.token}`;
  console.log('文档:' + path.basename(absPath));
  console.log('署名:' + name + (link.expiresAt ? '   有效期至 ' + link.expiresAt.slice(0, 10) : '   长期有效'));
  if (localOnly) console.log('⚠️ 未检测到外网隧道(.mdread/url),下面是本机地址,外网打不开。先跑 serve.command 起隧道。');
  console.log('链接(发给用户):');
  console.log(url);
}

main().catch((error) => fail(`${error.message}${error.code ? ` [${error.code}]` : ''}`));
