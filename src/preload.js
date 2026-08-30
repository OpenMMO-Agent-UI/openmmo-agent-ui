'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const on = (channel) => (handler) => {
  const listener = (_e, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

contextBridge.exposeInMainWorld('agentApp', {
  info: () => ipcRenderer.invoke('app:info'),
  dictionary: (language) => ipcRenderer.invoke('i18n:dict', language),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (input) => ipcRenderer.invoke('profiles:create', input),
  updateProfile: (id, patch) => ipcRenderer.invoke('profiles:update', id, patch),
  duplicateProfile: (id) => ipcRenderer.invoke('profiles:duplicate', id),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  selectProfile: (id) => ipcRenderer.invoke('profiles:select', id),
  testProfile: (id) => ipcRenderer.invoke('profiles:test', id),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  applySettings: (patch) => ipcRenderer.invoke('settings:apply', patch),
  validate: (patch) => ipcRenderer.invoke('settings:validate', patch),
  previewConfig: () => ipcRenderer.invoke('config:preview'),
  translateChat: (text, target) => ipcRenderer.invoke('translate:text', { text, target }),
  testTranslate: (patch) => ipcRenderer.invoke('translate:test', patch),
  start: () => ipcRenderer.invoke('agent:start'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  restart: () => ipcRenderer.invoke('agent:restart'),
  getBagLabels: (characterId) => ipcRenderer.invoke('labels:get', { characterId }),
  saveBagLabels: (characterId, characterName, labels) =>
    ipcRenderer.invoke('labels:save', { characterId, characterName, labels }),
  signOut: () => ipcRenderer.invoke('auth:signout'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authContinue: () => ipcRenderer.invoke('auth:continue'),
  authSignIn: () => ipcRenderer.invoke('auth:signin'),
  authCancel: () => ipcRenderer.invoke('auth:cancel'),
  createCharacter: (name, characterClass, gender) =>
    ipcRenderer.invoke('characters:create', { name, characterClass, gender }),
  deleteCharacter: (characterId) => ipcRenderer.invoke('characters:delete', characterId),
  enterCharacter: (character) => ipcRenderer.invoke('play:enter', character),
  switchMode: (mode) => ipcRenderer.invoke('play:switch', mode),
  manualReady: (error) => ipcRenderer.invoke('play:manual-ready', error),
  leavePlay: (destination) => ipcRenderer.invoke('play:leave', destination),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openDownloadPage: () => ipcRenderer.invoke('update:download-page'),
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
  onSkills: on('agent:skills'),
  onStats: on('agent:stats'),
  onViewReady: on('view:ready'),
  onViewError: on('view:error'),
  onViewMemory: on('view:memory'),
  onViewStop: on('view:stop'),
  onPlayState: on('play:state'),
  onUpdateState: on('update:state'),
})
