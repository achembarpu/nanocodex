const connectStatePrefix = "connect.";
const brokerState = /^[A-Za-z0-9_-]{16,480}$/;

export function scopedConnectConnectorState(value) {
  if (typeof value !== "string" || !brokerState.test(value)) {
    throw new Error("The connector authorization state is invalid.");
  }
  return `${connectStatePrefix}${value}`;
}

export function isScopedConnectConnectorState(value) {
  return typeof value === "string"
    && value.startsWith(connectStatePrefix)
    && brokerState.test(value.slice(connectStatePrefix.length));
}

export function unscopedConnectConnectorState(value) {
  return isScopedConnectConnectorState(value)
    ? value.slice(connectStatePrefix.length)
    : undefined;
}
