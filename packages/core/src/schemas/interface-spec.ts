/** SCH-InterfaceSpec (Vol 05 B2). A contract's function/arg interface. */
import { z } from "zod";
import { ContractId, WasmHash } from "../primitives.js";

export const InterfaceFunction = z.object({
  name: z.string(),
  args: z.array(z.object({ name: z.string(), sc_type: z.string() })),
  is_read_only_hint: z.boolean().optional(),
});
export type InterfaceFunction = z.infer<typeof InterfaceFunction>;

export const InterfaceSpec = z.object({
  contract: ContractId,
  kind: z.enum(["wasm", "sac"]),
  functions: z.array(InterfaceFunction),
  wasm_hash: WasmHash.optional(),
  /** WASM specs are attacker-controllable labels — always false for wasm (EC-T05). */
  trusted: z.boolean(),
});
export type InterfaceSpec = z.infer<typeof InterfaceSpec>;
