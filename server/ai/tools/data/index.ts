/**
 * Data-scope tool barrel.
 *
 * Everything here is `execution: 'server'` and works with no workspace tab
 * open, which is the point: reusable data tables are edited in a grid, not in
 * the Tiptap editor that forces the `content_*` writes through the browser
 * bridge. See `schemaTools.ts` for the full reasoning and the step-up caveat.
 *
 * A factory, not a constant, because the row tools need per-connection context
 * (`DataToolsRuntime`) the MCP server owns. Call it with no argument for the
 * in-app agent path.
 */

import type { AiTool } from '../types'
import { dataLifecycleTools } from './lifecycleTools'
import { dataRowTools } from './rowTools'
import { dataSchemaTools } from './schemaTools'
import type { DataToolsRuntime } from './runtime'

export function dataTools(runtime?: DataToolsRuntime): AiTool[] {
  return [
    ...dataSchemaTools(runtime),
    ...dataRowTools(runtime),
    ...dataLifecycleTools(runtime),
  ]
}

export type { DataToolsRuntime } from './runtime'
