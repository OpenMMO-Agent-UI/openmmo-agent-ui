'use strict'

const { EventEmitter } = require('node:events')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { agentDir, repoRoot, writeConfig } = require('./config')

const LOG_CAP = 600
const READY_TIMEOUT_MS = 20000

const EXE = process.platform === 'win32' ? 'agent-client.exe' : 'agent-client'

/// Launched from Finder/Explorer, Electron inherits a bare PATH, so the CLI
/// backends (`codex`, `claude`) would be missing even though a terminal finds
/// them. Ask the login shell once and cache the answer.
let loginPath = null
function resolveLoginPath() {
  if (loginPath !== null) return Promise.resolve(loginPath)
  if (process.platform === 'win32' || !process.env.SHELL) {
    loginPath = process.env.PATH || ''
    return Promise.resolve(loginPath)
  }
  return new Promise((resolve) => {
    execFile(process.env.SHELL, ['-ilc', 'echo -n "__PATH__:$PATH"'], { timeout: 4000 }, (err, stdout) => {
      const match = !err && stdout && stdout.match(/__PATH__:(.*)/)
      loginPath = match ? match[1].trim() : process.env.PATH || ''
      resolve(loginPath)
    })
  })
}

function candidateBinaries(override) {
  const list = []
  if (override) list.push(override)
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'agent-client', EXE))
  list.push(path.join(repoRoot(), 'target', 'release', EXE))
  list.push(path.join(repoRoot(), 'target', 'debug', EXE))
  return list
}

function resolveBinary(override) {
  return candidateBinaries(override).find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

class AgentProcess extends EventEmitter {
  constructor() {
    super()
    this.child = null
    this.log = []
    this.deviceCode = null
    this.watchUrl = null
    this.stopping = false
  }

  get running() {
    return this.child !== null
  }

  status() {
    return {
      running: this.running,
      pid: this.child ? this.child.pid : null,
      watchUrl: this.watchUrl,
      deviceCode: this.deviceCode,
    }
  }

  append(stream, text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      const item = { stream, line, t: Date.now() }
      this.log.push(item)
      if (this.log.length > LOG_CAP) this.log.shift()
      this.emit('log', item)
      this.scanForDeviceCode(line)
    }
  }

  /// The device flow prints the URL and the code on separate lines; surface
  /// them as a banner so nobody has to read the log to sign in.
  scanForDeviceCode(line) {
    const url = line.match(/\b(https?:\/\/\S+)/)
    if (url && /open\s/.test(line)) {
      this.deviceCode = { ...(this.deviceCode || {}), url: url[1] }
    }
    const code = line.match(/enter code\s+(\S+)/i)
    if (code) this.deviceCode = { ...(this.deviceCode || {}), code: code[1] }
    if (this.deviceCode && this.deviceCode.url && this.deviceCode.code) {
      this.emit('device-code', this.deviceCode)
    }
  }

  async start(settings) {
    if (this.running) throw new Error('Agent is already running')

    const binary = resolveBinary(settings.binaryPath)
    if (!binary) {
      throw new Error(
        `agent-client binary not found. Build it with "cargo build --release -p agent-client", ` +
          `or point at one in Settings. Looked in:\n${candidateBinaries(settings.binaryPath).join('\n')}`,
      )
    }

    const cwd = agentDir()
    if (!fs.existsSync(path.join(cwd, 'data'))) {
      throw new Error(`No data/ directory next to the agent at ${cwd}`)
    }

    const configFile = writeConfig(settings)
    this.log = []
    this.deviceCode = null
    this.watchUrl = null
    this.stopping = false

    const env = {
      ...process.env,
      PATH: await resolveLoginPath(),
      RUST_LOG: settings.rustLog || 'info',
    }
    if (settings.openrouterKey) env.OPENROUTER_API_KEY = settings.openrouterKey
    if (settings.openaiKey) env.OPENAI_COMPAT_API_KEY = settings.openaiKey
    if (settings.googleClientSecret) env.GOOGLE_CLI_CLIENT_SECRET = settings.googleClientSecret

    this.append('app', `$ ${binary}  (cwd ${cwd})`)
    this.append('app', `config written to ${configFile}`)

    const child = spawn(binary, [], { cwd, env, windowsHide: true })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => this.append('out', d))
    child.stderr.on('data', (d) => this.append('err', d))

    child.on('error', (err) => {
      this.append('app', `failed to launch: ${err.message}`)
      this.child = null
      this.emit('state', this.status())
    })

    child.on('exit', (code, signal) => {
      this.child = null
      this.watchUrl = null
      this.append('app', `agent exited (${signal ? `signal ${signal}` : `code ${code}`})`)
      this.emit('state', { ...this.status(), exitCode: code })
    })

    this.emit('state', this.status())
    this.waitForWatchPanel(settings.watchPort)
    return this.status()
  }

  /// The panel binds before sign-in, so this usually resolves while the
  /// device flow is still waiting for the code.
  async waitForWatchPanel(port) {
    if (!port) return
    const url = `http://127.0.0.1:${port}/`
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (this.running && Date.now() < deadline) {
      try {
        const res = await fetch(`${url}api/npcs`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          this.watchUrl = url
          this.emit('watch-ready', url)
          return
        }
      } catch {
        // Not up yet.
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  stop() {
    if (!this.child) return this.status()
    this.stopping = true
    const child = this.child
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } else {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (this.child === child) child.kill('SIGKILL')
      }, 5000)
    }
    return this.status()
  }

  async stopAndWait() {
    if (!this.running) return this.status()
    const exited = new Promise((resolve) => this.child.once('exit', resolve))
    this.stop()
    await exited
    return this.status()
  }
}

module.exports = { AgentProcess, resolveBinary, candidateBinaries }
