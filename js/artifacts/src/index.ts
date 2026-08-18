export const ARTIFACT_DIRECTORY = "/workspace/.nanocodex/artifacts";
export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_ARTIFACT_SOURCE_CHARS = 262_144;

export type ArtifactDocument = Readonly<{
  version: 1;
  id: string;
  title: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}>;

export type ArtifactInput = Readonly<{
  id?: string;
  title: string;
  source: string;
}>;

export type ArtifactWorkspaceEntry = Readonly<{
  kind: "directory" | "file";
  path: string;
  size?: number;
}>;

/** The narrow part of the Nanocodex Workspace contract used by artifact storage. */
export type ArtifactWorkspace = Readonly<{
  root: string;
  list(path?: string, options?: { maxEntries?: number }): Promise<readonly ArtifactWorkspaceEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}>;

export type ArtifactScan = Readonly<{
  artifacts: readonly ArtifactDocument[];
  rejected: readonly Readonly<{ path: string; error: unknown }>[];
}>;

export type ArtifactStoreOptions = Readonly<{
  directory?: string;
  maxBytes?: number;
  maxDocuments?: number;
}>;

export const artifactToolDefinition = Object.freeze({
  description: [
    "Create or update the custom interface shown to the user.",
    "source is JavaScript that must define an App component; React, html, and sendPrompt are already in scope.",
    "Use React hooks, html tagged templates instead of JSX, and embedded styles to build a polished responsive interface.",
    "Interactive controls may update local React state or call sendPrompt(prompt) to ask the agent to evolve the interface.",
    "Imports, network access, and access to parent or top are unavailable.",
    "Reuse the same id to replace the displayed interface in place.",
  ].join(" "),
  parameters: {
    type: "object",
    required: ["title", "source"],
    properties: {
      id: {
        type: "string",
        description: "Stable lowercase artifact ID. Reuse it to update an interface.",
        pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
      },
      title: { type: "string", minLength: 1, maxLength: 120 },
      source: {
        type: "string",
        minLength: 1,
        maxLength: MAX_ARTIFACT_SOURCE_CHARS,
        description: "JavaScript defining App; React, html, and sendPrompt are in scope.",
      },
    },
    additionalProperties: false,
  },
});

export class ArtifactStore {
  readonly directory: string;
  readonly maxBytes: number;
  readonly maxDocuments: number;
  readonly #workspace: ArtifactWorkspace;

  constructor(workspace: ArtifactWorkspace, options: ArtifactStoreOptions = {}) {
    this.#workspace = workspace;
    this.directory = artifactDirectory(options.directory ?? defaultArtifactDirectory(workspace.root));
    this.maxBytes = positiveInteger(options.maxBytes ?? MAX_ARTIFACT_BYTES, "maxBytes");
    this.maxDocuments = positiveInteger(options.maxDocuments ?? 100, "maxDocuments");
  }

  path(id: string): string {
    return joinAbsolutePath(this.directory, `${validateArtifactId(id)}.json`);
  }

  async read(id: string): Promise<ArtifactDocument> {
    return this.#readPath(this.path(id));
  }

  async scan(): Promise<ArtifactScan> {
    let entries: readonly ArtifactWorkspaceEntry[];
    try {
      entries = await this.#workspace.list(this.directory, { maxEntries: this.maxDocuments + 1 });
    } catch (error) {
      if (isNotFound(error)) return { artifacts: [], rejected: [] };
      throw error;
    }
    const prefix = `${this.directory === "/" ? "" : this.directory}/`;
    const files = entries.filter((entry) => entry.kind === "file"
      && entry.path.startsWith(prefix)
      && !entry.path.slice(prefix.length).includes("/")
      && entry.path.endsWith(".json"));
    if (files.length > this.maxDocuments) {
      throw new RangeError(`artifact store exceeds ${this.maxDocuments} documents`);
    }
    const results = await mapConcurrent(files, 8, async (entry) => {
      try {
        if (entry.size !== undefined && entry.size > this.maxBytes) {
          throw new RangeError(`artifact exceeds ${this.maxBytes} bytes`);
        }
        return { ok: true, path: entry.path, artifact: await this.#readPath(entry.path) } as const;
      } catch (error) {
        return { ok: false, path: entry.path, error } as const;
      }
    });
    const artifacts: ArtifactDocument[] = [];
    const rejected: Array<{ path: string; error: unknown }> = [];
    for (const result of results) {
      if (result.ok) artifacts.push(result.artifact);
      else rejected.push({ path: result.path, error: result.error });
    }
    artifacts.sort((left, right) => right.updatedAt - left.updatedAt);
    return { artifacts, rejected };
  }

  async list(): Promise<readonly ArtifactDocument[]> {
    return (await this.scan()).artifacts;
  }

  async save(input: unknown): Promise<ArtifactDocument> {
    const value = exactRecord(input, "artifact input", ["id", "title", "source"]);
    const title = boundedString(value.title, "title", 120).trim();
    const id = value.id === undefined
      ? slugArtifactId(title)
      : validateArtifactId(boundedString(value.id, "id", 64));
    const source = boundedString(value.source, "source", MAX_ARTIFACT_SOURCE_CHARS);
    const now = Date.now();
    let previous: ArtifactDocument | undefined;
    try {
      previous = await this.read(id);
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof InvalidArtifactDocumentError)) throw error;
    }
    const artifact: ArtifactDocument = {
      version: 1,
      id,
      title,
      source,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const encoded = JSON.stringify(artifact);
    assertByteLength(encoded, this.maxBytes);
    await this.#workspace.mkdir(this.directory);
    await this.#workspace.writeFile(this.path(id), encoded);
    return artifact;
  }

