import { startSubscriptionEgressProxy } from "./subscription-egress-proxy.mjs";

const port = Number(process.env.NANOCODEX_EGRESS_PORT ?? 8_791);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("NANOCODEX_EGRESS_PORT must be an integer from 1 through 65535");
}

const proxy = await startSubscriptionEgressProxy({
  capability: process.env.NANOCODEX_EGRESS_CAPABILITY,
  port,
  onEvent: ({ type, status, code }) => {
    const detail = status === undefined ? (code === undefined ? "" : ` code=${code}`) : ` status=${status}`;
    process.stderr.write(`[subscription-egress] ${type}${detail}\n`);
  },
});

process.stdout.write(`${proxy.url}\n`);
process.stderr.write(
  `Subscription egress relay is bound to 127.0.0.1:${port}. ` +
  "Preserve the printed capability path when exposing it.\n",
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await proxy.close();
    process.exit(0);
  });
}

await new Promise(() => {});
