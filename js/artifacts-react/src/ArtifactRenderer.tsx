import {
  Children,
  Fragment,
  useEffect,
  useId,
  useMemo,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  ArtifactComponent,
  ArtifactDocument,
  ArtifactProps,
  ArtifactSpec,
} from "nanocodex-artifacts";

export type ArtifactRenderContext = Readonly<{
  onAction?: (prompt: string) => void;
  readFile?: (path: string) => Promise<Uint8Array>;
}>;

export type ArtifactComponentProps<Type extends ArtifactComponent> = Readonly<{
  props: ArtifactProps[Type];
  children?: ReactNode;
  context: ArtifactRenderContext;
}>;

export type ArtifactComponentRegistry = {
  readonly [Type in ArtifactComponent]: ComponentType<ArtifactComponentProps<Type>>;
};

export type ArtifactRendererProps = Readonly<{
  artifact: ArtifactDocument;
  onAction?: (prompt: string) => void;
  readFile?: (path: string) => Promise<Uint8Array>;
  components?: Partial<ArtifactComponentRegistry>;
  className?: string;
}>;

export function ArtifactRenderer({
  artifact,
  onAction,
  readFile,
  components,
  className,
}: ArtifactRendererProps) {
  const registry = useMemo(
    () => ({ ...defaultArtifactComponents, ...components }),
    [components],
  );
  const context = useMemo(() => ({ onAction, readFile }), [onAction, readFile]);
  return (
    <div
      key={`${artifact.id}:${artifact.updatedAt}`}
      className={["nc-artifact", className].filter(Boolean).join(" ")}
      data-artifact-id={artifact.id}
    >
      <ArtifactNode id={artifact.spec.root} spec={artifact.spec} registry={registry} context={context} />
    </div>
  );
}

function ArtifactNode({
  id,
  spec,
  registry,
  context,
}: {
  id: string;
  spec: ArtifactSpec;
  registry: ArtifactComponentRegistry;
  context: ArtifactRenderContext;
}) {
  const element = spec.elements[id];
  if (!element) return null;
  const Component = registry[element.type] as ComponentType<{
    props: ArtifactProps[ArtifactComponent];
    children?: ReactNode;
    context: ArtifactRenderContext;
  }>;
  const children = element.children?.map((child) => (
    <ArtifactNode key={child} id={child} spec={spec} registry={registry} context={context} />
  ));
  return <Component props={element.props} context={context}>{children}</Component>;
}

export const ArtifactStack = ({ props, children }: ArtifactComponentProps<"Stack">) => (
  <div
    className={`nc-artifact-stack is-${props.direction ?? "column"}`}
    style={{
      gap: props.gap ?? 12,
      alignItems: props.align ?? "stretch",
      justifyContent: props.justify === "between" ? "space-between" : props.justify ?? "flex-start",
      flexWrap: props.wrap ? "wrap" : "nowrap",
    }}
  >{children}</div>
);

export const ArtifactGrid = ({ props, children }: ArtifactComponentProps<"Grid">) => (
  <div
    className="nc-artifact-grid"
    style={{ gap: props.gap ?? 12, gridTemplateColumns: `repeat(${props.columns ?? 2}, minmax(0, 1fr))` }}
  >{children}</div>
);

export const ArtifactCard = ({ props, children }: ArtifactComponentProps<"Card">) => (
  <section className={`nc-artifact-card tone-${props.tone ?? "default"}`}>
    {props.title || props.subtitle ? (
      <header>
        {props.title ? <strong>{props.title}</strong> : null}
        {props.subtitle ? <span>{props.subtitle}</span> : null}
      </header>
    ) : null}
    {children ? <div className="nc-artifact-card-body">{children}</div> : null}
  </section>
);

export const ArtifactHeading = ({ props }: ArtifactComponentProps<"Heading">) => {
  const Tag = props.level === 1 ? "h2" : props.level === 3 ? "h4" : "h3";
  return <Tag className="nc-artifact-heading">{props.text}</Tag>;
};

