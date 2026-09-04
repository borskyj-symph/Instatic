/**
 * Publication state and removal for data rows.
 *
 * Both tools are bulk and both report per-row outcomes instead of failing the
 * whole call, which is the opposite of `data_create_rows`. The reason is what
 * each operation touches. A create is one transaction over rows that do not
 * exist yet, so all-or-nothing costs nothing and spares the caller a partial
 * table. Publishing is not transactional at all: each row takes the publish
 * lock, bakes its own static artefact, and bumps the publish version, so by
 * the time row 7 fails, rows 1–6 are already live on disk. Pretending that
 * away with a single error would leave the caller with no idea what shipped.
 *
 * Publishing a row in a non-routable table (`routeBase === ''`, the default
 * for `kind: 'data'`) is deliberately allowed. No artefact is baked because
 * there is no route to bake it at, but the row still becomes `published`,
 * which is exactly what an `<instatic-loop>` on some other page reads. That is
 * the normal shape for a reusable table: the rows are content, the page that
 * lists them owns the URL.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { DataRow, DataRowStatus } from '@core/data/schemas'
import type { AiTool, ToolContext } from '../../runtime/types'
import { createAuditEvent, type AuditAction } from '../../../repositories/audit'
import {
  getDataRow,
  softDeleteDataRowMany,
  updateDataRowStatus,
} from '../../../repositories/data'
import { publishDataRow, removeDataRowArtefact } from '../../../publish/publishRow'
import { bumpPublishVersionSerialized } from '../../../publish/publishState'
import { emitContentEntryDeleted, emitContentEntryUpdated } from '../../../publish/contentEvents'
import { canEditDataRow, canPublishDataRow } from '../../../handlers/cms/data/access'
import { toolActor } from './access'
import type { DataToolsRuntime } from './runtime'

/**
 * The union of the HTTP surface's two gates: publishing needs a publish cap,
 * retracting needs an edit cap. Which one applies is decided per row, by the
 * requested status, in the handler.
 */
const ROW_LIFECYCLE_CAPS: CoreCapability[] = [
  'content.publish.own',
  'content.publish.any',
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

const ROW_DELETE_CAPS: CoreCapability[] = ['content.edit.own', 'content.edit.any', 'content.manage']

const MAX_ROWS_PER_CALL = 200

const RowIds = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  maxItems: MAX_ROWS_PER_CALL,
})

interface RowFailure {
  rowId: string
  error: string
}

// ---------------------------------------------------------------------------
// data_set_rows_status
// ---------------------------------------------------------------------------

const SetRowsStatusInput = Type.Object({
  rowIds: RowIds,
  status: Type.Union([
    Type.Literal('published'),
    Type.Literal('draft'),
    Type.Literal('unpublished'),
  ]),
}, { additionalProperties: false })

function setRowsStatusTool(runtime?: DataToolsRuntime): AiTool {
  return {
    name: 'data_set_rows_status',
    scope: 'data',
    execution: 'server',
    mutates: true,
    requiredCapabilities: ROW_LIFECYCLE_CAPS,
    description:
      `Publish, unpublish, or return to draft up to ${MAX_ROWS_PER_CALL} rows. Rows are processed one by one and the result lists what succeeded and what did not — a failure part-way through does not roll back the rows already published. Publishing a row in a table with no route base still makes it visible to loops on other pages; it just gets no public URL of its own.`,
    inputSchema: SetRowsStatusInput,
    handler: async (input, ctx: ToolContext) => {
      const args = input as Static<typeof SetRowsStatusInput>
      const updated: Array<{ id: string; slug: string; status: DataRowStatus }> = []
      const failed: RowFailure[] = []

      for (const rowId of args.rowIds) {
        const current = await getDataRow(ctx.db, rowId)
        // Publishing and retracting are separate permissions on the HTTP
        // surface, so the per-row check has to follow the requested status
        // rather than the tool's coarse capability gate.
        const allowed = current && (args.status === 'published'
          ? canPublishDataRow(toolActor(ctx), current)
          : canEditDataRow(toolActor(ctx), current))
        if (!current || !allowed) {
          failed.push({ rowId, error: `Row ${rowId} not found.` })
          continue
        }

        try {
          const row = args.status === 'published'
            ? (await publishDataRow(ctx.db, rowId, ctx.userId, runtime?.uploadsDir)).row
            : await retractRow(ctx, runtime, rowId, args.status)
          if (!row) {
            failed.push({ rowId, error: `Row ${rowId} not found.` })
            continue
          }
          await emitContentEntryUpdated(ctx.db, row.id, ['status'], {
            kind: 'user',
            userId: ctx.userId,
          })
          await recordRowAudit(
            ctx,
            runtime,
            args.status === 'published' ? 'data.row.publish' : 'data.row.status',
            row,
            { status: args.status },
          )
          updated.push({ id: row.id, slug: row.slug, status: row.status })
        } catch (err) {
          failed.push({ rowId, error: err instanceof Error ? err.message : String(err) })
        }
      }

      return { updated, failed }
    },
  }
}

