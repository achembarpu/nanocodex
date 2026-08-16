import { defineCatalog } from "@json-render/core";
import {
  JSONUIProvider,
  Renderer,
  defineRegistry,
} from "@json-render/react";
import { schema } from "@json-render/react/schema";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Children,
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

import type { ArtifactDocument, ArtifactSpec } from "./artifact";
import { openKernelWorkspace } from "./workspace";

const tone = z.enum(["default", "accent", "success", "warning", "danger"]);
const chartPoint = z.object({ label: z.string(), value: z.number() });
const catalog = defineCatalog(schema, {
  components: {
    Stack: {
      description: "Flex layout container",
      props: z.object({
        direction: z.enum(["row", "column"]).optional(),
        gap: z.number().optional(),
        align: z.enum(["start", "center", "end", "stretch"]).optional(),
        justify: z.enum(["start", "center", "end", "between"]).optional(),
        wrap: z.boolean().optional(),
      }),
    },
    Grid: {
      description: "Responsive grid container",
      props: z.object({ columns: z.number().optional(), gap: z.number().optional() }),
    },
    Card: {
      description: "Titled visual group",
      props: z.object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
        tone: tone.optional(),
      }),
    },
    Heading: {
      description: "Section heading",
      props: z.object({ text: z.string(), level: z.number().optional() }),
    },
    Text: {
      description: "Text content",
      props: z.object({
        text: z.string(),
        tone: z.enum(["default", "muted", "accent"]).optional(),
        size: z.enum(["small", "medium", "large"]).optional(),
      }),
    },
    Metric: {
      description: "Prominent labeled value",
      props: z.object({
        label: z.string(),
        value: z.string(),
        detail: z.string().optional(),
        trend: z.enum(["up", "down", "neutral"]).optional(),
      }),
    },
    Badge: {
      description: "Compact status label",
      props: z.object({ label: z.string(), tone: tone.optional() }),
    },
    Progress: {
      description: "Labeled progress bar",
      props: z.object({ label: z.string(), value: z.number() }),
    },
    Table: {
      description: "Sortable data table",
      props: z.object({
        columns: z.array(z.object({ key: z.string(), label: z.string() })),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
    },
    BarChart: {
      description: "Categorical bar chart",
      props: z.object({ title: z.string().optional(), data: z.array(chartPoint), color: z.string().optional() }),
    },
    LineChart: {
      description: "Categorical line chart",
      props: z.object({ title: z.string().optional(), data: z.array(chartPoint), color: z.string().optional() }),
    },
    Image: {
      description: "Workspace image",
      props: z.object({ path: z.string(), alt: z.string().optional(), caption: z.string().optional() }),
    },
    Code: {
      description: "Code or preformatted data",
      props: z.object({ code: z.string(), language: z.string().optional() }),
    },
    Tabs: {
      description: "Locally interactive tabs",
      props: z.object({ labels: z.array(z.string()) }),
    },
    Divider: { description: "Visual divider", props: z.object({}) },
    Button: {
      description: "Explicit follow-up agent action",
      props: z.object({
        label: z.string(),
        prompt: z.string(),
        variant: z.enum(["primary", "secondary"]).optional(),
      }),
    },
  },
  actions: {},
});

const ArtifactActionContext = createContext<(prompt: string) => void>(() => {});

const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ props, children }) => (
      <div
        className={`artifact-stack is-${props.direction ?? "column"}`}
        style={{
          gap: props.gap ?? 12,
          alignItems: props.align ?? "stretch",
          justifyContent: props.justify === "between" ? "space-between" : props.justify ?? "flex-start",
          flexWrap: props.wrap ? "wrap" : "nowrap",
        }}
      >{children}</div>
    ),
    Grid: ({ props, children }) => (
      <div
        className="artifact-grid"
        style={{
          gap: props.gap ?? 12,
          gridTemplateColumns: `repeat(${props.columns ?? 2}, minmax(0, 1fr))`,
        }}
      >{children}</div>
    ),
    Card: ({ props, children }) => (
      <section className={`artifact-card tone-${props.tone ?? "default"}`}>
        {props.title || props.subtitle ? (
          <header>
            {props.title ? <strong>{props.title}</strong> : null}
            {props.subtitle ? <span>{props.subtitle}</span> : null}
          </header>
        ) : null}
        {children ? <div className="artifact-card-body">{children}</div> : null}
      </section>
    ),
    Heading: ({ props }) => {
      const Tag = props.level === 1 ? "h2" : props.level === 3 ? "h4" : "h3";
      return <Tag className="artifact-heading">{props.text}</Tag>;
    },
    Text: ({ props }) => (
      <p className={`artifact-text tone-${props.tone ?? "default"} size-${props.size ?? "medium"}`}>
        {props.text}
      </p>
    ),
    Metric: ({ props }) => (
      <div className={`artifact-metric trend-${props.trend ?? "neutral"}`}>
        <span>{props.label}</span>
        <strong>{props.value}</strong>
        {props.detail ? <small>{props.detail}</small> : null}
      </div>
    ),
    Badge: ({ props }) => <span className={`artifact-badge tone-${props.tone ?? "default"}`}>{props.label}</span>,
    Progress: ({ props }) => (
      <div className="artifact-progress">
        <span><strong>{props.label}</strong><i>{props.value}%</i></span>
        <div><i style={{ width: `${props.value}%` }} /></div>
      </div>
    ),
    Table: ArtifactTable,
    BarChart: ({ props }) => <ArtifactChart kind="bar" {...props} />,
    LineChart: ({ props }) => <ArtifactChart kind="line" {...props} />,
    Image: ArtifactImage,
    Code: ({ props }) => (
      <figure className="artifact-code">
        {props.language ? <figcaption>{props.language}</figcaption> : null}
        <pre><code>{props.code}</code></pre>
      </figure>
    ),
    Tabs: ArtifactTabs,
    Divider: () => <hr className="artifact-divider" />,
    Button: ({ props }) => {
      const act = useContext(ArtifactActionContext);
      return (
        <button
          className={`artifact-button is-${props.variant ?? "secondary"}`}
          type="button"
          onClick={() => act(props.prompt)}
        >{props.label}</button>
      );
    },
  },
});

