import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorEnvelope } from "@ozpb/core";

export type ToolHandler<T> = (input: T) => Promise<unknown> | unknown;

export function withToolBoundary<T>(name: string, handler: ToolHandler<T>): (input: T) => Promise<CallToolResult> {
  return async (input: T) => {
    try {
      const result = await handler(input);
      return toolJson({ ok: true, tool: name, result });
    } catch (error) {
      const envelope = toErrorEnvelope(error);
      return toolJson(
        {
          ok: false,
          tool: name,
          ...envelope,
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
