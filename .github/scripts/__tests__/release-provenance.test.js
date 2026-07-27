const assert = require('assert').strict
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = global.test || require('node:test')

const {
  createProvenance,
  formatReleaseNotes,
  getReleaseContext,
  validatePublishedPackage,
  validateReleaseContext,
  verifyTarball,
} = require('../release-provenance')

const commit = 'a'.repeat(40)
const context = {
  schemaVersion: 1,
  package: {
    name: '@wangeditor-next/editor-for-vue',
    version: '6.0.0',
  },
  source: {
    tag: 'v6.0.0',
    commit,
    mainRef: 'origin/main',
    mainCommit: 'b'.repeat(40),
  },
}

function createMetadata(content) {
  return {
    name: '@wangeditor-next/editor-for-vue',
    version: '6.0.0',
    gitHead: commit,
    dist: {
      tarball:
        'https://registry.npmjs.org/@wangeditor-next/editor-for-vue/-/editor-for-vue-6.0.0.tgz',
      integrity: `sha512-${crypto.createHash('sha512').update(content).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(content).digest('hex'),
    },
  }
}

function writeTarball(content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-provenance-'))
  const tarballPath = path.join(directory, 'editor-for-vue-6.0.0.tgz')
  fs.writeFileSync(tarballPath, content)
  return tarballPath
}

test('requires the release tag, checkout, and package version to agree', () => {
  assert.doesNotThrow(() => {
    validateReleaseContext({
      tag: 'v6.0.0',
      packageName: '@wangeditor-next/editor-for-vue',
      version: '6.0.0',
      tagCommit: commit,
      checkedOutCommit: commit,
    })
  })

  assert.throws(
    () =>
      validateReleaseContext({
        tag: 'v6.0.1',
        packageName: '@wangeditor-next/editor-for-vue',
        version: '6.0.0',
        tagCommit: commit,
        checkedOutCommit: commit,
      }),
    /does not match package version/
  )

  assert.throws(
    () =>
      validateReleaseContext({
        tag: 'v6.0.0',
        packageName: '@wangeditor-next/editor-for-vue',
        version: '6.0.0',
        tagCommit: commit,
        checkedOutCommit: 'b'.repeat(40),
      }),
    /points to/
  )
})

test('rejects a release tag that is not reachable from main', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-context-'))
  const packagePath = path.join(directory, 'package.json')
  fs.writeFileSync(
    packagePath,
    JSON.stringify({
      name: '@wangeditor-next/editor-for-vue',
      version: '6.0.0',
    })
  )

  assert.throws(
    () =>
      getReleaseContext({
        tag: 'v6.0.0',
        packagePath,
        mainRef: 'origin/main',
        runGitCommand(args) {
          if (args[0] === 'merge-base') {
            throw new Error('not an ancestor')
          }
          if (args[1] === 'HEAD' || args[1].endsWith('^{commit}')) {
            return commit
          }
          return 'b'.repeat(40)
        },
      }),
    /not reachable from origin\/main/
  )
})

test('permits a rerun only when npm gitHead matches the tagged commit', () => {
  const metadata = createMetadata(Buffer.from('published npm package'))
  assert.equal(validatePublishedPackage({ context, metadata }).gitHead, commit)

  assert.throws(
    () =>
      validatePublishedPackage({
        context,
        metadata: {
          ...metadata,
          gitHead: 'c'.repeat(40),
        },
      }),
    /expected tag commit/
  )
})

test('rejects a downloaded tarball whose registry hash does not match', () => {
  const tarballPath = writeTarball(Buffer.from('expected package'))
  const metadata = createMetadata(Buffer.from('different package'))

  assert.throws(
    () =>
      verifyTarball({
        tarballPath,
        integrity: metadata.dist.integrity,
        shasum: metadata.dist.shasum,
      }),
    /does not match npm dist.integrity/
  )
})

test('records source, npm metadata, and verified artifact hashes', () => {
  const content = Buffer.from('published npm package')
  const tarballPath = writeTarball(content)
  const metadata = createMetadata(content)
  const provenance = createProvenance({
    context,
    metadata,
    tarballPath,
    sourceRepository: 'https://github.com/wangeditor-next/wangEditor-for-vue3',
    generatedAt: '2026-07-27T00:00:00.000Z',
  })

  assert.equal(provenance.source.tag, 'v6.0.0')
  assert.equal(provenance.npm.gitHead, commit)
  assert.equal(
    provenance.artifact.sha256,
    crypto.createHash('sha256').update(content).digest('hex')
  )
  assert.match(formatReleaseNotes(provenance), /release-provenance\.json/)
  assert.match(formatReleaseNotes(provenance), /`dist\.integrity` and `dist\.shasum`/)
})
