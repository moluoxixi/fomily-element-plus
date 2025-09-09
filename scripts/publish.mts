import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

type VersionBump = 'major' | 'minor' | 'patch'

/** 返回：版本号提升结果 */
interface BumpResult {
  skipped: boolean
  version?: string
  name?: string
  prevVersion?: string
}

/** 返回：命令行解析结果 */
interface ParsedArgs {
  bumpType: VersionBump
  dryRun: boolean
  filters: string[]
}

/** 返回：发布是否成功 */
type PublishResult = boolean

/**
 * 获取下一个版本号
 * @param currentVersion 当前版本号
 * @param type 版本类型：major, minor, patch
 * @returns 下一个版本号
 */
export function getNextVersion(
  currentVersion: string,
  type: VersionBump = 'patch'
): string {
  const [major, minor, patch] = String(currentVersion).split('.').map(Number)

  let newMajor = major
  let newMinor = minor
  let newPatch = patch

  switch (type) {
    case 'major':
      newMajor++
      newMinor = 0
      newPatch = 0
      break
    case 'minor':
      newMinor++
      newPatch = 0
      break
    default:
      newPatch++
      break
  }

  return `${newMajor}.${newMinor}.${newPatch}`
}

/**
 * 读取并解析 JSON 文件
 * @param filePath 文件路径
 * @returns 解析后的对象
 */
function readJSON<T = any>(filePath: string): T {
  const content = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(content) as T
}

/**
 * 将对象写入到 JSON 文件（带 2 空格缩进并末尾换行）
 * @param filePath 文件路径
 * @param data 要写入的数据
 */
function writeJSON(filePath: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2) + '\n'
  fs.writeFileSync(filePath, content, 'utf8')
}

/**
 * 查找 packages/* 目录中的包目录（含 package.json）
 * @param rootDir 仓库根目录
 * @returns 包目录的绝对路径数组
 */
