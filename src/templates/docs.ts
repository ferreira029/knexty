export function claudeMd() {
  return `# CLAUDE.md

This project uses knexty for new SQL schema work.

## Rules
- Treat \`database/postgres.schema.knex.ts\` as the source of truth for Postgres schema changes.
- Do not add new Prisma models or Prisma migrations for Postgres unless the migration plan explicitly says so.
- Use Knex directly for new database code; do not create a Prisma-compatible abstraction.
- Prefer snake_case names for physical tables, columns, enums, indexes, constraints, and new SQL-facing objects.
- After editing the schema, run \`npm run db:generate\` and \`npm run db:migration:make -- <name>\`.
- Run \`npm run db:baseline\` only once for an existing database or when intentionally resetting the local schema snapshot.
- Generated migrations should use Knex schema builder for structure; one \`*.up.sql\` and one \`*.down.sql\` sidecar per migration are expected for Postgres-only objects when \`migrationSqlMode: 'files'\` is enabled.
- Destructive changes require a manual migration and reviewer approval.

## Query Style
- Import the shared client from \`src/database/postgres\`.
- Prefer explicit joins and selected columns.
- Use generated table names and types from \`src/database/generated/postgres\`.
- Keep Prisma and Knex side by side during migration; migrate one repository/service at a time.
`
}

export function agentMd() {
  return `# AGENT.md

## Knexty Workflow
1. Edit \`database/postgres.schema.knex.ts\`.
2. Generate types with \`npm run db:generate\`.
3. Create a migration with \`npm run db:migration:make -- descriptive_name\`.
4. Review the generated migration before applying it.
5. Apply locally with \`npm run db:migrate\`.

## Safety
- Do not hand-edit generated files under \`src/database/generated/postgres\`.
- Do not remove enum values, columns, or tables through automatic diff. Write a manual migration.
- Prisma remains available only for existing code paths during the transition.
- New database access should use Knex from \`src/database/postgres.ts\`.
- Use snake_case table, column, and enum names in Knex queries, for example \`db('job_listing').select('created_at')\`.
- If a migration has \`migrations/postgres/sql/*.sql\` sidecars, keep the matching \`*.up.sql\` and \`*.down.sql\` files with the \`.ts\` migration; they are part of the migration.

## Examples
\`\`\`ts
import db from './database/postgres'

const rows = await db('user')
  .select('id', 'email', 'role')
  .where({ role: 'TALENT' })
\`\`\`
`
}
