import type { Workspace } from "nanocodex/browser/workspace";

const ARTIFACT_DIRECTORY = "/workspace/.nanocodex/artifacts";
const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_ELEMENTS = 200;
const componentTypes = [
  "Stack",
  "Grid",
  "Card",
  "Heading",
  "Text",
  "Metric",
  "Badge",
  "Progress",
  "Table",
  "BarChart",
  "LineChart",
  "Image",
  "Code",
  "Tabs",
  "Divider",
  "Button",
] as const;

export type ArtifactComponent = typeof componentTypes[number];
export type ArtifactElement = {
  type: ArtifactComponent;
  props: Record<string, unknown>;
  children?: string[];
};
export type ArtifactSpec = {
  root: string;
  elements: Record<string, ArtifactElement>;
  state?: Record<string, unknown>;
};
export type ArtifactDocument = {
  version: 1;
  id: string;
  title: string;
  spec: ArtifactSpec;
  createdAt: number;
  updatedAt: number;
};

export const artifactToolDefinition = Object.freeze({
  description: `Create or update a trusted interactive visual artifact in the browser. Use this for dashboards, reports, charts, tables, image galleries, explainers, forms, and other visual results. The spec is a flat element tree. Available components and props:
- Stack: direction (row|column), gap, align, justify, wrap
- Grid: columns (1-4), gap
- Card: title, subtitle, tone (default|accent|success|warning|danger)
- Heading: text, level (1-3)
- Text: text, tone (default|muted|accent), size (small|medium|large)
- Metric: label, value, detail, trend (up|down|neutral)
- Badge: label, tone
- Progress: label, value (0-100)
- Table: columns [{key,label}], rows [objects]
- BarChart or LineChart: title, data [{label,value}], color
- Image: path (workspace file), alt, caption
- Code: code, language
- Tabs: labels (one per child)
- Divider: no props
- Button: label, prompt, variant (primary|secondary)
Every element needs type and props. Children contains element IDs. Button prompts are explicit follow-up actions the user may choose. Prefer a polished hierarchy with a small number of meaningful components.`,
  parameters: {
    type: "object",
    required: ["title", "spec"],
    properties: {
      id: {
        type: "string",
        description: "Stable lowercase artifact ID. Reuse it to update an artifact.",
        pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
      },
      title: { type: "string", minLength: 1, maxLength: 120 },
      spec: {
        type: "object",
        required: ["root", "elements"],
        properties: {
          root: { type: "string", minLength: 1 },
          state: { type: "object", additionalProperties: true },
          elements: {
            type: "object",
            minProperties: 1,
            maxProperties: MAX_ELEMENTS,
            additionalProperties: {
              type: "object",
              required: ["type", "props"],
              properties: {
                type: { type: "string", enum: componentTypes },
                props: { type: "object", additionalProperties: true },
                children: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
});

export function createArtifactTool(
  workspace: Workspace,
  onArtifact: (artifact: ArtifactDocument) => void,
) {
  return {
    ...artifactToolDefinition,
    async handler(input: unknown) {
      const value = record(input, "artifact input");
      const title = text(value.title, "title", 120);
      const id = value.id === undefined ? artifactId(title) : artifactId(text(value.id, "id", 64));
      const spec = validateArtifactSpec(value.spec);
      const now = Date.now();
      const previous = await readArtifact(workspace, id).catch(() => undefined);
      const artifact: ArtifactDocument = {
        version: 1,
        id,
        title,
        spec,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      const encoded = JSON.stringify(artifact);
      if (new TextEncoder().encode(encoded).byteLength > MAX_ARTIFACT_BYTES) {
        throw new RangeError(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
      }
      await workspace.mkdir(ARTIFACT_DIRECTORY);
      await workspace.writeFile(artifactPath(id), encoded);
      onArtifact(artifact);
      return {
        artifactId: id,
        path: artifactPath(id),
        title,
        elements: Object.keys(spec.elements).length,
      };
    },
  };
}

export function validateArtifactSpec(input: unknown): ArtifactSpec {
  const value = record(input, "artifact spec");
  const root = text(value.root, "spec.root", 128);
  const rawElements = record(value.elements, "spec.elements");
  const entries = Object.entries(rawElements);
  if (!entries.length) throw new TypeError("spec.elements must not be empty");
  if (entries.length > MAX_ELEMENTS) throw new RangeError(`artifact exceeds ${MAX_ELEMENTS} elements`);
  const elements: Record<string, ArtifactElement> = {};
  for (const [key, rawElement] of entries) {
    text(key, "element ID", 128);
    const element = record(rawElement, `element ${key}`);
    const type = text(element.type, `element ${key}.type`, 32);
    if (!componentTypes.includes(type as ArtifactComponent)) {
      throw new TypeError(`unsupported artifact component: ${type}`);
    }
    const props = record(element.props, `element ${key}.props`);
    validateProps(type as ArtifactComponent, props, key);
    const children = element.children === undefined
      ? undefined
      : stringArray(element.children, `element ${key}.children`, 64);
    if (type === "Tabs" && (props.labels as unknown[]).length !== (children?.length ?? 0)) {
      throw new TypeError(`Tabs ${key} requires one label per child`);
    }
    elements[key] = { type: type as ArtifactComponent, props: jsonClone(props), children };
  }
  if (!elements[root]) throw new TypeError(`artifact root does not exist: ${root}`);
  validateTree(root, elements);
  const state = value.state === undefined ? undefined : jsonClone(record(value.state, "spec.state"));
  return { root, elements, ...(state ? { state } : {}) };
}

export async function loadArtifacts(workspace: Workspace): Promise<ArtifactDocument[]> {
  let entries;
  try {
    entries = await workspace.list(ARTIFACT_DIRECTORY, { maxEntries: 500 });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const paths = entries
    .filter((entry) => entry.kind === "file" && entry.path.startsWith(`${ARTIFACT_DIRECTORY}/`))
    .map((entry) => entry.path);
  const artifacts = await Promise.all(paths.map(async (path) => {
    try {
      return parseArtifact(new TextDecoder().decode(await workspace.readFile(path)));
    } catch {
      return undefined;
    }
  }));
  return artifacts
    .filter((artifact): artifact is ArtifactDocument => artifact !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function deleteArtifact(workspace: Workspace, id: string): Promise<void> {
  await workspace.remove(artifactPath(artifactId(id)));
}

export function artifactPath(id: string): string {
  return `${ARTIFACT_DIRECTORY}/${artifactId(id)}.json`;
}

function parseArtifact(encoded: string): ArtifactDocument {
  const value = record(JSON.parse(encoded), "artifact document");
  if (value.version !== 1) throw new TypeError("unsupported artifact version");
  const id = artifactId(text(value.id, "artifact.id", 64));
  return {
    version: 1,
    id,
    title: text(value.title, "artifact.title", 120),
    spec: validateArtifactSpec(value.spec),
    createdAt: timestamp(value.createdAt, "artifact.createdAt"),
    updatedAt: timestamp(value.updatedAt, "artifact.updatedAt"),
  };
}

async function readArtifact(workspace: Workspace, id: string): Promise<ArtifactDocument> {
  return parseArtifact(new TextDecoder().decode(await workspace.readFile(artifactPath(id))));
}

function validateTree(root: string, elements: Record<string, ArtifactElement>) {
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (key: string) => {
    if (active.has(key)) throw new TypeError(`artifact contains a cycle at ${key}`);
    if (visited.has(key)) return;
    const element = elements[key];
    if (!element) throw new TypeError(`artifact references missing element: ${key}`);
    active.add(key);
    for (const child of element.children ?? []) visit(child);
    active.delete(key);
    visited.add(key);
  };
  visit(root);
  if (visited.size !== Object.keys(elements).length) {
    throw new TypeError("artifact contains unreachable elements");
  }
}

function validateProps(type: ArtifactComponent, props: Record<string, unknown>, key: string) {
  const label = `${type} ${key}`;
  if (type === "Stack") {
    optionalEnum(props.direction, `${label}.direction`, ["row", "column"]);
    optionalNumber(props.gap, `${label}.gap`, 0, 48);
    optionalEnum(props.align, `${label}.align`, ["start", "center", "end", "stretch"]);
    optionalEnum(props.justify, `${label}.justify`, ["start", "center", "end", "between"]);
    optionalBoolean(props.wrap, `${label}.wrap`);
  } else if (type === "Grid") {
    optionalNumber(props.columns, `${label}.columns`, 1, 4, true);
    optionalNumber(props.gap, `${label}.gap`, 0, 48);
  } else if (type === "Card") {
    optionalText(props.title, `${label}.title`, 160);
    optionalText(props.subtitle, `${label}.subtitle`, 500);
    optionalEnum(props.tone, `${label}.tone`, ["default", "accent", "success", "warning", "danger"]);
  } else if (type === "Heading") {
    text(props.text, `${label}.text`, 500);
    optionalNumber(props.level, `${label}.level`, 1, 3, true);
  } else if (type === "Text") {
    text(props.text, `${label}.text`, 10_000);
    optionalEnum(props.tone, `${label}.tone`, ["default", "muted", "accent"]);
    optionalEnum(props.size, `${label}.size`, ["small", "medium", "large"]);
  } else if (type === "Metric") {
    text(props.label, `${label}.label`, 120);
    text(props.value, `${label}.value`, 120);
    optionalText(props.detail, `${label}.detail`, 240);
    optionalEnum(props.trend, `${label}.trend`, ["up", "down", "neutral"]);
  } else if (type === "Badge") {
    text(props.label, `${label}.label`, 80);
    optionalEnum(props.tone, `${label}.tone`, ["default", "accent", "success", "warning", "danger"]);
  } else if (type === "Progress") {
    text(props.label, `${label}.label`, 120);
    number(props.value, `${label}.value`, 0, 100);
  } else if (type === "Table") {
    const columns = array(props.columns, `${label}.columns`, 12);
    if (!columns.length) throw new TypeError(`${label}.columns must not be empty`);
    for (const [index, column] of columns.entries()) {
      const value = record(column, `${label}.columns[${index}]`);
      text(value.key, `${label}.columns[${index}].key`, 80);
      text(value.label, `${label}.columns[${index}].label`, 120);
    }
    const rows = array(props.rows, `${label}.rows`, 100);
    rows.forEach((row, index) => record(row, `${label}.rows[${index}]`));
  } else if (type === "BarChart" || type === "LineChart") {
    optionalText(props.title, `${label}.title`, 160);
    const data = array(props.data, `${label}.data`, 100);
    if (!data.length) throw new TypeError(`${label}.data must not be empty`);
    for (const [index, point] of data.entries()) {
      const value = record(point, `${label}.data[${index}]`);
      text(value.label, `${label}.data[${index}].label`, 120);
      number(value.value, `${label}.data[${index}].value`, -1e15, 1e15);
    }
    if (props.color !== undefined) color(props.color, `${label}.color`);
  } else if (type === "Image") {
    const path = text(props.path, `${label}.path`, 500);
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(path)) {
      throw new TypeError(`${label}.path must reference a PNG, JPEG, GIF, or WebP workspace file`);
    }
    optionalText(props.alt, `${label}.alt`, 500);
    optionalText(props.caption, `${label}.caption`, 500);
  } else if (type === "Code") {
    text(props.code, `${label}.code`, 50_000, true);
    optionalText(props.language, `${label}.language`, 40);
  } else if (type === "Tabs") {
    const labels = stringArray(props.labels, `${label}.labels`, 12);
    if (!labels.length) throw new TypeError(`${label}.labels must not be empty`);
  } else if (type === "Button") {
    text(props.label, `${label}.label`, 120);
    text(props.prompt, `${label}.prompt`, 4_000);
    optionalEnum(props.variant, `${label}.variant`, ["primary", "secondary"]);
  }
}

function artifactId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const id = normalized.slice(0, 64);
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new TypeError("artifact id is invalid");
  return id;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > max) throw new RangeError(`${name} cannot exceed ${max} items`);
  return value;
}

function stringArray(value: unknown, name: string, max: number): string[] {
  return array(value, name, max).map((item, index) => text(item, `${name}[${index}]`, 128));
}

function text(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new TypeError(`${name} must be a string`);
  if (value.length > max) throw new RangeError(`${name} cannot exceed ${max} characters`);
  return value;
}

function optionalText(value: unknown, name: string, max: number) {
  if (value !== undefined) text(value, name, max);
}

function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
  return value;
}

function optionalNumber(value: unknown, name: string, min: number, max: number, integer = false) {
  if (value !== undefined) number(value, name, min, max, integer);
}

function optionalBoolean(value: unknown, name: string) {
  if (value !== undefined && typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
}

function optionalEnum(value: unknown, name: string, values: readonly string[]) {
  if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
    throw new TypeError(`${name} must be one of ${values.join(", ")}`);
  }
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a timestamp`);
  return value as number;
}

function color(value: unknown, name: string): string {
  const result = text(value, name, 32);
  if (!/^(?:#[0-9a-f]{3,8}|[a-z]+)$/i.test(result)) {
    throw new TypeError(`${name} must be a hex or named color`);
  }
  return result;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError"
    || Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    || error instanceof Error && error.message === "not found";
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
