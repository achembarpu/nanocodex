import { AccountMenu } from "./AccountMenu";
import { useAccountSession } from "./AccountSession";

export function ConnectHome() {
  return <AccountConnectHome />;
}

function AccountConnectHome() {
  const session = useAccountSession();
  if (session.status === "checking") return null;

  return (
    <div className="device-connect-route connect-home" data-testid="connect-home">
      <section className="connect-wizard">
        <div className="wizard-content">
          {session.account?.persistent ? <div className="wizard-page">
            <header className="wizard-intro">
              <div className="wizard-app">
                <span>Nanocodex</span>
                <h1>Account</h1>
                <p>Manage your identity, connect the services your agents can use, and create API keys for Nanocodex.</p>
              </div>
            </header>
            <AccountMenu inline />
          </div> : <AccountMenu inline />}
        </div>
      </section>
    </div>
  );
}
