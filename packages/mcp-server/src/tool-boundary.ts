import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolHandler<T> = (input: T) => Promise<unknown> | unknown;

export function withToolBoundary<T>(name: string, handler: ToolHandler<T>): (input: T) => Promise<CallToolResult> {
  return async (input: T) => {
    try {
      const result = await handler(input);
      return toolJson({ ok: true, tool: name, result });
    } catch (error) {
      return toolJson(
        {
          ok: false,
          tool: name,
          error: error instanceof Error ? error.message : "E_INTERNAL",
        },
        true,
      );
    }
  };
}

export function toolJson(value: unknown, isError = false): CallToolResult {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
