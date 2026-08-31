import { Client } from "@indexable/sdk";

if (!process.env.IX_TOKEN) {
  throw new Error("IX_TOKEN is required");
}

const ix = new Client();
const name = process.env.IX_SMOKE_NAME ?? `nanocodex-smoke-${Date.now().toString(36)}`;
const machine = await ix.machines().create({
  name,
  ...(process.env.IX_REGION ? { region: process.env.IX_REGION } : {}),
});
const started = Date.now();

try {
  await machine.execChecked(["mkdir", "-p", "/workspace"]);
  await machine.writeFile("/workspace/Cargo.toml", new TextEncoder().encode([
    "[package]",
    "name = \"nanocodex-ix-smoke\"",
    "version = \"0.1.0\"",
    "edition = \"2024\"",
    "",
    "[lib]",
    "path = \"lib.rs\"",
    "",
  ].join("\n")));
  await machine.writeFile(
    "/workspace/lib.rs",
    new TextEncoder().encode("#[test] fn ix_compute_works() { assert_eq!(2 + 2, 4); }\n"),
  );

  // ix/base is intentionally small. Pull Rust through Nix for this standalone
  // smoke instead of coupling the Managed provider to a particular ix template.
  const result = await machine.execChecked([
    "bash",
    "-lc",
    "cd /workspace && nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#cargo nixpkgs#rustc -c cargo test",
  ]);

  console.log(JSON.stringify({
    provider: "ix",
    machine: name,
    duration_ms: Date.now() - started,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }, null, 2));
} finally {
  if (process.env.IX_SMOKE_KEEP === "1") {
    console.error(`keeping ix machine ${name}`);
  } else {
    await machine.delete();
  }
}
