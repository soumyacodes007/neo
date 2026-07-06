import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { ToolError } from "@ozpb/core";

export interface SubmitSignedXdrInput {
  signed_xdr: string;
  network_passphrase: string;
  rpc_url: string;
  poll_attempts?: number;
}

export interface SubmitSignedXdrResult {
  success: boolean;
  hash: string;
  ledger?: number;
  status: string;
  error?: string;
}

interface SubmitBackend {
  sendTransaction(transaction: ReturnType<typeof TransactionBuilder.fromXDR>): Promise<{
    status: string;
    hash: string;
    errorResult?: { toXDR(format: "base64"): string };
  }>;
  pollTransaction(hash: string, options: { attempts: number }): Promise<{
    status: string;
    ledger?: number;
  }>;
}

export async function submitSignedXdr(input: SubmitSignedXdrInput): Promise<SubmitSignedXdrResult> {
  const server = new rpc.Server(input.rpc_url);
  return submitSignedXdrWithBackend(input, server as SubmitBackend);
}

export async function submitSignedXdrWithBackend(
  input: Omit<SubmitSignedXdrInput, "rpc_url">,
  backend: SubmitBackend,
): Promise<SubmitSignedXdrResult> {
  let transaction: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    transaction = TransactionBuilder.fromXDR(input.signed_xdr, input.network_passphrase);
  } catch (cause) {
    throw new ToolError("E_DATA_MALFORMED_XDR", "signed_xdr is not a valid transaction envelope for the requested network", {
      cause,
    });
  }

  const sent = await backend.sendTransaction(transaction);
  if (sent.status === "ERROR") {
    return {
      success: false,
      hash: sent.hash,
      status: sent.status,
      error: sent.errorResult?.toXDR("base64") ?? "Transaction submission failed",
    };
  }

  const hash = sent.hash;
  const polled = await backend.pollTransaction(hash, {
    attempts: input.poll_attempts ?? 10,
  });

  if (polled.status === "SUCCESS") {
    return {
      success: true,
      hash,
      status: polled.status,
      ...(polled.ledger !== undefined ? { ledger: polled.ledger } : {}),
    };
  }

  return {
    success: false,
    hash,
    status: polled.status,
    error: polled.status === "FAILED" ? "Transaction failed on-chain" : "Transaction confirmation timed out",
  };
}