  async remove(id: string): Promise<void> {
    await this.#workspace.remove(this.path(id));
  }

  tool(onArtifact: (artifact: ArtifactDocument) => void = () => {}) {
    return {
      ...artifactToolDefinition,
      handler: async (input: unknown) => {
        const artifact = await this.save(input);
        onArtifact(artifact);
        return {
          artifactId: artifact.id,
          path: this.path(artifact.id),
          title: artifact.title,
          runtime: "react" as const,
        };
      },
    };
  }

  async #readPath(path: string): Promise<ArtifactDocument> {
    const bytes = await this.#workspace.readFile(path);
    try {
      if (bytes.byteLength > this.maxBytes) throw new RangeError(`artifact exceeds ${this.maxBytes} bytes`);
      const artifact = parseArtifactDocument(new TextDecoder().decode(bytes));
      if (this.path(artifact.id) !== path) throw new TypeError("artifact id does not match its filename");
      return artifact;
    } catch (error) {
      throw new InvalidArtifactDocumentError(path, error);
    }
  }
}

class InvalidArtifactDocumentError extends Error {
  constructor(path: string, cause: unknown) {
    super(`invalid artifact document at ${path}: ${errorMessage(cause)}`, { cause });
    this.name = "InvalidArtifactDocumentError";
  }
}

export function createArtifactTool(
  workspace: ArtifactWorkspace,
  onArtifact?: (artifact: ArtifactDocument) => void,
  options?: ArtifactStoreOptions,
) {
  return new ArtifactStore(workspace, options).tool(onArtifact);
}

export function artifactPath(id: string, directory = ARTIFACT_DIRECTORY): string {
  return joinAbsolutePath(artifactDirectory(directory), `${validateArtifactId(id)}.json`);
}

export function parseArtifactDocument(encoded: string): ArtifactDocument {
  const value = exactRecord(JSON.parse(encoded), "artifact document", [
    "version", "id", "title", "source", "createdAt", "updatedAt",
  ]);
  if (value.version !== 1) throw new TypeError("unsupported artifact version");
  return {
    version: 1,
    id: validateArtifactId(boundedString(value.id, "artifact.id", 64)),
    title: boundedString(value.title, "artifact.title", 120).trim(),
    source: boundedString(value.source, "artifact.source", MAX_ARTIFACT_SOURCE_CHARS),
    createdAt: timestamp(value.createdAt, "artifact.createdAt"),
    updatedAt: timestamp(value.updatedAt, "artifact.updatedAt"),
  };
}

function exactRecord(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const extras = Object.keys(result).filter((key) => !keys.includes(key));
  if (extras.length) throw new TypeError(`${name} has unsupported properties: ${extras.join(", ")}`);
  return result;
}

function artifactDirectory(value: string): string {
  if (!/^\/(?:[a-zA-Z0-9._/-]+)?$/.test(value) || value.includes("//") || value.split("/").includes("..")) {
    throw new TypeError("artifact directory must be a normalized absolute workspace path");
  }
  return value === "/" ? value : value.replace(/\/$/, "");
}

function defaultArtifactDirectory(root: string): string {
  return joinAbsolutePath(artifactDirectory(root), ".nanocodex/artifacts");
}

function joinAbsolutePath(directory: string, name: string): string {
  return `${directory === "/" ? "" : directory}/${name}`;
}

function validateArtifactId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new TypeError("artifact id is invalid");
  return value;
}

function slugArtifactId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return validateArtifactId(id);
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a string`);
  if (value.length > max) throw new RangeError(`${name} cannot exceed ${max} characters`);
  return value;
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a timestamp`);
  return value as number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function assertByteLength(value: string, max: number): void {
  if (new TextEncoder().encode(value).byteLength > max) throw new RangeError(`artifact exceeds ${max} bytes`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "NotFoundError")
    || Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    || (error instanceof Error && error.message === "not found");
}

async function mapConcurrent<Input, Output>(
  input: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(input.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (next < input.length) {
      const index = next++;
      output[index] = await map(input[index]!);
    }
  }));
  return output;
}