export function ArtifactRenderer({
  artifact,
  onPrompt,
}: {
  artifact: ArtifactDocument;
  onPrompt(prompt: string): void;
}) {
  return (
    <ArtifactActionContext.Provider value={onPrompt}>
      <JSONUIProvider
        key={`${artifact.id}:${artifact.updatedAt}`}
        registry={registry}
        initialState={artifact.spec.state}
      >
        <Renderer spec={artifact.spec as ArtifactSpec} registry={registry} />
      </JSONUIProvider>
    </ArtifactActionContext.Provider>
  );
}

function ArtifactTable({ props }: {
  props: {
    columns: Array<{ key: string; label: string }>;
    rows: Array<Record<string, unknown>>;
  };
}) {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 }>();
  const rows = sort
    ? [...props.rows].sort((left, right) => sort.direction * compare(left[sort.key], right[sort.key]))
    : props.rows;
  return (
    <div className="artifact-table-wrap">
      <table className="artifact-table">
        <thead><tr>{props.columns.map((column) => (
          <th key={column.key}>
            <button type="button" onClick={() => setSort((current) => ({
              key: column.key,
              direction: current?.key === column.key && current.direction === 1 ? -1 : 1,
            }))}>
              {column.label}{sort?.key === column.key ? sort.direction === 1 ? " ↑" : " ↓" : ""}
            </button>
          </th>
        ))}</tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={index}>{props.columns.map((column) => (
            <td key={column.key}>{displayValue(row[column.key])}</td>
          ))}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ArtifactChart({
  kind,
  title,
  data,
  color,
}: {
  kind: "bar" | "line";
  title?: string;
  data: Array<{ label: string; value: number }>;
  color?: string;
}) {
  const stroke = color ?? "var(--blue)";
  return (
    <figure className="artifact-chart">
      {title ? <figcaption>{title}</figcaption> : null}
      <ResponsiveContainer width="100%" height={220}>
        {kind === "bar" ? (
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border-soft)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "var(--text-muted)", fontSize: 10 }} />
            <YAxis tick={{ fill: "var(--text-muted)", fontSize: 10 }} width={42} />
            <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
            <Bar dataKey="value" fill={stroke} radius={[3, 3, 0, 0]} />
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border-soft)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "var(--text-muted)", fontSize: 10 }} />
            <YAxis tick={{ fill: "var(--text-muted)", fontSize: 10 }} width={42} />
            <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
            <Line dataKey="value" stroke={stroke} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </figure>
  );
}

function ArtifactImage({ props }: { props: { path: string; alt?: string; caption?: string } }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    void openKernelWorkspace()
      .then((workspace) => workspace.readFile(props.path))
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: imageMime(props.path) }));
        setUrl(objectUrl);
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.path]);
  return (
    <figure className="artifact-image">
      {url ? <img src={url} alt={props.alt ?? ""} /> : <div>{error ?? "Loading image…"}</div>}
      {props.caption ? <figcaption>{props.caption}</figcaption> : null}
    </figure>
  );
}

function ArtifactTabs({ props, children }: { props: { labels: string[] }; children?: ReactNode }) {
  const items = Children.toArray(children);
  const [active, setActive] = useState(0);
  return (
    <section className="artifact-tabs">
      <header role="tablist">
        {props.labels.slice(0, items.length).map((label, index) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={index === active}
            onClick={() => setActive(index)}
          >{label}</button>
        ))}
      </header>
      <div role="tabpanel">{items[active]}</div>
    </section>
  );
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return displayValue(left).localeCompare(displayValue(right), undefined, { numeric: true });
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function imageMime(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "image/png";
}
