#!/usr/bin/env node

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const NPM_REGISTRY = 'https://registry.npmjs.org'

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read JSON from ${filePath}: ${error.message}`)
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

function isCommit(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)
}

function validateReleaseContext({ tag, packageName, version, tagCommit, checkedOutCommit }) {
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new Error('package.json must contain a package name')
  }

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json must contain a package version')
  }

  const expectedTag = `v${version}`
  if (tag !== expectedTag) {
    throw new Error(
      `Release tag ${tag} does not match package version ${version}; expected ${expectedTag}`
    )
  }

  if (!isCommit(tagCommit)) {
    throw new Error(`Release tag ${tag} did not resolve to a full commit SHA`)
  }

  if (!isCommit(checkedOutCommit)) {
    throw new Error('Checked out revision did not resolve to a full commit SHA')
  }

  if (tagCommit.toLowerCase() !== checkedOutCommit.toLowerCase()) {
    throw new Error(
      `Release tag ${tag} points to ${tagCommit}, but checkout is ${checkedOutCommit}`
    )
  }
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function getReleaseContext({
  tag,
  packagePath,
  mainRef,
  cwd = process.cwd(),
  runGitCommand = runGit,
}) {
  const packageJson = readJson(packagePath)
  const tagCommit = runGitCommand(['rev-parse', `${tag}^{commit}`], cwd)
  const checkedOutCommit = runGitCommand(['rev-parse', 'HEAD'], cwd)

  validateReleaseContext({
    tag,
    packageName: packageJson.name,
    version: packageJson.version,
    tagCommit,
    checkedOutCommit,
  })

  try {
    runGitCommand(['merge-base', '--is-ancestor', tagCommit, mainRef], cwd)
  } catch {
    throw new Error(`Release tag ${tag} (${tagCommit}) is not reachable from ${mainRef}`)
  }

  return {
    schemaVersion: 1,
    package: {
      name: packageJson.name,
      version: packageJson.version,
    },
    source: {
      tag,
      commit: tagCommit,
      mainRef,
      mainCommit: runGitCommand(['rev-parse', mainRef], cwd),
    },
  }
}

function getDist(metadata) {
  const dist = metadata?.dist

  if (!dist || typeof dist !== 'object') {
    throw new Error('npm metadata is missing dist information')
  }

  if (typeof dist.tarball !== 'string' || dist.tarball.length === 0) {
    throw new Error('npm metadata is missing dist.tarball')
  }

  if (typeof dist.integrity !== 'string' || dist.integrity.length === 0) {
    throw new Error('npm metadata is missing dist.integrity')
  }

  try {
    const url = new URL(dist.tarball)
    if (url.protocol !== 'https:') {
      throw new Error('not HTTPS')
    }
  } catch {
    throw new Error(`npm dist.tarball must be an HTTPS URL, received ${dist.tarball}`)
  }

  return dist
}

function validatePublishedPackage({ context, metadata }) {
  if (!context?.package || !context?.source) {
    throw new Error('Release context is missing package or source details')
  }

  if (metadata?.name && metadata.name !== context.package.name) {
    throw new Error(`npm metadata is for ${metadata.name}, expected ${context.package.name}`)
  }

  if (metadata?.version !== context.package.version) {
    throw new Error(
      `npm metadata is version ${metadata?.version || 'unknown'}, expected ${
        context.package.version
      }`
    )
  }

  if (!isCommit(metadata?.gitHead)) {
    throw new Error(
      `npm metadata for ${context.package.name}@${context.package.version} is missing a full gitHead`
    )
  }

  if (metadata.gitHead.toLowerCase() !== context.source.commit.toLowerCase()) {
    throw new Error(
      `npm ${context.package.name}@${context.package.version} has gitHead ${metadata.gitHead}, ` +
        `expected tag commit ${context.source.commit}`
    )
  }

  const dist = getDist(metadata)
  if (dist.shasum !== undefined && !/^[a-f0-9]{40}$/i.test(dist.shasum)) {
    throw new Error(`npm dist.shasum must be a SHA-1 hex digest, received ${dist.shasum}`)
  }

  return {
    gitHead: metadata.gitHead,
    dist,
  }
}

function parseIntegrity(integrity) {
  if (typeof integrity !== 'string' || integrity.trim().length === 0) {
    throw new Error('npm dist.integrity is required')
  }

  const supportedHashes = new Set(crypto.getHashes().map(hash => hash.toLowerCase()))
  const entries = integrity
    .trim()
    .split(/\s+/)
    .map(token => {
      const match = token.match(/^([a-z0-9-]+)-([A-Za-z0-9+/]+={0,2})$/i)
      if (!match) {
        throw new Error(`Unsupported npm dist.integrity token: ${token}`)
      }

      return {
        algorithm: match[1].toLowerCase(),
        digest: match[2],
      }
    })

  const usableEntries = entries.filter(entry => supportedHashes.has(entry.algorithm))
  if (usableEntries.length === 0) {
    throw new Error(`No supported hash algorithm found in npm dist.integrity: ${integrity}`)
  }

  return usableEntries
}

function verifyTarball({ tarballPath, integrity, shasum }) {
  const content = fs.readFileSync(tarballPath)
  const integrityEntries = parseIntegrity(integrity)
  const matchingIntegrity = integrityEntries.find(entry => {
    const actual = crypto.createHash(entry.algorithm).update(content).digest('base64')
    return actual === entry.digest
  })

  if (!matchingIntegrity) {
    throw new Error(`Tarball ${tarballPath} does not match npm dist.integrity`)
  }

  const sha1 = crypto.createHash('sha1').update(content).digest('hex')
  if (shasum && sha1.toLowerCase() !== shasum.toLowerCase()) {
    throw new Error(`Tarball ${tarballPath} does not match npm dist.shasum`)
  }

  return {
    size: content.byteLength,
    sha1,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    sha512: crypto.createHash('sha512').update(content).digest('hex'),
    integrityAlgorithm: matchingIntegrity.algorithm,
  }
}

function normalizeRepository(repository) {
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new Error('A source repository URL is required')
  }

  return repository.replace(/\/$/, '')
}

function createProvenance({ context, metadata, tarballPath, sourceRepository, generatedAt }) {
  const { gitHead, dist } = validatePublishedPackage({ context, metadata })
  const artifact = verifyTarball({
    tarballPath,
    integrity: dist.integrity,
    shasum: dist.shasum,
  })

  return {
    schemaVersion: 1,
    generatedAt: generatedAt || new Date().toISOString(),
    package: context.package,
    source: {
      repository: normalizeRepository(sourceRepository),
      tag: context.source.tag,
      commit: context.source.commit,
      mainRef: context.source.mainRef,
      mainCommit: context.source.mainCommit,
    },
    npm: {
      registry: NPM_REGISTRY,
      gitHead,
      tarball: dist.tarball,
      integrity: dist.integrity,
      shasum: dist.shasum || null,
    },
    artifact: {
      file: path.basename(tarballPath),
      ...artifact,
    },
  }
}

function formatReleaseNotes(provenance) {
  const { package: packageInfo, source, artifact } = provenance
  const sourceUrl = `${source.repository}/tree/${encodeURIComponent(source.tag)}`
  const commitUrl = `${source.repository}/commit/${source.commit}`
  const npmUrl = `https://www.npmjs.com/package/${packageInfo.name}/v/${packageInfo.version}`

  return `## Package

- npm: [\`${packageInfo.name}@${packageInfo.version}\`](${npmUrl})
- source: [\`${source.tag}\`](${sourceUrl})
- commit: [\`${source.commit}\`](${commitUrl})

## Provenance

The attached \`${
    artifact.file
  }\` was downloaded from the npm registry after publication and verified against its published \`dist.integrity\`${
    provenance.npm.shasum ? ' and `dist.shasum`' : ''
  } metadata. \`release-provenance.json\` records the source commit, registry metadata, and artifact hashes.
`
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}

  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]

    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected an option and value, received ${key || 'nothing'}`)
    }

    options[key.slice(2)] = value
  }

  return { command, options }
}

function requireOption(options, name) {
  if (!options[name]) {
    throw new Error(`Missing required --${name} option`)
  }

  return options[name]
}

function readContext(filePath) {
  return readJson(filePath)
}

function main(argv = process.argv.slice(2), env = process.env) {
  const { command, options } = parseArgs(argv)

  if (command === 'validate-release') {
    const context = getReleaseContext({
      tag: requireOption(options, 'tag'),
      packagePath: requireOption(options, 'package'),
      mainRef: requireOption(options, 'main-ref'),
    })
    writeJson(requireOption(options, 'output'), context)
    console.log(`Validated ${context.source.tag} at ${context.source.commit}`)
    return
  }

  if (command === 'validate-published-package') {
    const context = readContext(requireOption(options, 'release-context'))
    const metadata = readJson(requireOption(options, 'npm-metadata'))
    const { gitHead } = validatePublishedPackage({ context, metadata })
    console.log(`Verified npm gitHead ${gitHead}`)
    return
  }

  if (command === 'tarball-url') {
    const context = readContext(requireOption(options, 'release-context'))
    const metadata = readJson(requireOption(options, 'npm-metadata'))
    const { dist } = validatePublishedPackage({ context, metadata })
    process.stdout.write(`${dist.tarball}\n`)
    return
  }

  if (command === 'create-provenance') {
    const context = readContext(requireOption(options, 'release-context'))
    const metadata = readJson(requireOption(options, 'npm-metadata'))
    const provenance = createProvenance({
      context,
      metadata,
      tarballPath: requireOption(options, 'tarball'),
      sourceRepository:
        options['source-repository'] ||
        (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
          ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`
          : ''),
    })

    writeJson(requireOption(options, 'output'), provenance)
    if (options['notes-output']) {
      writeText(options['notes-output'], formatReleaseNotes(provenance))
    }
    console.log(`Created provenance for ${provenance.package.name}@${provenance.package.version}`)
    return
  }

  throw new Error(`Unknown command: ${command || 'none'}`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  NPM_REGISTRY,
  createProvenance,
  formatReleaseNotes,
  getReleaseContext,
  getDist,
  parseIntegrity,
  validatePublishedPackage,
  validateReleaseContext,
  verifyTarball,
}
