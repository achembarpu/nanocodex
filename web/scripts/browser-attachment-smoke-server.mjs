import { nanocodexTools } from "nanocodex/tools/vite";
import { createServer } from "vite";

const root = new URL("../", import.meta.url).pathname;
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  optimizeDeps: { exclude: ["nanocodex"] },
  plugins: [nanocodexTools()],
  server: { host: "127.0.0.1", port: Number(process.env.NANOCODEX_BROWSER_SMOKE_PORT ?? 4178), strictPort: true },
  worker: { format: "es", plugins: () => [nanocodexTools()] },
});

await vite.listen();
const address = vite.httpServer.address();
if (!address || typeof address !== "object") throw new Error("browser smoke server did not bind");
console.log(`http://127.0.0.1:${address.port}/test/fixtures/browserAttachment.html`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await vite.close();
    process.exit(0);
  });
}

