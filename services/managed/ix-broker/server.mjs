import { Client } from "@indexable/sdk";

import { createIxBrokerServer } from "./broker.mjs";

if (!process.env.IX_TOKEN) throw new Error("IX_TOKEN is required");
if (!process.env.NANOCODEX_IX_BROKER_TOKEN) {
  throw new Error("NANOCODEX_IX_BROKER_TOKEN is required");
}

const client = new Client();
const server = createIxBrokerServer({
  machines: client.machines(),
  token: process.env.NANOCODEX_IX_BROKER_TOKEN,
});
const port = Number(process.env.PORT ?? "8789");
server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
  console.log(`nanocodex ix broker listening on ${port}`);
});