function findPackageDirs(rootDir: string): string[] {
  const packagesDir = path.join(rootDir, 'packages')
  if (!fs.existsSync(packagesDir)) return []
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(packagesDir, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
}

/**
 * 提升包的版本号（默认仅预览时不落盘）
 * @param pkgDir 包目录
 * @param type 提升类型
 * @param dryRun 是否为预览
 * @returns 版本提升结果
 */
function bumpPackageVersion(pkgDir: string, type: VersionBump, dryRun: boolean): BumpResult {
  const pkgPath = path.join(pkgDir, 'package.json')
  const pkg = readJSON<Record<string, any>>(pkgPath)

  if (pkg.private) {
    console.log(`跳过（私有包）：${pkg.name || pkgDir}`)
    return { skipped: true }
  }

  if (!pkg.version) {
    console.warn(`跳过（无 version 字段）：${pkg.name || pkgDir}`)
    return { skipped: true }
  }

  const next = getNextVersion(pkg.version as string, type)
  const prev = pkg.version
  pkg.version = next
  writeJSON(pkgPath, pkg)
  console.log(dryRun
    ? `预览版本更新（已写入）：${pkg.name} ${prev} -> ${next}`
    : `版本更新：${pkg.name} ${prev} -> ${next}`
  )
  return { skipped: false, version: String(next), name: String(pkg.name), prevVersion: String(prev) }
}

/**
 * 回滚包的版本号到发布前
 * @param pkgDir 包目录
 * @param prevVersion 回滚到的版本
 * @returns 是否回滚成功
 */
function rollbackPackageVersion(pkgDir: string, prevVersion: string): boolean {
  try {
    const pkgPath = path.join(pkgDir, 'package.json')
    const pkg = readJSON<Record<string, any>>(pkgPath)
    const current = String(pkg.version || '')
    pkg.version = prevVersion
    writeJSON(pkgPath, pkg)
    console.warn(`已回滚版本：${pkg.name || pkgDir} ${current} -> ${prevVersion}`)
    return true
  } catch (err) {
    console.error(`回滚版本失败：${pkgDir}`)
    console.error(err)
    return false
  }
}

/**
 * 发布单个包；预览模式下仅执行 npm pack --dry-run
 * 发布模式下先执行 npm publish --dry-run 预检，再执行 pnpm publish
 * @param pkgDir 包目录
 * @param dryRun 是否为预览
 * @returns 是否成功
 */
function publishPackage(pkgDir: string, dryRun: boolean): PublishResult {
  const pkg = readJSON<Record<string, any>>(path.join(pkgDir, 'package.json'))
  const displayName = (pkg.name as string) || pkgDir
  console.log(dryRun ? `开始打包预览（dry-run）：${displayName}` : `开始发布：${displayName}`)

  let result
  if (dryRun) {
    // 仅打包预览：npm pack --dry-run
    result = spawnSync('npm', ['publish', '--dry-run'], {
      cwd: pkgDir,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
  } else {
    // 先用 npm publish --dry-run 做预发布校验（含“是否已发布”的校验）
    const precheck = spawnSync('npm', ['publish', '--dry-run'], {
      cwd: pkgDir,
      stdio: 'pipe',
      shell: process.platform === 'win32'
    })
    if (precheck.status !== 0) {
      console.error(`预发布校验失败：${displayName}`)
      return false
    }
    // 校验通过后再用 pnpm 发布
    result = spawnSync('pnpm', ['publish --registry https://registry.npmjs.org/'], {
      cwd: pkgDir,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
  }

  if (result.status !== 0) {
    console.error(`发布失败：${displayName}`)
    return false
  }
  console.log(dryRun ? `打包预览成功：${displayName}` : `发布成功：${displayName}`)
  return true
}

/**
 * 解析命令行参数
 * 支持：major/minor/patch、--dry-run、--filter=a,b
 * @param argv 传入参数（不含前置 node 与脚本路径）
 * @returns 解析结果
 */
function parseArgs(argv: string[]): ParsedArgs {
  let bumpType: VersionBump = 'patch'
  let dryRun = false
  const filters: string[] = []

  for (const token of argv) {
    if (token === '--dry-run' || token === '-d') {
      dryRun = true
      continue
    }
    if (token.startsWith('--filter=')) {
      const val = token.slice('--filter='.length).trim()
      if (val) filters.push(...val.split(',').map((s) => s.trim()).filter(Boolean))
      continue
    }
    if (token === '--filter') {
      // 下一个参数当作值（由调用方保证）
      // 这里不处理，保持简单：推荐使用 --filter=name 或逗号分隔
      continue
    }
    if (token === 'major' || token === 'minor' || token === 'patch') {
      bumpType = token
      continue
    }
  }

  return { bumpType, dryRun, filters }
}

/**
 * 主流程：选择目标包 -> 提升版本号 -> 预览/发布
 */
function main() {
  const rootDir = process.cwd()
  const { bumpType, dryRun, filters } = parseArgs(process.argv.slice(2))

  console.log(`将对 packages/* 进行版本号 +1 并发布（类型：${bumpType}，dryRun: ${dryRun}）`)
  if (filters.length > 0) {
    console.log(`过滤条件：${filters.join(', ')}`)
  }

  const pkgDirs = findPackageDirs(rootDir)
  if (pkgDirs.length === 0) {
    console.log('未发现 packages/* 包')
    process.exit(0)
  }

  const targetDirs = pkgDirs.filter((dir) => {
    if (filters.length === 0) return true
    try {
      const pkg = readJSON<Record<string, any>>(path.join(dir, 'package.json'))
      const name: string = pkg.name || path.basename(dir)
      return filters.some((f) => name.includes(f) || path.basename(dir).includes(f))
    } catch {
      return false
    }
  })
  if (targetDirs.length === 0) {
    console.log('根据过滤条件未匹配到任何包')
    process.exit(0)
  }

  const results: Array<{ dir: string; ok: boolean; skipped: boolean }> = []

  for (const dir of targetDirs) {
    try {
      const bump = bumpPackageVersion(dir, bumpType, dryRun)
      if (bump.skipped) {
        results.push({ dir, ok: true, skipped: true })
        continue
      }
      const ok = publishPackage(dir, dryRun)
      results.push({ dir, ok, skipped: false })
      if (dryRun && bump.prevVersion) {
        // 预览完成后始终回滚
        rollbackPackageVersion(dir, bump.prevVersion)
      } else if (!dryRun && !ok && bump.prevVersion) {
        // 真实发布失败回滚
        rollbackPackageVersion(dir, bump.prevVersion)
      }
    } catch (e) {
      console.error(`处理失败：${dir}`)
      console.error(e)
      results.push({ dir, ok: false, skipped: false })
    }
  }

  const failed = results.filter((r) => r.ok === false)
  const succeeded = results.filter((r) => r.ok === true && !r.skipped)
  const skipped = results.filter((r) => r.skipped)

  console.log('—— 发布结果 ——')
  console.log(`成功：${succeeded.length}`)
  console.log(`跳过：${skipped.length}`)
  console.log(`失败：${failed.length}`)

  process.exit(failed.length > 0 ? 1 : 0)
}

// 作为 CLI 直接执行
main()


