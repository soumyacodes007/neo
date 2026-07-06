#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOzPolicyBuilderServer } from "./server.js";

const server = createOzPolicyBuilderServer();
await server.connect(new StdioServerTransport());