export const ArtifactText = ({ props }: ArtifactComponentProps<"Text">) => (
  <p className={`nc-artifact-text tone-${props.tone ?? "default"} size-${props.size ?? "medium"}`}>
    {props.text}
  </p>
);

export const ArtifactMetric = ({ props }: ArtifactComponentProps<"Metric">) => (
  <div className={`nc-artifact-metric trend-${props.trend ?? "neutral"}`}>
    <span>{props.label}</span>
    <strong>{props.value}</strong>
    {props.detail ? <small>{props.detail}</small> : null}
  </div>
);

export const ArtifactBadge = ({ props }: ArtifactComponentProps<"Badge">) => (
  <span className={`nc-artifact-badge tone-${props.tone ?? "default"}`}>{props.label}</span>
);

export const ArtifactProgress = ({ props }: ArtifactComponentProps<"Progress">) => (
  <div className="nc-artifact-progress">
    <span><strong>{props.label}</strong><i>{props.value}%</i></span>
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.value}
    ><i style={{ width: `${props.value}%` }} /></div>
  </div>
);

export function ArtifactTable({ props }: ArtifactComponentProps<"Table">) {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 }>();
  const rows = useMemo(() => sort
    ? [...props.rows].sort((left, right) => sort.direction * compare(left[sort.key], right[sort.key]))
    : props.rows, [props.rows, sort]);
  return (
    <div className="nc-artifact-table-wrap">
      <table className="nc-artifact-table">
        <thead><tr>{props.columns.map((column) => {
          const direction = sort?.key === column.key ? sort.direction : undefined;
          return (
            <th key={column.key} aria-sort={direction === 1 ? "ascending" : direction === -1 ? "descending" : "none"}>
              <button type="button" onClick={() => setSort((current) => ({
                key: column.key,
                direction: current?.key === column.key && current.direction === 1 ? -1 : 1,
              }))}>
                {column.label}{direction ? direction === 1 ? " ↑" : " ↓" : ""}
              </button>
            </th>
          );
        })}</tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={index}>{props.columns.map((column) => (
            <td key={column.key}>{displayValue(row[column.key])}</td>
          ))}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export const ArtifactBarChart = ({ props }: ArtifactComponentProps<"BarChart">) => <Chart kind="bar" {...props} />;
export const ArtifactLineChart = ({ props }: ArtifactComponentProps<"LineChart">) => <Chart kind="line" {...props} />;

function Chart({
  kind,
  title,
  data,
  color,
}: ArtifactProps["BarChart"] & { kind: "bar" | "line" }) {
  const width = 640;
  const height = 240;
  const frame = { top: 14, right: 14, bottom: 40, left: 54 };
  const plotWidth = width - frame.left - frame.right;
  const plotHeight = height - frame.top - frame.bottom;
  const minimum = Math.min(0, ...data.map(({ value }) => value));
  const maximum = Math.max(0, ...data.map(({ value }) => value));
  const span = maximum - minimum || 1;
  const y = (value: number) => frame.top + (maximum - value) / span * plotHeight;
  const baseline = y(0);
  const slot = plotWidth / data.length;
  const points = data.map(({ value }, index) => `${frame.left + slot * (index + 0.5)},${y(value)}`).join(" ");
  const labelStep = Math.max(1, Math.ceil(data.length / 8));
  const stroke = color ?? "var(--nc-artifact-accent, #4c72ff)";
  const label = title ?? `${kind === "bar" ? "Bar" : "Line"} chart`;
  return (
    <figure className="nc-artifact-chart">
      {title ? <figcaption>{title}</figcaption> : null}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <title>{label}</title>
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const value = maximum - fraction * span;
          const rowY = y(value);
          return (
            <Fragment key={fraction}>
              <line className="nc-artifact-chart-grid" x1={frame.left} x2={width - frame.right} y1={rowY} y2={rowY} />
              <text className="nc-artifact-chart-value" x={frame.left - 7} y={rowY + 3}>{formatNumber(value)}</text>
            </Fragment>
          );
        })}
        {kind === "bar" ? data.map((point, index) => {
          const pointY = y(point.value);
          return (
            <rect
              key={`${point.label}:${index}`}
              className="nc-artifact-chart-mark"
              x={frame.left + slot * index + slot * 0.15}
              y={Math.min(pointY, baseline)}
              width={Math.max(1, slot * 0.7)}
              height={Math.max(1, Math.abs(baseline - pointY))}
              rx={2}
              fill={stroke}
            ><title>{`${point.label}: ${formatNumber(point.value)}`}</title></rect>
          );
        }) : (
          <>
            <polyline className="nc-artifact-chart-line" points={points} fill="none" stroke={stroke} strokeWidth={3} />
            {data.map((point, index) => (
              <circle
                key={`${point.label}:${index}`}
                className="nc-artifact-chart-mark"
                cx={frame.left + slot * (index + 0.5)}
                cy={y(point.value)}
                r={4}
                fill={stroke}
              ><title>{`${point.label}: ${formatNumber(point.value)}`}</title></circle>
            ))}
          </>
        )}
        {data.map((point, index) => index % labelStep === 0 ? (
          <text
            key={`${point.label}:${index}`}
            className="nc-artifact-chart-label"
            x={frame.left + slot * (index + 0.5)}
            y={height - 14}
          >{point.label}</text>
        ) : null)}
      </svg>
    </figure>
  );
}