/**
 * Leave public visibility. Both `draft` and `unpublished` retract the row, so
 * the baked artefact has to go with it — Layer A serves the disk slot with no
 * database awareness and would keep answering for a retracted row.
 */
async function retractRow(
  ctx: ToolContext,
  runtime: DataToolsRuntime | undefined,
  rowId: string,
  status: 'draft' | 'unpublished',
): Promise<DataRow | null> {
  const row = await updateDataRowStatus(ctx.db, rowId, status, ctx.userId)
  if (!row) return null
  if (runtime?.uploadsDir) {
    await removeDataRowArtefact(ctx.db, runtime.uploadsDir, rowId, row.slug).catch((err) => {
      console.error('[ai:data] failed to remove artefact for retracted row', rowId, err)
    })
  }
  return row
}

// ---------------------------------------------------------------------------
// data_delete_rows
// ---------------------------------------------------------------------------

const DeleteRowsInput = Type.Object({
  rowIds: RowIds,
}, { additionalProperties: false })

function deleteRowsTool(runtime?: DataToolsRuntime): AiTool {
  return {
    name: 'data_delete_rows',
    scope: 'data',
    execution: 'server',
    mutates: true,
    requiredCapabilities: ROW_DELETE_CAPS,
    description:
      `Delete up to ${MAX_ROWS_PER_CALL} rows. The delete is soft — the rows stop being served and stop appearing anywhere, but stay recoverable in the database. Rows the caller may not edit are reported in \`failed\` and the rest are still deleted.`,
    inputSchema: DeleteRowsInput,
    handler: async (input, ctx: ToolContext) => {
      const args = input as Static<typeof DeleteRowsInput>
      const deletable: DataRow[] = []
      const failed: RowFailure[] = []

      for (const rowId of args.rowIds) {
        const row = await getDataRow(ctx.db, rowId)
        if (!row || !canEditDataRow(toolActor(ctx), row)) {
          failed.push({ rowId, error: `Row ${rowId} not found.` })
          continue
        }
        deletable.push(row)
      }

      if (deletable.length === 0) return { deleted: [], failed }

      const result = await softDeleteDataRowMany(
        ctx.db,
        deletable.map((row) => row.id),
        ctx.userId,
      )

      // The artefact prune and the cache bump both run after the transaction
      // commits: the bump serializes on the publish lock, which must never be
      // taken from inside a write transaction.
      for (const row of deletable) {
        if (runtime?.uploadsDir) {
          await removeDataRowArtefact(ctx.db, runtime.uploadsDir, row.id, row.slug).catch((err) => {
            console.error('[ai:data] failed to remove artefact for deleted row', row.id, err)
          })
        }
        await emitContentEntryDeleted(ctx.db, row.id, { kind: 'user', userId: ctx.userId })
        await recordRowAudit(ctx, runtime, 'data.row.delete', row)
      }
      if (result.publishedDeleted > 0) await bumpPublishVersionSerialized()

      return { deleted: deletable.map((row) => ({ id: row.id, slug: row.slug })), failed }
    },
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function recordRowAudit(
  ctx: ToolContext,
  runtime: DataToolsRuntime | undefined,
  action: AuditAction,
  row: Pick<DataRow, 'id' | 'tableId' | 'slug'>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await createAuditEvent(ctx.db, {
    actorUserId: ctx.userId,
    action,
    targetType: 'data_row',
    targetId: row.id,
    metadata: {
      tableId: row.tableId,
      slug: row.slug,
      ...extra,
      ...(runtime ? { source: 'mcp', connectorId: runtime.connectorId } : { source: 'agent' }),
    },
  })
}

export function dataLifecycleTools(runtime?: DataToolsRuntime): AiTool[] {
  return [setRowsStatusTool(runtime), deleteRowsTool(runtime)]
}
