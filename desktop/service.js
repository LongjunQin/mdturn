'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 8080;
const PORT_SCAN_COUNT = 11;
const HEALTH_TIMEOUT_MS = 700;
const READY_TIMEOUT_MS = 12_000;
const LAUNCH_AGENT = 'com.mdread.serve';

function parsePort(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function readRecordedPort(filePath) {
  try {
    return parsePort(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function portFiles(options = {}) {
  const projectDir = options.projectDir || null;
  const userDataDir = options.userDataDir || null;
  return unique([
    process.env.MDREAD_DATA_DIR ? path.join(process.env.MDREAD_DATA_DIR, 'port') : null,
    process.env.MDREAD_PROJECT_DIR ? path.join(process.env.MDREAD_PROJECT_DIR, '.mdread', 'port') : null,
    projectDir ? path.join(projectDir, '.mdread', 'port') : null,
    userDataDir ? path.join(userDataDir, 'mdread', 'port') : null,
  ]);
}

function candidatePorts(options = {}) {
  const recorded = (options.portFiles || portFiles(options))
    .map(readRecordedPort)
    .filter(Boolean);
  const ports = [...recorded];
  if (options.scanDefault !== false) {
    const base = parsePort(process.env.MDREAD_PORT) || DEFAULT_PORT;
    const maximum = Math.min(base + PORT_SCAN_COUNT - 1, 65_535);
    for (let port = base; port <= maximum; port += 1) ports.push(port);
  }
  return unique(ports);
}

function requestHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/health',
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const valid = response.statusCode === 200 && payload && payload.ok === true &&
            payload.service === 'md-read' && payload.port === port;
          resolve(valid ? { port, payload } : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function findHealthyService(options = {}) {
  const ports = candidatePorts(options);
  const results = await Promise.all(ports.map((port) => requestHealth(port, options.healthTimeoutMs)));
  return results.find(Boolean) || null;
}

async function kickstartService() {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    throw new Error(`${LAUNCH_AGENT} 只能由 macOS launchd 启动。`);
  }
  const target = `gui/${process.getuid()}/${LAUNCH_AGENT}`;
  try {
    await execFileAsync('/bin/launchctl', ['kickstart', '-k', target], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(`无法启动 ${LAUNCH_AGENT}${detail ? `：${detail}` : ''}`);
  }
}

async function ensureService(options = {}) {
  let service = await findHealthyService(options);
  if (service) return service;

  // 桌面壳只唤醒已经安装的 launchd helper，绝不自行再启动一个 Node 服务。
  await (options.kickstart || kickstartService)();

  const readyTimeoutMs = options.readyTimeoutMs || READY_TIMEOUT_MS;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs || 250));
    service = await findHealthyService(options);
    if (service) return service;
  }
  const seconds = Math.round(readyTimeoutMs / 100) / 10;
  throw new Error(`已唤醒 ${LAUNCH_AGENT}，但本地服务在 ${seconds} 秒内没有就绪。`);
}

module.exports = {
  DEFAULT_PORT,
  LAUNCH_AGENT,
  candidatePorts,
  ensureService,
  findHealthyService,
  parsePort,
  portFiles,
  requestHealth,
};
