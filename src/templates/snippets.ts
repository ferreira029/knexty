export function vscodeSnippets() {
  return JSON.stringify(
    {
      'Knex schema table': {
        prefix: 'ks-table',
        body: [
          "${1:table_name}: sql.table('${1:table_name}', {",
          '  id: sql.increments().primaryKey(),',
          "  token: sql.uuid().unique().defaultUuid(),",
          "  createdAt: sql.timestamp().defaultNow(),",
          "  updatedAt: sql.timestamp().updatedAt(),",
          '})',
        ],
        description: 'Create a knexty table definition',
      },
      'Knex schema enum': {
        prefix: 'ks-enum',
        body: ["${1:enum_name}: sql.enum('${1:enum_name}', ['${2:VALUE}']),"],
        description: 'Create a native enum definition',
      },
      'Knex schema foreign key': {
        prefix: 'ks-fk',
        body: ["${1:table_id}: sql.integer().references('${2:table_name}.id')"],
        description: 'Create an integer foreign key column',
      },
      'Knex migration command': {
        prefix: 'ks-migration',
        body: ['npm run db:migration:make -- ${1:migration_name}'],
        description: 'Create a schema-first Knex migration',
      },
      'Knex select': {
        prefix: 'ks-select',
        body: [
          "const ${1:rows} = await db('${2:table_name}')",
          "  .select('${3:id}')",
          '  .where({ ${4:id}: ${5:value} })',
        ],
        description: 'Typed Knex select query',
      },
      'Knex insert': {
        prefix: 'ks-insert',
        body: [
          "await db('${1:table_name}').insert({",
          '  ${2:field}: ${3:value},',
          '})',
        ],
        description: 'Typed Knex insert query',
      },
      'Knex transaction': {
        prefix: 'ks-tx',
        body: [
          'await db.transaction(async (trx) => {',
          "  await trx('${1:table_name}').insert({ ${2:field}: ${3:value} })",
          '})',
        ],
        description: 'Typed Knex transaction',
      },
    },
    null,
    2,
  )
}
