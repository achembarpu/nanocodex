export type MachineUsdOrder = Readonly<{
  status?: unknown;
  issuance_transaction_hash?: unknown;
}> | undefined;

export function classifyMachineUsdOrder(
  order: MachineUsdOrder,
): "complete" | "failed" | "pending";
