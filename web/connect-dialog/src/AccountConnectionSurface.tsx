import type { ReactNode } from "react";

export function AccountConnectionSurface({
  children,
  confirmationCode,
  confirmationLabel = "Confirm this matches your terminal",
  description,
  footer,
  title,
}: Readonly<{
  children: ReactNode;
  confirmationCode?: string | undefined;
  confirmationLabel?: string | undefined;
  description: ReactNode;
  footer?: ReactNode;
  title: string;
}>) {
  return (
    <div className="wizard-page wizard-review-page">
      <header className="wizard-intro">
        <div className="wizard-app">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {confirmationCode ? (
          <div className="wizard-terminal-code" role="status">
            <span>{confirmationLabel}</span>
            <strong>{confirmationCode.slice(0, 4)}-{confirmationCode.slice(4)}</strong>
          </div>
        ) : null}
      </header>
      <div className="wizard-sections">{children}</div>
      {footer}
    </div>
  );
}

export function AccountConnectionSection({
  children,
  eyebrow,
  meta,
  title,
  titleId,
}: Readonly<{
  children: ReactNode;
  eyebrow: string;
  meta?: ReactNode;
  title: string;
  titleId: string;
}>) {
  return (
    <section className="wizard-section" aria-labelledby={titleId}>
      <header className="wizard-section-title">
        <div><span>{eyebrow}</span><h2 id={titleId}>{title}</h2></div>
        {meta === undefined ? null : <small>{meta}</small>}
      </header>
      {children}
    </section>
  );
}

export function AccountConnectionGrid({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="wizard-connectors" role="list">{children}</div>;
}

export function AccountConnectionCard({
  action,
  connected = false,
  detail,
  disabled,
  logo,
  onClick,
  title,
}: Readonly<{
  action: string;
  connected?: boolean | undefined;
  detail: string;
  disabled: boolean;
  logo: ReactNode;
  onClick(): void;
  title: string;
}>) {
  return (
    <div className="wizard-connector-card" role="listitem">
      <button
        className={`connection-card${connected ? " is-connected" : ""}`}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {logo}
        <span className="connection-card-copy">
          <strong>{title}</strong>
          <span>{detail}</span>
        </span>
        <span className="connection-card-action">{action}</span>
      </button>
    </div>
  );
}
