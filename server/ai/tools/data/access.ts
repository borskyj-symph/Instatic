/**
 * Capability adapter for the data toolset.
 *
 * The HTTP data routes decide per-table and per-row access with the predicates
 * in `server/handlers/cms/data/access.ts`, which read an `AuthUser`. A tool
 * handler never has one — it has a `ToolContext` carrying `userId` and the
 * caller's capability set. `toolActor` projects that context into the shape
 * those predicates read, so the MCP surface and the HTTP surface answer the
 * same question the same way instead of growing a second copy of the rules
 * that drifts.
 *
 * Two gates, both needed. A tool's `requiredCapabilities` is the coarse one:
 * it decides whether the tool is offered to this caller at all. The predicates
 * below are the fine one: which table or row this particular caller may touch.
 */
import type { AuthUser } from '../../../repositories/users'
import type { ToolContext } from '../../runtime/types'

export type ToolActor = Pick<AuthUser, 'id' | 'capabilities'>

export function toolActor(ctx: ToolContext): ToolActor {
  // Copied, not aliased: `ctx.capabilities` is readonly and `AuthUser`'s is not.
  return { id: ctx.userId, capabilities: [...ctx.capabilities] }
}
