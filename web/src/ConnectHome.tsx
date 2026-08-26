import { AccountMenu } from "./AccountMenu";
import { ConnectionLogo } from "./ConnectionLogo";
import { useAccountSession } from "./AccountSession";

export function ConnectHome() {
  const completion = connectorCompletion(new URL(window.location.href));
  if (completion) {
    return (
      <div className="device-connect-route" data-testid="device-connect-complete">
        <section className="connect-wizard">
          <div className="wizard-content">
            <div className="wizard-page wizard-review-page">
              <header className="wizard-intro">
                <div className="wizard-app">
                  <h1>Connect {completion.name}</h1>
                  <p>{completion.connected
                    ? `${completion.name} is connected. You can return to the terminal.`
                    : `${completion.name} was not connected. Return to the terminal and try again.`}</p>
                </div>
              </header>
              <div className="wizard-sections">
                <section className="wizard-section" aria-labelledby="completed-service-heading">
                  <header className="wizard-section-title">
                    <div><span>Service</span><h2 id="completed-service-heading">{completion.name}</h2></div>
                    <small>Requested by CLI</small>
                  </header>
                  <div className="wizard-connectors" role="list">
                    <div className="wizard-connector-card" role="listitem">
                      <button
                        className={`connection-card${completion.connected ? " is-connected" : ""}`}
                        disabled
                        type="button"
                      >
                        <ConnectionLogo id={completion.id} />
                        <span className="connection-card-copy">
                          <strong>{completion.name}</strong>
                          <span>{completion.connected ? "Connected" : "Connection did not complete"}</span>
                        </span>
                        <span className="connection-card-action">
                          {completion.connected ? "Connected" : "Not connected"}
                        </span>
                      </button>
                    </div>
                  </div>
                </section>
              </div>
              {completion.connected ? (
                <div className="completion-actions">
                  <a href="/connect">Connect more accounts</a>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    );
  }
  return <AccountConnectHome />;
}

function AccountConnectHome() {
  const session = useAccountSession();
  if (session.status === "checking") return null;

  return (
    <div className="device-connect-route connect-home" data-testid="connect-home">
      <section className="connect-wizard">
        <div className="wizard-content">
          <div className="wizard-page">
            <header className="wizard-intro">
              <div className="wizard-app">
                <span>Nanocodex</span>
                <h1>Account</h1>
                <p>Manage your identity, connect the services your agents can use, and create API keys for Nanocodex.</p>
              </div>
            </header>
            <AccountMenu inline />
          </div>
        </div>
      </section>
    </div>
  );
}

type OAuthConnector = "github" | "gmail" | "gdrive" | "x";

function connectorCompletion(url: URL): Readonly<{
  connected: boolean;
  id: OAuthConnector;
  name: string;
}> | undefined {
  const connector = url.searchParams.get("connector");
  const result = url.searchParams.get("connector_result");
  if ((result !== "connected" && result !== "cancelled" && result !== "failed")
    || (connector !== "github" && connector !== "gmail" && connector !== "gdrive" && connector !== "x")) {
    return undefined;
  }
  const name = connector === "github" ? "GitHub"
    : connector === "gmail" ? "Gmail"
      : connector === "gdrive" ? "Google Drive"
        : "X";
  return { connected: result === "connected", id: connector, name };
}
