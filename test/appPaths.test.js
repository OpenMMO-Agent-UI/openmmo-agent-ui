const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { preserveLegacyUserData } = require('../src/appPaths')

test('product rename preserves the existing Electron user-data directory', () => {
  const appData = path.join(path.parse(process.cwd()).root, 'profiles')
  const calls = []
  const app = {
    getPath(name) {
      assert.equal(name, 'appData')
      return appData
    },
    setPath(name, value) {
      calls.push([name, value])
    },
  }

  const result = preserveLegacyUserData(app)
  const expected = path.join(appData, 'OpenMMO Agent')

  assert.equal(result, expected)
  assert.deepEqual(calls, [['userData', expected]])
})
