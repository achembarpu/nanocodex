export const ARTIFACT_DIRECTORY = "/workspace/.nanocodex/artifacts";
export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_ARTIFACT_ELEMENTS = 200;
export const MAX_ARTIFACT_RENDER_COST = 5_000;

export const artifactComponentTypes = [
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

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ArtifactTone = "default" | "accent" | "success" | "warning" | "danger";
export type ArtifactComponent = typeof artifactComponentTypes[number];
export type ArtifactChartPoint = Readonly<{ label: string; value: number }>;
export type ArtifactTableColumn = Readonly<{ key: string; label: string }>;

export type ArtifactProps = {
  Stack: Readonly<{
    direction?: "row" | "column";
    gap?: number;
    align?: "start" | "center" | "end" | "stretch";
    justify?: "start" | "center" | "end" | "between";
    wrap?: boolean;
  }>;
  Grid: Readonly<{ columns?: number; gap?: number }>;
  Card: Readonly<{ title?: string; subtitle?: string; tone?: ArtifactTone }>;
  Heading: Readonly<{ text: string; level?: 1 | 2 | 3 }>;
  Text: Readonly<{
    text: string;
    tone?: "default" | "muted" | "accent";
    size?: "small" | "medium" | "large";
  }>;
  Metric: Readonly<{
    label: string;
    value: string;
    detail?: string;
    trend?: "up" | "down" | "neutral";
  }>;
  Badge: Readonly<{ label: string; tone?: ArtifactTone }>;
  Progress: Readonly<{ label: string; value: number }>;
  Table: Readonly<{
    columns: readonly ArtifactTableColumn[];
    rows: readonly Readonly<Record<string, JsonValue>>[];
  }>;
  BarChart: Readonly<{ title?: string; data: readonly ArtifactChartPoint[]; color?: string }>;
  LineChart: Readonly<{ title?: string; data: readonly ArtifactChartPoint[]; color?: string }>;
  Image: Readonly<{ path: string; alt?: string; caption?: string }>;
  Code: Readonly<{ code: string; language?: string }>;
  Tabs: Readonly<{ labels: readonly string[] }>;
  Divider: Readonly<Record<string, never>>;
  Button: Readonly<{ label: string; prompt: string; variant?: "primary" | "secondary" }>;
};

export type ArtifactElement = {
  [Type in ArtifactComponent]: Readonly<{
    type: Type;
    props: ArtifactProps[Type];
    children?: readonly string[];
  }>;
}[ArtifactComponent];

export type ArtifactSpec = Readonly<{
  root: string;
  elements: Readonly<Record<string, ArtifactElement>>;
}>;

export type ArtifactDocument = Readonly<{
  version: 1;
  id: string;
  title: string;
  spec: ArtifactSpec;
  createdAt: number;
  updatedAt: number;
}>;

export type ArtifactInput = Readonly<{
  id?: string;
  title: string;
  spec: ArtifactSpec;
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

const componentGuide = `- Stack: direction (row|column), gap, align, justify, wrap
- Grid: columns (1-4), gap
- Card: title, subtitle, tone (default|accent|success|warning|danger)
- Heading: text, level (1-3)
- Text: text, tone (default|muted|accent), size (small|medium|large)
- Metric: label, value, detail, trend (up|down|neutral)
- Badge: label, tone
- Progress: label, value (0-100)
- Table: columns [{key,label}], rows [objects]
- BarChart or LineChart: title, data [{label,value}], color
- Image: path (PNG, JPEG, GIF, or WebP workspace file), alt, caption
- Code: code, language
- Tabs: labels (one per child)
- Divider: no props
- Button: label, prompt, variant (primary|secondary)`;

export const artifactToolDefinition = Object.freeze({
  description: `Create or update a trusted interactive artifact. Use it for dashboards, reports, charts, tables, image galleries, explainers, and other visual results. The spec is a flat element tree. Available components:\n${componentGuide}\nEvery element needs type and props. Only Stack, Grid, Card, and Tabs accept children. Button prompts are explicit follow-up actions the user may choose. Prefer a polished hierarchy with a small number of meaningful components.`,
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
          root: { type: "string", minLength: 1, maxLength: 128 },
          elements: {
            type: "object",
            minProperties: 1,
            maxProperties: MAX_ARTIFACT_ELEMENTS,
            additionalProperties: {
              type: "object",
              required: ["type", "props"],
              properties: {
                type: { type: "string", enum: artifactComponentTypes },
                props: { type: "object", additionalProperties: true },
                children: { type: "array", maxItems: 64, items: { type: "string" } },
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
    const files = entries
      .filter((entry) => entry.kind === "file"
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
    const value = exactRecord(input, "artifact input", ["id", "title", "spec"]);
    const title = boundedString(value.title, "title", 120).trim();
    const id = value.id === undefined
      ? slugArtifactId(title)
      : validateArtifactId(boundedString(value.id, "id", 64));
    const spec = validateArtifactSpec(value.spec);
    const now = Date.now();
    let previous: ArtifactDocument | undefined;
    try {
      previous = await this.read(id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const artifact: ArtifactDocument = {
      version: 1,
      id,
      title,
      spec,
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
          elements: Object.keys(artifact.spec.elements).length,
        };
      },
    };
  }

  async #readPath(path: string): Promise<ArtifactDocument> {
    const bytes = await this.#workspace.readFile(path);
    if (bytes.byteLength > this.maxBytes) throw new RangeError(`artifact exceeds ${this.maxBytes} bytes`);
    const artifact = parseArtifactDocument(new TextDecoder().decode(bytes));
    if (this.path(artifact.id) !== path) throw new TypeError("artifact id does not match its filename");
    return artifact;
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
    "version", "id", "title", "spec", "createdAt", "updatedAt",
  ]);
  if (value.version !== 1) throw new TypeError("unsupported artifact version");
  return {
    version: 1,
    id: validateArtifactId(boundedString(value.id, "artifact.id", 64)),
    title: boundedString(value.title, "artifact.title", 120).trim(),
    spec: validateArtifactSpec(value.spec),
    createdAt: timestamp(value.createdAt, "artifact.createdAt"),
    updatedAt: timestamp(value.updatedAt, "artifact.updatedAt"),
  };
}

export function validateArtifactSpec(input: unknown): ArtifactSpec {
  const value = exactRecord(input, "artifact spec", ["root", "elements"]);
  const root = elementId(value.root, "spec.root");
  const rawElements = exactRecord(value.elements, "spec.elements");
  const entries = Object.entries(rawElements);
  if (!entries.length) throw new TypeError("spec.elements must not be empty");
  if (entries.length > MAX_ARTIFACT_ELEMENTS) {
    throw new RangeError(`artifact exceeds ${MAX_ARTIFACT_ELEMENTS} elements`);
  }
  const elements: Record<string, ArtifactElement> = {};
  for (const [key, rawElement] of entries) {
    elementId(key, "element ID");
    const element = exactRecord(rawElement, `element ${key}`, ["type", "props", "children"]);
    const type = boundedString(element.type, `element ${key}.type`, 32) as ArtifactComponent;
    if (!artifactComponentTypes.includes(type)) throw new TypeError(`unsupported artifact component: ${type}`);
    const props = validateProps(type, exactRecord(element.props, `element ${key}.props`), key);
    const children = element.children === undefined
      ? undefined
      : stringArray(element.children, `element ${key}.children`, 64).map((child, index) =>
        elementId(child, `element ${key}.children[${index}]`));
    if (children?.length && !containerTypes.has(type)) {
      throw new TypeError(`${type} ${key} cannot have children`);
    }
    if (children && new Set(children).size !== children.length) {
      throw new TypeError(`element ${key} contains duplicate children`);
    }
    if (type === "Tabs" && (props as ArtifactProps["Tabs"]).labels.length !== (children?.length ?? 0)) {
      throw new TypeError(`Tabs ${key} requires one label per child`);
    }
    elements[key] = { type, props, ...(children ? { children } : {}) } as ArtifactElement;
  }
  if (!elements[root]) throw new TypeError(`artifact root does not exist: ${root}`);
  validateTree(root, elements);
  const renderCost = Object.values(elements).reduce((total, element) => total + elementRenderCost(element), 0);
  if (renderCost > MAX_ARTIFACT_RENDER_COST) {
    throw new RangeError(`artifact exceeds the ${MAX_ARTIFACT_RENDER_COST} render budget`);
  }
  return { root, elements };
}

const containerTypes = new Set<ArtifactComponent>(["Stack", "Grid", "Card", "Tabs"]);

function validateTree(root: string, elements: Record<string, ArtifactElement>): void {
  const visited = new Set<string>();
  const active = new Set<string>();
  const parents = new Map<string, string>();
  const visit = (key: string) => {
    if (active.has(key)) throw new TypeError(`artifact contains a cycle at ${key}`);
    if (visited.has(key)) return;
    const element = elements[key];
    if (!element) throw new TypeError(`artifact references missing element: ${key}`);
    active.add(key);
    for (const child of element.children ?? []) {
      const parent = parents.get(child);
      if (parent && parent !== key) throw new TypeError(`artifact element ${child} has multiple parents`);
      parents.set(child, key);
      visit(child);
    }
    active.delete(key);
    visited.add(key);
  };
  visit(root);
  if (parents.has(root)) throw new TypeError("artifact root cannot be a child");
  if (visited.size !== Object.keys(elements).length) throw new TypeError("artifact contains unreachable elements");
}

function elementRenderCost(element: ArtifactElement): number {
  if (element.type === "Table") return 1 + element.props.columns.length * element.props.rows.length;
  if (element.type === "BarChart" || element.type === "LineChart") return 1 + element.props.data.length * 2;
  if (element.type === "Code") return 1 + Math.ceil(element.props.code.length / 1_000);
  if (element.type === "Text") return 1 + Math.ceil(element.props.text.length / 1_000);
  return 1;
}

function validateProps(type: ArtifactComponent, props: Record<string, unknown>, key: string): ArtifactProps[ArtifactComponent] {
  const label = `${type} ${key}`;
  if (type === "Stack") {
    assertKeys(props, label, ["direction", "gap", "align", "justify", "wrap"]);
    optionalEnum(props.direction, `${label}.direction`, ["row", "column"]);
    optionalNumber(props.gap, `${label}.gap`, 0, 48);
    optionalEnum(props.align, `${label}.align`, ["start", "center", "end", "stretch"]);
    optionalEnum(props.justify, `${label}.justify`, ["start", "center", "end", "between"]);
    optionalBoolean(props.wrap, `${label}.wrap`);
  } else if (type === "Grid") {
    assertKeys(props, label, ["columns", "gap"]);
    optionalNumber(props.columns, `${label}.columns`, 1, 4, true);
    optionalNumber(props.gap, `${label}.gap`, 0, 48);
  } else if (type === "Card") {
    assertKeys(props, label, ["title", "subtitle", "tone"]);
    optionalText(props.title, `${label}.title`, 160);
    optionalText(props.subtitle, `${label}.subtitle`, 500);
    optionalEnum(props.tone, `${label}.tone`, ["default", "accent", "success", "warning", "danger"]);
  } else if (type === "Heading") {
    assertKeys(props, label, ["text", "level"]);
    boundedString(props.text, `${label}.text`, 500);
    optionalNumber(props.level, `${label}.level`, 1, 3, true);
  } else if (type === "Text") {
    assertKeys(props, label, ["text", "tone", "size"]);
    boundedString(props.text, `${label}.text`, 10_000);
    optionalEnum(props.tone, `${label}.tone`, ["default", "muted", "accent"]);
    optionalEnum(props.size, `${label}.size`, ["small", "medium", "large"]);
  } else if (type === "Metric") {
    assertKeys(props, label, ["label", "value", "detail", "trend"]);
    boundedString(props.label, `${label}.label`, 120);
    boundedString(props.value, `${label}.value`, 120);
    optionalText(props.detail, `${label}.detail`, 240);
    optionalEnum(props.trend, `${label}.trend`, ["up", "down", "neutral"]);
  } else if (type === "Badge") {
    assertKeys(props, label, ["label", "tone"]);
    boundedString(props.label, `${label}.label`, 80);
    optionalEnum(props.tone, `${label}.tone`, ["default", "accent", "success", "warning", "danger"]);
  } else if (type === "Progress") {
    assertKeys(props, label, ["label", "value"]);
    boundedString(props.label, `${label}.label`, 120);
    boundedNumber(props.value, `${label}.value`, 0, 100);
  } else if (type === "Table") {
    assertKeys(props, label, ["columns", "rows"]);
    const columns = array(props.columns, `${label}.columns`, 12);
    if (!columns.length) throw new TypeError(`${label}.columns must not be empty`);
    const columnKeys = new Set<string>();
    for (const [index, column] of columns.entries()) {
      const value = exactRecord(column, `${label}.columns[${index}]`, ["key", "label"]);
      const columnKey = boundedString(value.key, `${label}.columns[${index}].key`, 80);
      if (columnKeys.has(columnKey)) throw new TypeError(`${label}.columns contains duplicate key ${columnKey}`);
      columnKeys.add(columnKey);
      boundedString(value.label, `${label}.columns[${index}].label`, 120);
    }
    const rows = array(props.rows, `${label}.rows`, 100);
    rows.forEach((row, index) => exactRecord(row, `${label}.rows[${index}]`));
  } else if (type === "BarChart" || type === "LineChart") {
    assertKeys(props, label, ["title", "data", "color"]);
    optionalText(props.title, `${label}.title`, 160);
    const data = array(props.data, `${label}.data`, 100);
    if (!data.length) throw new TypeError(`${label}.data must not be empty`);
    for (const [index, point] of data.entries()) {
      const value = exactRecord(point, `${label}.data[${index}]`, ["label", "value"]);
      boundedString(value.label, `${label}.data[${index}].label`, 120);
      boundedNumber(value.value, `${label}.data[${index}].value`, -1e15, 1e15);
    }
    if (props.color !== undefined) safeColor(props.color, `${label}.color`);
  } else if (type === "Image") {
    assertKeys(props, label, ["path", "alt", "caption"]);
    const path = boundedString(props.path, `${label}.path`, 500);
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(path)) {
      throw new TypeError(`${label}.path must reference a PNG, JPEG, GIF, or WebP workspace file`);
    }
    optionalText(props.alt, `${label}.alt`, 500);
    optionalText(props.caption, `${label}.caption`, 500);
  } else if (type === "Code") {
    assertKeys(props, label, ["code", "language"]);
    boundedString(props.code, `${label}.code`, 50_000, true);
    optionalText(props.language, `${label}.language`, 40);
  } else if (type === "Tabs") {
    assertKeys(props, label, ["labels"]);
    const labels = stringArray(props.labels, `${label}.labels`, 12);
    if (!labels.length) throw new TypeError(`${label}.labels must not be empty`);
  } else if (type === "Divider") {
    assertKeys(props, label, []);
  } else {
    assertKeys(props, label, ["label", "prompt", "variant"]);
    boundedString(props.label, `${label}.label`, 120);
    boundedString(props.prompt, `${label}.prompt`, 4_000);
    optionalEnum(props.variant, `${label}.variant`, ["primary", "secondary"]);
  }
  return cloneJson(props, label) as ArtifactProps[ArtifactComponent];
}

function exactRecord(value: unknown, name: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (keys) assertKeys(result, name, keys);
  return result;
}

function assertKeys(value: Record<string, unknown>, name: string, allowed: readonly string[]): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new TypeError(`${name} has unsupported properties: ${extras.join(", ")}`);
}

function cloneJson<T>(value: T, name: string): T {
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 16) throw new RangeError(`${name} exceeds 16 levels of nesting`);
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${name} contains a non-finite number`);
      return;
    }
    if (typeof current !== "object") throw new TypeError(`${name} contains a non-JSON value`);
    if (seen.has(current)) throw new TypeError(`${name} contains a cycle`);
    seen.add(current);
    if (Array.isArray(current)) current.forEach((item) => visit(item, depth + 1));
    else {
      if (Object.getPrototypeOf(current) !== Object.prototype) throw new TypeError(`${name} contains a non-JSON object`);
      Object.values(current).forEach((item) => visit(item, depth + 1));
    }
    seen.delete(current);
  };
  visit(value, 0);
  return JSON.parse(JSON.stringify(value)) as T;
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

function elementId(value: unknown, name: string): string {
  const result = boundedString(value, name, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result)) throw new TypeError(`${name} is invalid`);
  return result;
}

function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > max) throw new RangeError(`${name} cannot exceed ${max} items`);
  return value;
}

function stringArray(value: unknown, name: string, max: number): string[] {
  return array(value, name, max).map((item, index) => boundedString(item, `${name}[${index}]`, 128));
}

function boundedString(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new TypeError(`${name} must be a string`);
  if (value.length > max) throw new RangeError(`${name} cannot exceed ${max} characters`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): void {
  if (value !== undefined) boundedString(value, name, max);
}

function boundedNumber(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
  return value;
}

function optionalNumber(value: unknown, name: string, min: number, max: number, integer = false): void {
  if (value !== undefined) boundedNumber(value, name, min, max, integer);
}

function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
}

function optionalEnum(value: unknown, name: string, values: readonly string[]): void {
  if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
    throw new TypeError(`${name} must be one of ${values.join(", ")}`);
  }
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a timestamp`);
  return value as number;
}

function safeColor(value: unknown, name: string): string {
  const result = boundedString(value, name, 32);
  if (!/^(?:#[0-9a-f]{3,8}|[a-z]+)$/i.test(result)) throw new TypeError(`${name} must be a hex or named color`);
  return result;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function assertByteLength(value: string, max: number): void {
  if (new TextEncoder().encode(value).byteLength > max) throw new RangeError(`artifact exceeds ${max} bytes`);
}

function isNotFound(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "NotFoundError"
    || Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    || error instanceof Error && error.message === "not found";
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
