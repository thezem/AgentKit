import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repoRoot = path.resolve(import.meta.dirname, '..')
const packageJsonPath = path.join(repoRoot, 'package.json')
const distDir = path.join(repoRoot, 'dist')

function runNpm(args: string[], cwd = repoRoot): string {
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], {
      cwd,
      encoding: 'utf8',
    })
  }

  return execFileSync('npm', args, {
    cwd,
    encoding: 'utf8',
  })
}

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
}

test('build emits publishable runtime and type output under dist', () => {
  rmSync(distDir, { recursive: true, force: true })

  runNpm(['run', 'build'])

  assert.equal(existsSync(path.join(distDir, 'index.js')), true)
  assert.equal(existsSync(path.join(distDir, 'index.d.ts')), true)
  assert.equal(existsSync(path.join(distDir, 'compat', 'codex.js')), true)
  assert.equal(existsSync(path.join(distDir, 'compat', 'codex.d.ts')), true)

  const entrypoint = readFileSync(path.join(distDir, 'index.js'), 'utf8')
  assert.doesNotMatch(entrypoint, /\.\/codex-client\.js/)
  assert.doesNotMatch(entrypoint, /\.\/codex-client\.ts/)

  const compatEntrypoint = readFileSync(path.join(distDir, 'compat', 'codex.js'), 'utf8')
  assert.match(compatEntrypoint, /\.\.\/codex-client\.js/)
  assert.doesNotMatch(compatEntrypoint, /\.\.\/codex-client\.ts/)
})

test('package metadata points consumers at dist output', () => {
  const pkg = readPackageJson()
  const scripts = pkg.scripts as Record<string, unknown>

  assert.equal(pkg.license, 'MIT')
  assert.deepEqual(pkg.repository, {
    type: 'git',
    url: 'git+https://github.com/thezem/AgentKit.git',
  })
  assert.equal(pkg.homepage, 'https://github.com/thezem/AgentKit#readme')
  assert.deepEqual(pkg.bugs, {
    url: 'https://github.com/thezem/AgentKit/issues',
  })
  assert.equal(pkg.main, './dist/index.js')
  assert.equal(pkg.types, './dist/index.d.ts')
  assert.deepEqual(pkg.exports, {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
    },
    './compat/codex': {
      types: './dist/compat/codex.d.ts',
      import: './dist/compat/codex.js',
    },
  })
  assert.ok(typeof pkg.scripts === 'object' && pkg.scripts !== null)
  assert.equal(scripts.build, 'tsc -p tsconfig.build.json')
  assert.equal(scripts['example:agent:t3code'], 'node --experimental-strip-types examples/agent-t3code.ts')
  assert.equal(
    scripts['example:agent:t3code:ask'],
    'node --experimental-strip-types examples/agent-t3code-ask.ts',
  )
  assert.equal(scripts.prepublishOnly, 'npm run build')
})

test('npm pack publishes dist output and excludes source-only directories', () => {
  rmSync(distDir, { recursive: true, force: true })
  runNpm(['run', 'build'])

  const packDir = mkdtempSync(path.join(tmpdir(), 'agentkit-pack-'))

  try {
    const json = runNpm(['pack', '--json', '--pack-destination', packDir])
    const [result] = JSON.parse(json) as Array<{
      files: Array<{ path: string }>
      filename: string
    }>

    assert.ok(result)

    const packedFiles = result.files.map((file) => file.path).sort()

    assert.ok(packedFiles.includes('dist/index.js'))
    assert.ok(packedFiles.includes('dist/index.d.ts'))
    assert.ok(packedFiles.includes('dist/compat/codex.js'))
    assert.ok(packedFiles.includes('dist/compat/codex.d.ts'))
    assert.ok(packedFiles.includes('LICENSE'))
    assert.equal(packedFiles.some((file) => file.startsWith('src/')), false)
    assert.equal(packedFiles.some((file) => file.startsWith('test/')), false)
    assert.equal(packedFiles.some((file) => file.startsWith('docs/')), false)
    assert.equal(packedFiles.some((file) => file.startsWith('examples/')), false)

    const tarballs = readdirSync(packDir).filter((file) => file.endsWith('.tgz'))
    assert.ok(tarballs.includes(result.filename))
  } finally {
    rmSync(packDir, { recursive: true, force: true })
  }
})
