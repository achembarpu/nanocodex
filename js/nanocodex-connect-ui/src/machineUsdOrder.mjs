export function classifyMachineUsdOrder(order) {
  if (order?.status === "complete" && typeof order.issuance_transaction_hash === "string") {
    return "complete";
  }
  if (order?.status === "failed") return "failed";
  if (
    order?.status === "requires_payment" ||
    order?.status === "processing" ||
    order?.status === "issuing"
  ) {
    return "pending";
  }
  throw new Error("The MACH order response is invalid.");
}
