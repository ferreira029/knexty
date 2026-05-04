import path from 'path'
import { KnexSchema } from '../dsl'
import { readJsonFile, writeJsonFile } from '../utils/files'

const SNAPSHOT_FILE = 'schema.snapshot.json'

export function snapshotPath(dir: string) {
  return path.join(dir, SNAPSHOT_FILE)
}

export function readSnapshot(dir: string) {
  return readJsonFile<KnexSchema>(snapshotPath(dir))
}

export function writeSnapshot(dir: string, schema: KnexSchema) {
  writeJsonFile(snapshotPath(dir), schema)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  writeJsonFile(path.join(dir, `${stamp}.snapshot.json`), schema)
}
