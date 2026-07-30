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
  getInstancePrompt: (characterName) => ipcRenderer.invoke('instance:get', characterName),
  saveInstancePrompt: (characterName, text) => ipcRenderer.invoke('instance:save', characterName, text),
  signOut: () => ipcRenderer.invoke('auth:signout'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authContinue: () => ipcRenderer.invoke('auth:continue'),
  authSignIn: () => ipcRenderer.invoke('auth:signin'),
  createCharacter: (name, characterClass, gender) =>
    ipcRenderer.invoke('characters:create', { name, characterClass, gender }),
  deleteCharacter: (characterId) => ipcRenderer.invoke('characters:delete', characterId),
  sendDirective: (text) => ipcRenderer.invoke('directive:send', text),
  openView: () => ipcRenderer.invoke('view:open'),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  onLog: on('agent:log'),
  onState: on('agent:state'),
  onDeviceCode: on('auth:device-code'),
  onFatal: on('agent:fatal'),
  onWatchReady: on('watch:ready'),
  onFeed: on('agent:feed'),
  onVitals: on('agent:vitals'),
  onWorn: on('agent:worn'),
  onViewReady: on('view:ready'),
  onViewError: on('view:error'),
  onViewMemory: on('view:memory'),
})
