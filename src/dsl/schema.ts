import {
  ColumnBuilder,
  ColumnDefinition,
  EnumDefinition,
  KnexSchema,
  SchemaInput,
  TableBuilder,
} from './types'
import { assertValidSchema } from './validation'

export function defineSchema(input: SchemaInput): KnexSchema {
  const schema: KnexSchema = {
    database: input.database,
    generator: {
      typesFile: 'types.ts',
      knexTypesFile: 'knex-tables.d.ts',
      ...input.generator,
    },
    enums: input.enums ?? {},
    tables: Object.fromEntries(
      Object.entries(input.tables).map(([modelName, table]) => {
        const definition = table instanceof TableBuilder ? table.toDefinition(modelName) : table
        return [
          modelName,
          {
            ...definition,
            modelName,
          },
        ]
      }),
    ),
  }

  assertValidSchema(schema)
  return schema
}

export const pg = {
  enum(name: string, values: string[]): EnumDefinition {
    return { kind: 'enum', name, values }
  },

  table(name: string, columns: Record<string, ColumnBuilder | ColumnDefinition>) {
    return new TableBuilder(name, columns)
  },

  bigint() {
    return new ColumnBuilder('bigint')
  },

  bigIncrements() {
    return new ColumnBuilder('bigIncrements')
  },

  bigInteger() {
    return new ColumnBuilder('bigInteger')
  },

  binary(length?: number) {
    return new ColumnBuilder('binary', { length })
  },

  boolean() {
    return new ColumnBuilder('boolean')
  },

  date() {
    return new ColumnBuilder('date')
  },

  dateTime(options: { useTz?: boolean; precision?: number } = {}) {
    return new ColumnBuilder('dateTime', options)
  },

  datetime(options: { useTz?: boolean; precision?: number } = {}) {
    return new ColumnBuilder('dateTime', options)
  },

  decimal(precision?: number, scale?: number) {
    return new ColumnBuilder('decimal', { precision, scale })
  },

  double(precision?: number, scale?: number) {
    return new ColumnBuilder('double', { precision, scale })
  },

  enumRef(enumName: string) {
    return new ColumnBuilder('enum', { enumName })
  },

  enu(values: string[]) {
    return new ColumnBuilder('enu', { enumValues: values })
  },

  float() {
    return new ColumnBuilder('float')
  },

  geography() {
    return new ColumnBuilder('geography')
  },

  geometry() {
    return new ColumnBuilder('geometry')
  },

  increments() {
    return new ColumnBuilder('increments')
  },

  integer() {
    return new ColumnBuilder('integer')
  },

  json() {
    return new ColumnBuilder('json')
  },

  jsonb() {
    return new ColumnBuilder('jsonb')
  },

  jsonbArray() {
    return new ColumnBuilder('jsonbArray')
  },

  mediumint() {
    return new ColumnBuilder('mediumint')
  },

  point() {
    return new ColumnBuilder('point')
  },

  serial() {
    return new ColumnBuilder('serial')
  },

  smallint() {
    return new ColumnBuilder('smallint')
  },

  specificType(type: string) {
    return new ColumnBuilder('specificType', { specificType: type })
  },

  string(length?: number) {
    return new ColumnBuilder('string', { length })
  },

  text(textType?: string) {
    return new ColumnBuilder('text', { textType })
  },

  textArray() {
    return new ColumnBuilder('textArray')
  },

  time() {
    return new ColumnBuilder('time')
  },

  timestamp() {
    return new ColumnBuilder('timestamp')
  },

  timestampTz(precision?: number) {
    return new ColumnBuilder('timestamp', { precision, useTz: true })
  },

  tinyint(length?: number) {
    return new ColumnBuilder('tinyint', { length })
  },

  uuid() {
    return new ColumnBuilder('uuid')
  },
}

export const sql = pg
