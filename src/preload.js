'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const on = (channel) => (handler) => {
  const listener = (_e, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

contextBridge.exposeInMainWorld('agentApp', {
  info: () => ipcRenderer.invoke('app:info'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  validate: (patch) => ipcRenderer.invoke('settings:validate', patch),
  previewConfig: () => ipcRenderer.invoke('config:preview'),
  start: () => ipcRenderer.invoke('agent:start'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  restart: () => ipcRenderer.invoke('agent:restart'),
  getPrompt: () => ipcRenderer.invoke('prompt:get'),
  savePrompt: (text) => ipcRenderer.invoke('prompt:save', text),
  loadPreset: (name) => ipcRenderer.invoke('prompt:preset', name),
  systemPrompt: () => ipcRenderer.invoke('prompt:system'),
  pickBinary: () => ipcRenderer.invoke('binary:pick'),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  onLog: on('agent:log'),
  onState: on('agent:state'),
  onDeviceCode: on('agent:device-code'),
  onWatchReady: on('watch:ready'),
  onFeed: on('agent:feed'),
  onVitals: on('agent:vitals'),
  onViewReady: on('view:ready'),
  onViewError: on('view:error'),
})