export function ArtifactImage({ props, context }: ArtifactComponentProps<"Image">) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError(undefined);
    if (!context.readFile) {
      setError("No artifact file reader was provided.");
      return () => { active = false; };
    }
    void context.readFile(props.path)
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: imageMime(props.path) }));
        setUrl(objectUrl);
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [context.readFile, props.path]);
  return (
    <figure className="nc-artifact-image">
      {url ? <img src={url} alt={props.alt ?? ""} /> : <div>{error ?? "Loading image…"}</div>}
      {props.caption ? <figcaption>{props.caption}</figcaption> : null}
    </figure>
  );
}

export const ArtifactCode = ({ props }: ArtifactComponentProps<"Code">) => (
  <figure className="nc-artifact-code">
    {props.language ? <figcaption>{props.language}</figcaption> : null}
    <pre><code>{props.code}</code></pre>
  </figure>
);

export function ArtifactTabs({ props, children }: ArtifactComponentProps<"Tabs">) {
  const items = Children.toArray(children);
  const [active, setActive] = useState(0);
  const id = useId();
  const select = (index: number) => setActive((index + items.length) % items.length);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    select(next);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };
  return (
    <section className="nc-artifact-tabs">
      <header role="tablist">
        {props.labels.map((label, index) => (
          <button
            id={`${id}-tab-${index}`}
            key={`${label}:${index}`}
            type="button"
            role="tab"
            aria-controls={`${id}-panel-${index}`}
            aria-selected={index === active}
            tabIndex={index === active ? 0 : -1}
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >{label}</button>
        ))}
      </header>
      <div id={`${id}-panel-${active}`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`}>
        {items[active]}
      </div>
    </section>
  );
}

export const ArtifactDivider = () => <hr className="nc-artifact-divider" />;

export const ArtifactButton = ({ props, context }: ArtifactComponentProps<"Button">) => (
  <button
    className={`nc-artifact-button is-${props.variant ?? "secondary"}`}
    type="button"
    disabled={!context.onAction}
    onClick={() => context.onAction?.(props.prompt)}
  >{props.label}</button>
);

export const defaultArtifactComponents: ArtifactComponentRegistry = Object.freeze({
  Stack: ArtifactStack,
  Grid: ArtifactGrid,
  Card: ArtifactCard,
  Heading: ArtifactHeading,
  Text: ArtifactText,
  Metric: ArtifactMetric,
  Badge: ArtifactBadge,
  Progress: ArtifactProgress,
  Table: ArtifactTable,
  BarChart: ArtifactBarChart,
  LineChart: ArtifactLineChart,
  Image: ArtifactImage,
  Code: ArtifactCode,
  Tabs: ArtifactTabs,
  Divider: ArtifactDivider,
  Button: ArtifactButton,
});

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return displayValue(left).localeCompare(displayValue(right), undefined, { numeric: true });
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function imageMime(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "image/png";
}
