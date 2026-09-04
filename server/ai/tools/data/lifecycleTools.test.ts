/**
 * Publish / retract / delete behaviour against a real migrated SQLite database.
 *
 * The case worth pinning is publishing a row in a table with no route base:
 * that is the default shape of a reusable data table, and if the publisher
 * refused it the whole point of issue #463 — feed a loop from an agent-written
 * table — would not work. The rest guards the partial-failure contract, which
 * differs from the all-or-nothing contract of `data_create_rows`.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { CoreCapability } from '@core/capabilities'
import type { DbClient } from '../../../db/client'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { listAuditEvents } from '../../../repositories/audit'
import { getDataRow, listDataRows } from '../../../repositories/data'
import type { AiTool, ToolContext } from '../../runtime/types'
import { dataTools } from './index'

const FULL_CAPS: CoreCapability[] = [
  'content.create',
  'content.manage',
  'content.publish.any',
  'data.custom.tables.read',
  'data.custom.tables.manage',
]

/** May write and retract rows, but never publish one. */
const NO_PUBLISH_CAPS: CoreCapability[] = [
  'content.create',
  'content.edit.any',
  'data.custom.tables.read',
]

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('user-1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

function toolByName(name: string): AiTool {
  // No `uploadsDir`, so nothing tries to touch the disk: these assert database
  // state, and the artefact writer is exercised by the publisher's own tests.
  const tool = dataTools().find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  return tool
}

function run(
  name: string,
  input: Record<string, unknown>,
  db: DbClient,
  capabilities: CoreCapability[] = FULL_CAPS,
): Promise<unknown> {
  const ctx: ToolContext = {
    db,
    userId: 'user-1',
    capabilities,
    scope: 'data',
    conversationId: 'conversation-1',
    snapshot: null,
    signal: new AbortController().signal,
  }
  return toolByName(name).handler!(input, ctx)
}

interface Seeded {
  tableId: string
  rowIds: string[]
}

/** A `kind: 'data'` table — no route base, which is the case under test. */
async function seedTrainings(db: DbClient, count = 2): Promise<Seeded> {
  const created = await run('data_create_table', {
    name: 'Trainings',
    fields: [
      { id: 'name', label: 'Name', type: 'text' },
      { id: 'slug', label: 'Slug', type: 'text' },
    ],
    primaryFieldId: 'name',
  }, db) as { table: { id: string; routeBase: string } }
  expect(created.table.routeBase).toBe('')

  const rows = await run('data_create_rows', {
    tableId: created.table.id,
    rows: Array.from({ length: count }, (_, i) => ({
      cells: { name: `Training ${i}`, slug: `training-${i}` },
    })),
  }, db) as { rows: Array<{ id: string }> }

  return { tableId: created.table.id, rowIds: rows.rows.map((row) => row.id) }
}

describe('data_set_rows_status', () => {
  let db: DbClient
  let seeded: Seeded

  beforeEach(async () => {
    db = await freshDb()
    seeded = await seedTrainings(db)
  })

  it('publishes rows in a table that has no public route base', async () => {
    const result = await run('data_set_rows_status', {
      rowIds: seeded.rowIds,
      status: 'published',
    }, db) as { updated: Array<{ id: string; status: string }>; failed: unknown[] }

    expect(result.failed).toHaveLength(0)
    expect(result.updated.map((row) => row.status)).toEqual(['published', 'published'])
    // What makes a loop on another page pick the row up.
    const stored = await getDataRow(db, seeded.rowIds[0])
    expect(stored!.status).toBe('published')
  })

  it('retracts a published row back to draft', async () => {
    await run('data_set_rows_status', { rowIds: seeded.rowIds, status: 'published' }, db)

    const result = await run('data_set_rows_status', {
      rowIds: [seeded.rowIds[0]],
      status: 'draft',
    }, db) as { updated: Array<{ status: string }> }

    expect(result.updated[0].status).toBe('draft')
    expect((await getDataRow(db, seeded.rowIds[1]))!.status).toBe('published')
  })

  it('reports the rows it could not touch and still applies the rest', async () => {
    const result = await run('data_set_rows_status', {
      rowIds: [seeded.rowIds[0], 'missing-row'],
      status: 'published',
    }, db) as {
      updated: Array<{ id: string }>
      failed: Array<{ rowId: string; error: string }>
    }

    expect(result.updated.map((row) => row.id)).toEqual([seeded.rowIds[0]])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].rowId).toBe('missing-row')
    expect(result.failed[0].error).toMatch(/not found/)
  })

  it('refuses to publish for a caller with edit but no publish capability', async () => {
    const result = await run('data_set_rows_status', {
      rowIds: seeded.rowIds,
      status: 'published',
    }, db, NO_PUBLISH_CAPS) as { updated: unknown[]; failed: unknown[] }

    expect(result.updated).toHaveLength(0)
    expect(result.failed).toHaveLength(2)
    expect((await getDataRow(db, seeded.rowIds[0]))!.status).toBe('draft')
  })

  it('audits a publish distinctly from a retraction', async () => {
    await run('data_set_rows_status', { rowIds: [seeded.rowIds[0]], status: 'published' }, db)
    await run('data_set_rows_status', { rowIds: [seeded.rowIds[0]], status: 'unpublished' }, db)

    const actions = (await listAuditEvents(db)).map((event) => event.action)
    expect(actions).toContain('data.row.publish')
    expect(actions).toContain('data.row.status')
  })
})

describe('data_delete_rows', () => {
  let db: DbClient
  let seeded: Seeded

  beforeEach(async () => {
    db = await freshDb()
    seeded = await seedTrainings(db, 3)
  })

  it('soft-deletes the rows it was given and leaves the others', async () => {
    const result = await run('data_delete_rows', {
      rowIds: seeded.rowIds.slice(0, 2),
    }, db) as { deleted: Array<{ id: string }>; failed: unknown[] }

    expect(result.deleted).toHaveLength(2)
    expect(result.failed).toHaveLength(0)
    const remaining = await listDataRows(db, seeded.tableId)
    expect(remaining.map((row) => row.id)).toEqual([seeded.rowIds[2]])
    // Soft, not hard — the row is gone from every listing but still stored.
    expect(await getDataRow(db, seeded.rowIds[0])).toBeNull()
  })

  it('deletes a published row, which retracts its public route', async () => {
    await run('data_set_rows_status', { rowIds: [seeded.rowIds[0]], status: 'published' }, db)

    const result = await run('data_delete_rows', { rowIds: [seeded.rowIds[0]] }, db) as {
      deleted: unknown[]
    }
    expect(result.deleted).toHaveLength(1)
    expect(await listDataRows(db, seeded.tableId)).toHaveLength(2)
  })

  it('reports unknown ids without blocking the deletable ones', async () => {
    const result = await run('data_delete_rows', {
      rowIds: [seeded.rowIds[0], 'missing-row'],
    }, db) as { deleted: Array<{ id: string }>; failed: Array<{ rowId: string }> }

    expect(result.deleted.map((row) => row.id)).toEqual([seeded.rowIds[0]])
    expect(result.failed.map((row) => row.rowId)).toEqual(['missing-row'])
  })

  it('writes nothing when no row is deletable', async () => {
    const result = await run('data_delete_rows', { rowIds: ['a', 'b'] }, db) as {
      deleted: unknown[]
      failed: unknown[]
    }
    expect(result.deleted).toHaveLength(0)
    expect(result.failed).toHaveLength(2)
    expect(await listDataRows(db, seeded.tableId)).toHaveLength(3)
  })
})
