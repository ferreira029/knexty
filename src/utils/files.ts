import fs from 'fs'
import path from 'path'

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

export function writeTextFile(filePath: string, content: string) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content)
}

export function readJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

export function writeJsonFile(filePath: string, value: unknown) {
  writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export function toPosixPath(value: string) {
  return value.split(path.sep).join('/')
}
