/**
 * Per-connection context the data tools need but `ToolContext` does not carry.
 *
 * `uploadsDir` is required to bake a row's static artefact on publish, and
 * `connectorId` is what makes an MCP write attributable in the audit log.
 * Both are known only to the MCP server, which passes them in when it builds
 * the catalog. The in-app agent path constructs the toolset without a runtime:
 * its writes are attributed to the signed-in user directly, and it does not
 * expose row publishing.
 *
 * Structurally identical to `McpPublishRuntime` and filled from the same
 * object, declared here so `server/ai/tools/` does not import from
 * `server/ai/mcp/`.
 */
export interface DataToolsRuntime {
  connectorId: string
  uploadsDir: string
}
