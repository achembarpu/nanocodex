import { namedTool } from "./namedTool.mjs";

export const ARTIFACT_DIRECTORY = "/workspace/.nanocodex/artifacts";
export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_ARTIFACT_SOURCE_CHARS = 262_144;

export const artifactToolDefinition = Object.freeze({
  description: [
    "Create or update the custom React interface shown to the user.",
    "source must be JavaScript that defines an App component; React, html, and sendPrompt are already in scope.",
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
  #workspace;
  #validateSource;

  constructor(workspace, options = {}) {
    requireWorkspace(workspace);
    this.#workspace = workspace;
    this.#validateSource = options.validateSource;
    if (this.#validateSource !== undefined && typeof this.#validateSource !== "function") {
      throw new TypeError("validateSource must be a function");
    }
    this.directory = artifactDirectory(options.directory ?? defaultArtifactDirectory(workspace.root));
    this.maxBytes = positiveInteger(options.maxBytes ?? MAX_ARTIFACT_BYTES, "maxBytes");
    this.maxDocuments = positiveInteger(options.maxDocuments ?? 100, "maxDocuments");
  }

  path(id) {
    return joinAbsolutePath(this.directory, `${validateArtifactId(id)}.json`);
  }

  async read(id) {
    return this.#readPath(this.path(id));
  }

  async scan() {
    let entries;
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
        return { ok: true, path: entry.path, artifact: await this.#readPath(entry.path) };
      } catch (error) {
        return { ok: false, path: entry.path, error };
      }
    });
    const artifacts = [];
    const rejected = [];
    for (const result of results) {
      if (result.ok) artifacts.push(result.artifact);
      else rejected.push({ path: result.path, error: result.error });
    }
    artifacts.sort((left, right) => right.updatedAt - left.updatedAt);
    return { artifacts, rejected };
  }

  async list() {
    return (await this.scan()).artifacts;
  }

  async save(input) {
    const value = exactRecord(input, "artifact input", ["id", "title", "source"]);
    const title = boundedString(value.title, "title", 120).trim();
    const id = value.id === undefined
      ? slugArtifactId(title)
      : validateArtifactId(boundedString(value.id, "id", 64));
    const source = boundedString(value.source, "source", MAX_ARTIFACT_SOURCE_CHARS);
    await this.#validateSource?.(source);
    const now = Date.now();
    let previous;
    try {
      previous = await this.read(id);
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof InvalidArtifactDocumentError)) throw error;
    }
    const document = {
      version: 1,
      id,
      title,
      source,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const encoded = JSON.stringify(document);
    assertByteLength(encoded, this.maxBytes);
    await this.#workspace.mkdir(this.directory);
    await this.#workspace.writeFile(this.path(id), encoded);
    return document;
  }

  async remove(id) {
    await this.#workspace.remove(this.path(id));
  }

  tool(onArtifact = () => {}) {
    if (typeof onArtifact !== "function") throw new TypeError("onArtifact must be a function");
    return namedTool("render_artifact", {
      ...artifactToolDefinition,
      handler: async (input) => {
        const document = await this.save(input);
        onArtifact(document);
        return {
          artifactId: document.id,
          path: this.path(document.id),
          title: document.title,
          runtime: "react",
        };
      },
    });
  }

  async #readPath(path) {
    const bytes = await this.#workspace.readFile(path);
    try {
      if (bytes.byteLength > this.maxBytes) throw new RangeError(`artifact exceeds ${this.maxBytes} bytes`);
      const document = parseArtifactDocument(new TextDecoder().decode(bytes));
      if (this.path(document.id) !== path) throw new TypeError("artifact id does not match its filename");
      return document;
    } catch (error) {
      throw new InvalidArtifactDocumentError(path, error);
    }
  }
}

class InvalidArtifactDocumentError extends Error {
  constructor(path, cause) {
    super(`invalid artifact document at ${path}: ${errorMessage(cause)}`, { cause });
    this.name = "InvalidArtifactDocumentError";
  }
}

/** Viem-style factory returning a named tool ready for array composition. */
export function artifact(options) {
  const value = exactRecord(options, "artifact options", [
    "workspace", "onArtifact", "directory", "maxBytes", "maxDocuments", "validateSource",
  ]);
  return new ArtifactStore(value.workspace, value).tool(value.onArtifact);
}

export function createArtifactTool(workspace, onArtifact, options) {
  return new ArtifactStore(workspace, options).tool(onArtifact);
}

export function artifactPath(id, directory = ARTIFACT_DIRECTORY) {
  return joinAbsolutePath(artifactDirectory(directory), `${validateArtifactId(id)}.json`);
}

export function parseArtifactDocument(encoded) {
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

function requireWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") throw new TypeError("artifact workspace is required");
  for (const method of ["list", "readFile", "writeFile", "remove", "mkdir"]) {
    if (typeof workspace[method] !== "function") throw new TypeError(`artifact workspace.${method} must be a function`);
  }
  if (typeof workspace.root !== "string") throw new TypeError("artifact workspace.root must be a string");
}

function exactRecord(value, name, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const extras = Object.keys(value).filter((key) => !keys.includes(key));
  if (extras.length) throw new TypeError(`${name} has unsupported properties: ${extras.join(", ")}`);
  return value;
}

function artifactDirectory(value) {
  if (!/^\/(?:[a-zA-Z0-9._/-]+)?$/.test(value) || value.includes("//") || value.split("/").includes("..")) {
    throw new TypeError("artifact directory must be a normalized absolute workspace path");
  }
  return value === "/" ? value : value.replace(/\/$/, "");
}

function defaultArtifactDirectory(root) {
  return joinAbsolutePath(artifactDirectory(root), ".nanocodex/artifacts");
}

function joinAbsolutePath(directory, name) {
  return `${directory === "/" ? "" : directory}/${name}`;
}

function validateArtifactId(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new TypeError("artifact id is invalid");
  return value;
}

function slugArtifactId(value) {
  const id = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return validateArtifactId(id);
}

function boundedString(value, name, max) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a string`);
  if (value.length > max) throw new RangeError(`${name} cannot exceed ${max} characters`);
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a timestamp`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function assertByteLength(value, max) {
  if (new TextEncoder().encode(value).byteLength > max) throw new RangeError(`artifact exceeds ${max} bytes`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error) {
  return (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "NotFoundError")
    || Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    || (error instanceof Error && error.message === "not found");
}

async function mapConcurrent(input, concurrency, map) {
  const output = new Array(input.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (next < input.length) {
      const index = next++;
      output[index] = await map(input[index]);
    }
  }));
  return output;
}
