#!/usr/bin/env node
/**
 * Regenerate release/latest.yml from the NSIS installer on disk.
 * electron-builder can emit channel metadata that does not match the uploaded
 * HandCash-Setup-*.exe (false sha512 on Windows OTA). CI runs this after build.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = process.argv[2] || pkg.version
const fileName = `HandCash-Setup-${version}.exe`
const installerPath = path.join(root, 'release', fileName)

if (!fs.existsSync(installerPath)) {
  console.error(`Installer not found: ${installerPath}`)
  process.exit(1)
}

const bytes = fs.readFileSync(installerPath)
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')
const releaseDate = new Date().toISOString()

const yml = [
  `version: ${version}`,
  'files:',
  `  - url: ${fileName}`,
  `    sha512: ${sha512}`,
  `    size: ${bytes.length}`,
  `path: ${fileName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n')

const outPath = path.join(root, 'release', 'latest.yml')
fs.writeFileSync(outPath, yml)
console.log(`Wrote ${outPath}`)
console.log(`  ${fileName}  size=${bytes.length}  sha512=${sha512}`)
