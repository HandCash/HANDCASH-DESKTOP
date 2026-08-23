#!/usr/bin/env node
/** Fail if release/latest.yml sha512 does not match the referenced installer. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseYml(text) {
  const pathMatch = text.match(/^path:\s*(.+)$/m)
  const versionMatch = text.match(/^version:\s*(.+)$/m)
  const shaMatches = [...text.matchAll(/^ {0,4}sha512:\s*(.+)$/gm)]
  if (!pathMatch || !versionMatch || shaMatches.length === 0) {
    throw new Error('latest.yml missing path, version, or sha512')
  }
  return {
    version: versionMatch[1].trim(),
    file: pathMatch[1].trim(),
    sha512: shaMatches[shaMatches.length - 1][1].trim(),
  }
}

const ymlPath = path.join(root, 'release', 'latest.yml')
if (!fs.existsSync(ymlPath)) {
  console.error(`Missing ${ymlPath}`)
  process.exit(1)
}

const meta = parseYml(fs.readFileSync(ymlPath, 'utf8'))
const installerPath = path.join(root, 'release', meta.file)
if (!fs.existsSync(installerPath)) {
  console.error(`Installer referenced by latest.yml not found: ${installerPath}`)
  process.exit(1)
}

const bytes = fs.readFileSync(installerPath)
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')

if (sha512 !== meta.sha512) {
  console.error('latest.yml does not match installer on disk:')
  console.error(`  yml sha512: ${meta.sha512}`)
  console.error(`  exe sha512: ${sha512}`)
  console.error(`  exe size:   ${bytes.length}`)
  process.exit(1)
}

console.log(`latest.yml OK for ${meta.file} (v${meta.version}, ${bytes.length} bytes)`)
