'use strict'

const { EventEmitter } = require('node:events')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const { agentDir, buildInfo, packagedSeedDir, repoRoot, writeConfig } = require('./config')

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

function candidateBinaries(
  override,
  packaged = Boolean(app?.isPackaged),
  resourcesPath = process.resourcesPath,
  root = repoRoot(),
) {
  // A packaged app's build-info.json describes the binary shipped beside it.
  // Letting a legacy binaryPath setting replace that binary makes the fatal
  // protocol diagnostic combine metadata from one build with the handshake
  // from another. Packaged builds are self-contained; overrides are a dev-only
  // escape hatch.
  if (packaged) return [path.join(resourcesPath || '', 'agent-client', EXE)]

  const list = override ? [override] : []
  list.push(path.join(root, 'target', 'release', EXE))
  list.push(path.join(root, 'target', 'debug', EXE))
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

/// `resolveBinary` only checks the path exists as a file — it would happily
/// accept a directory, a wrong-arch build, or a download the OS has
/// quarantined, all of which fail at spawn time with something like
/// "spawn ENOEXEC" once the user is already mid-session. Node's `spawn`
/// event only fires once the OS has actually exec'd the file, so it's the
/// most direct way to catch that ahead of time — a failed exec emits
/// `error` instead. Kill it the moment either fires; we only care whether
/// it started, not what it does next.
function probeBinary(binaryPath) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(binaryPath, ['--version'], { stdio: 'ignore' })
    } catch (err) {
      resolve({ ok: false, error: err.message })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: `${binaryPath} did not respond` })
    }, 3000)
    child.once('spawn', () => {
      clearTimeout(timer)
      child.kill()
      resolve({ ok: true })
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message })
    })
  })
}

class AgentProcess extends EventEmitter {
  constructor() {
    super()
    this.child = null
    this.log = []
    this.watchUrl = null
    this.stopping = false
    this.protocolWarned = false
  }

  get running() {
    return this.child !== null
  }

  status() {
    return {
      running: this.running,
      pid: this.child ? this.child.pid : null,
      watchUrl: this.watchUrl,
    }
  }

  append(stream, text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      const item = { stream, line, t: Date.now() }
      this.log.push(item)
      if (this.log.length > LOG_CAP) this.log.shift()
      this.emit('log', item)
      this.scanForProtocolMismatch(line)
    }
  }

  /// The one refusal that cannot be waited out: the server compares wire
  /// versions exactly, so a mismatch means moving the checkout. It otherwise
  /// scrolls past as a single line among the reconnect attempts it triggers —
  /// lift it out once per run, as a fatal error naming the commit to move to.
  scanForProtocolMismatch(line) {
    if (this.protocolWarned) return
    const match = line.match(/Protocol v(\d+) required, you sent v(\d+)/)
    if (!match) return
    this.protocolWarned = true
    const info = buildInfo()
    const built = info
      ? ` This build is from commit ${info.openmmoCommit} (protocol v${info.protocolVersion}).`
      : ''
    this.emit(
      'fatal',
      `The server speaks protocol v${match[1]}, this build speaks v${match[2]}.${built} ` +
        `Run "node openmmo-client/scripts/check-protocol.js" for the commit to move to.`,
    )
  }

  async start(settings) {
    if (this.running) throw new Error('Agent is already running')

    const binary = resolveBinary(settings.binaryPath)
    if (!binary) {
      throw new Error(
        `agent-client binary not found. A packaged build ships its own, so this is a dev checkout: ` +
          `build it with "cargo build --release -p agent-client", or set OPENMMO_CHECKOUT to the ` +
          `checkout holding it. Looked in:\n${candidateBinaries(settings.binaryPath).join('\n')}`,
      )
    }

    // The Locate-agent-client screen used to exec this ahead of time; with that
    // screen gone, Play is the only place left that can turn an unrunnable
    // binary into an error the user sees, rather than a bare "spawn ENOEXEC"
    // arriving in the log a moment after the UI has already said "running".
    const probe = await probeBinary(binary)
    if (!probe.ok) throw new Error(`agent-client at ${binary} will not run: ${probe.error}`)

    const cwd = agentDir()
    if (!fs.existsSync(path.join(cwd, 'data'))) {
      throw new Error(`No data/ directory next to the agent at ${cwd}`)
    }

    const configFile = writeConfig(settings)
    this.log = []
    this.watchUrl = null
    this.stopping = false
    this.protocolWarned = false

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

module.exports = { AgentProcess, candidateBinaries }
