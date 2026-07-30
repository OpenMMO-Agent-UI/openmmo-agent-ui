'use strict'

const RETRY_DELAYS_MS = [2000, 5000, 10000, 30000]

class PlaySessionCoordinator {
  constructor({ ai, manual, validateLlm, scheduler, onState = () => {} }) {
    this.controllers = { ai, manual }
    this.validateLlm = validateLlm
    this.scheduler = scheduler
    this.onState = onState
    this.context = null
    this.retryAttempt = 0
    this.cancelRetry = null
    this.inFlightRetry = null
    this.operationGeneration = 0
    this.state = {
      mode: null,
      phase: 'stopped',
      viewUrl: null,
      notice: null,
      retryInMs: null,
    }
  }

  snapshot() {
    return { ...this.state }
  }

  publish(patch) {
    this.state = { ...this.state, ...patch }
    this.onState(this.snapshot())
    return this.snapshot()
  }

  async enter(context) {
    await this.cancelRetryWork()
    this.context = context
    const validation = await this.validateLlm()
    if (!validation.ok) {
      const started = await this.controllers.manual.start(context)
      return this.publish({
        mode: 'manual',
        phase: 'active',
        viewUrl: started.viewUrl || null,
        notice: validation.error || 'Set up an LLM to use Automatic play',
        retryInMs: null,
      })
    }

    this.publish({ mode: 'ai', phase: 'starting', notice: null, retryInMs: null })
    try {
      const started = await this.controllers.ai.start(context)
      return this.publish({
        mode: 'ai',
        phase: 'active',
        viewUrl: started.viewUrl || null,
        notice: null,
      })
    } catch (err) {
      try {
        await this.stopController('ai')
      } catch (cleanupError) {
        return this.publish({
          mode: null,
          phase: 'disconnected',
          viewUrl: null,
          notice: `${err.message}; could not stop Automatic play: ${cleanupError.message}`,
        })
      }
      const started = await this.controllers.manual.start(context)
      return this.publish({
        mode: 'manual',
        phase: 'active',
        viewUrl: started.viewUrl || null,
        notice: err.message,
      })
    }
  }

  clearRetry() {
    if (this.cancelRetry) this.cancelRetry()
    this.cancelRetry = null
  }

  async cancelRetryWork() {
    this.clearRetry()
    this.operationGeneration++
    if (this.inFlightRetry) await this.inFlightRetry
  }

  async stopController(mode) {
    if (!mode) return
    if (mode === 'ai' && this.controllers.ai.cancelPending) {
      await this.controllers.ai.cancelPending()
    }
    await this.controllers[mode].stop()
  }

  async startController(mode) {
    const started = await this.controllers[mode].start(this.context)
    return started.viewUrl || null
  }

  async switchTo(targetMode) {
    if (targetMode !== 'ai' && targetMode !== 'manual') throw new Error('Unknown play mode')
    if (this.state.phase === 'active' && this.state.mode === targetMode) return this.snapshot()

    const priorMode = this.state.mode
    this.publish({
      phase: 'switching',
      notice: null,
      retryInMs: null,
    })
    await this.cancelRetryWork()

    try {
      await this.stopController(priorMode)
      if (targetMode === 'ai') {
        const validation = await this.validateLlm()
        if (!validation.ok) throw new Error(validation.error || 'Set up an LLM')
      }
      const viewUrl = await this.startController(targetMode)
      if (targetMode === 'ai') this.retryAttempt = 0
      return this.publish({
        mode: targetMode,
        phase: 'active',
        viewUrl,
        notice: null,
      })
    } catch (err) {
      try {
        await this.stopController(targetMode)
      } catch (cleanupError) {
        return this.publish({
          mode: null,
          phase: 'disconnected',
          viewUrl: null,
          notice: `${err.message}; could not stop ${targetMode}: ${cleanupError.message}`,
        })
      }
      if (!priorMode) {
        return this.publish({
          mode: null,
          phase: 'disconnected',
          viewUrl: null,
          notice: err.message,
        })
      }
      try {
        const viewUrl = await this.startController(priorMode)
        return this.publish({
          mode: priorMode,
          phase: 'active',
          viewUrl,
          notice: err.message,
        })
      } catch (rollbackError) {
        return this.publish({
          mode: null,
          phase: 'disconnected',
          viewUrl: null,
          notice: `${err.message}; could not restore ${priorMode}: ${rollbackError.message}`,
        })
      }
    }
  }

  controllerExited(message = 'AI disconnected') {
    if (this.state.mode !== 'ai' || this.state.phase !== 'active') return
    this.scheduleRetry(message)
  }

  scheduleRetry(message) {
    this.clearRetry()
    const generation = this.operationGeneration
    const delayMs = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)]
    this.retryAttempt++
    this.publish({
      mode: 'ai',
      phase: 'retrying',
      viewUrl: null,
      notice: message,
      retryInMs: delayMs,
    })
    this.cancelRetry = this.scheduler.schedule(() => {
      this.cancelRetry = null
      const work = this.runRetry(generation)
      this.inFlightRetry = work
      return work.finally(() => {
        if (this.inFlightRetry === work) this.inFlightRetry = null
      })
    }, delayMs)
  }

  async runRetry(generation) {
    if (generation !== this.operationGeneration) return
    this.publish({ phase: 'starting', retryInMs: null })
    try {
      // An exit or failed readiness may have left a process alive. Cleanup
      // must succeed before another Automatic-play controller is created.
      await this.stopController('ai')
      if (generation !== this.operationGeneration) return
      const viewUrl = await this.startController('ai')
      if (generation !== this.operationGeneration) {
        await this.stopController('ai')
        return
      }
      this.publish({
        mode: 'ai',
        phase: 'active',
        viewUrl,
        notice: null,
        retryInMs: null,
      })
    } catch (err) {
      try {
        await this.stopController('ai')
      } catch {
        // Retry remains indefinite even when cleanup itself reports failure.
      }
      if (generation === this.operationGeneration) this.scheduleRetry(err.message)
    }
  }

  async stop() {
    await this.cancelRetryWork()
    const mode = this.state.mode
    await this.stopController(mode)
    this.context = null
    this.retryAttempt = 0
    return this.publish({
      mode: null,
      phase: 'stopped',
      viewUrl: null,
      notice: null,
      retryInMs: null,
    })
  }
}

module.exports = { PlaySessionCoordinator, RETRY_DELAYS_MS }
