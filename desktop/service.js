'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PORT = 8080;
const PORT_SCAN_COUNT = 11;
const HEALTH_TIMEOUT_MS = 700;
const READY_TIMEOUT_MS = 12_000;

function serverDirectory(options = {}) {
  if (options.serverDir) return path.resolve(options.serverDir);
  if (options.isPackaged) return path.join(options.resourcesPath, 'mdturn-server');
  return path.resolve(__dirname, '..');
}

// 必须与 lib/review-store.js 的默认数据目录一致,CLI 与 App 才能共享会话。
function ownedDataDirectory(options = {}) {
  const override = options.dataDir || process.env.MDREAD_DATA_DIR;
  return path.resolve(override || path.join(os.homedir(), '.mdread'));
}

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
  return unique([
    path.join(ownedDataDirectory(options), 'port'),
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

function startOwnedService(options = {}) {
  const directory = serverDirectory(options);
  const serverPath = path.join(directory, 'server.js');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`内置服务文件不存在: ${serverPath}`);
  }
  const dataDir = ownedDataDirectory(options);
  fs.mkdirSync(dataDir, { recursive: true });
  const spawnProcess = options.spawn || spawn;
  const executablePath = options.executablePath || process.execPath;
  const child = spawnProcess(executablePath, [serverPath], {
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MDREAD_DATA_DIR: dataDir,
      MDREAD_HOST: '127.0.0.1',
      MDREAD_PORT: '0',
    },
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.mdturnSpawnError = null;
  child.once('error', (error) => { child.mdturnSpawnError = error; });
  return { child, dataDir, portFile: path.join(dataDir, 'port') };
}

function stopOwnedService(service) {
  const child = service && service.ownedProcess;
  if (!child || child.exitCode !== null || child.killed) return false;
  try {
    child.kill();
    return true;
  } catch {
    return false;
  }
}

async function ensureService(options = {}) {
  let service = await findHealthyService(options);
  if (service) return service;

  const started = (options.startService || startOwnedService)(options);
  const ownedProcess = started.child;
  const discoveryOptions = {
    ...options,
    portFiles: [started.portFile],
    scanDefault: false,
  };

  const readyTimeoutMs = options.readyTimeoutMs || READY_TIMEOUT_MS;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs || 250));
    if (ownedProcess && ownedProcess.mdturnSpawnError) {
      throw new Error(`无法启动 MDTurn 内置服务: ${ownedProcess.mdturnSpawnError.message}`);
    }
    if (ownedProcess && ownedProcess.exitCode !== null) {
      throw new Error(`MDTurn 内置服务提前退出（代码 ${ownedProcess.exitCode}）。`);
    }
    service = await findHealthyService(discoveryOptions);
    if (service) return { ...service, ...(ownedProcess ? { ownedProcess } : {}) };
  }
  if (ownedProcess) stopOwnedService({ ownedProcess });
  const seconds = Math.round(readyTimeoutMs / 100) / 10;
  throw new Error(`MDTurn 内置服务在 ${seconds} 秒内没有就绪。`);
}

module.exports = {
  DEFAULT_PORT,
  candidatePorts,
  ensureService,
  findHealthyService,
  ownedDataDirectory,
  parsePort,
  portFiles,
  requestHealth,
  serverDirectory,
  startOwnedService,
  stopOwnedService,
};
