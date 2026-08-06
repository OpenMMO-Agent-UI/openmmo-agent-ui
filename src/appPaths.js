'use strict'

const path = require('node:path')

const LEGACY_USER_DATA_NAME = 'OpenMMO Agent'

function preserveLegacyUserData(app) {
  const userData = path.join(app.getPath('appData'), LEGACY_USER_DATA_NAME)
  app.setPath('userData', userData)
  return userData
}

module.exports = { LEGACY_USER_DATA_NAME, preserveLegacyUserData }
