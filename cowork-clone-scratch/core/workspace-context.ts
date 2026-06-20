export function withWorkspaceContext(message: unknown, workspace: unknown): string {
  const userMessage = String(message ?? "").trim();
  const workspacePath = typeof workspace === "string" ? workspace.trim() : "";

  if (!workspacePath) return userMessage;

  return [
    `Workspace root: ${workspacePath}`,
    "This folder is already granted. Inspect it directly with the available tools and do not ask the user for its path.",
    "",
    `User request: ${userMessage}`,
  ].join("\n");
}
