import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOzpbTools, type RegisterOzpbToolsOptions } from "./register-tools.js";

export function createOzPolicyBuilderServer(options: RegisterOzpbToolsOptions = {}): McpServer {
  const server = new McpServer({
    name: "oz-policy-builder",
    version: "0.0.0",
  });
  registerOzpbTools(server, options);
  return server;
}
