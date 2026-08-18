import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { Actions } from "viem/tempo";

import type { PaymentStatus } from "./nanocodex";
import {
  MPP_ACCESS_KEY_LIMIT,
  MPP_MIN_WALLET_BALANCE,
  PATH_USD,
  USDC_E,
} from "./tempo-policy";
import {
  ensureTempoMppAccessKey,
  rehydrateTempoAccount,
  resolveTempoMppAccessKey,
  tempoAccount,
} from "./tempoAccount";

const queryClient = new QueryClient();

export function MppControls(props: {
  jsonl: readonly string[];
  payment?: PaymentStatus;
  onDisconnect(): void;
  onReady(address: Address, accessKeyAddress: Address): void;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectedMppControls {...props} />
    </QueryClientProvider>
  );
}

function ConnectedMppControls({ jsonl, payment, onDisconnect, onReady }: {
  jsonl: readonly string[];
  payment?: PaymentStatus;
  onDisconnect(): void;
  onReady(address: Address, accessKeyAddress: Address): void;
}) {
  const [address, setAddress] = useState<Address>();
  const [accessKeyAddress, setAccessKeyAddress] = useState<Address>();
  const [checkingAccessKey, setCheckingAccessKey] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const reportedSession = useRef<string | undefined>(undefined);

  const refreshAccount = useCallback(async () => {
    await rehydrateTempoAccount();
    const accounts = await tempoAccount.request({ method: "eth_accounts" });
    setAddress(accounts[0]);
    return accounts[0];
  }, []);

  useEffect(() => {
    void refreshAccount().then(async (account) => {
      setAuthorized(account !== undefined);
      setAccessKeyAddress(account
        ? await resolveTempoMppAccessKey(account).catch(() => undefined)
        : undefined);
    }).catch(() => setAuthorized(false)).finally(() => setCheckingAccessKey(false));
  }, [refreshAccount]);

  useEffect(() => {
    const accountsChanged = (accounts: readonly Address[]) => {
      const account = accounts[0];
      setAddress(account);
      setAuthorized(accounts.length > 0);
      setAccessKeyAddress(undefined);
      if (!account) {
        setCheckingAccessKey(false);
        onDisconnect();
        return;
      }
      setCheckingAccessKey(true);
      void resolveTempoMppAccessKey(account)
        .then(setAccessKeyAddress)
        .catch(() => setAccessKeyAddress(undefined))
        .finally(() => setCheckingAccessKey(false));
    };
    tempoAccount.on("accountsChanged", accountsChanged);
    return () => {
      tempoAccount.removeListener("accountsChanged", accountsChanged);
    };
  }, [onDisconnect]);

  const connect = useMutation({
    mutationFn: async () => {
      const result = await tempoAccount.request({ method: "wallet_connect" });
      const account = await refreshAccount();
      if (!account) throw new Error("Tempo Wallet connected without an account");
      setAuthorized(true);
      const preferredAccessKey = result.accounts[0]?.capabilities.keyAuthorization?.address;
      setAccessKeyAddress(await ensureTempoMppAccessKey(account, preferredAccessKey));
    },
  });
  const authorize = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Tempo account is disconnected");
      setAccessKeyAddress(await ensureTempoMppAccessKey(address));
    },
  });
  const disconnect = useMutation({
    mutationFn: async () => {
      onDisconnect();
      await tempoAccount.request({ method: "wallet_disconnect" });
      setAuthorized(false);
      setAddress(undefined);
      setAccessKeyAddress(undefined);
    },
  });
  const deposit = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Tempo account is disconnected");
      await tempoAccount.request({
        method: "wallet_deposit",
        params: [{
          address,
          amount: MPP_ACCESS_KEY_LIMIT,
          displayName: "Nanocodex",
          token: USDC_E,
        }],
      });
      await queryClient.invalidateQueries({ queryKey: ["tempo", "balances", address] });
    },
  });
  const balances = useQuery({
    queryKey: ["tempo", "balances", address],
    enabled: authorized && address !== undefined,
    refetchInterval: 5_000,
    retry: 2,
    queryFn: async () => {
      if (!address) throw new Error("Tempo account is disconnected");
      const client = tempoAccount.getClient();
      const [usdc, pathUsd] = await Promise.all([
        Actions.token.getBalance(client, { account: address, token: USDC_E }),
        Actions.token.getBalance(client, { account: address, token: PATH_USD }),
      ]);
      return { pathUsd, usdc };
    },
  });

  const minimumDeposit = parseUnits(MPP_MIN_WALLET_BALANCE, 6);
  const funded = balances.data !== undefined
    && (balances.data.usdc.amount >= minimumDeposit
      || balances.data.pathUsd.amount >= minimumDeposit);

  useEffect(() => {
    if (!authorized || !address || !accessKeyAddress || !funded) {
      reportedSession.current = undefined;
      return;
    }
    const session = `${address}:${accessKeyAddress}`;
    if (reportedSession.current === session) return;
    reportedSession.current = session;
    onReady(address, accessKeyAddress);
  }, [accessKeyAddress, address, authorized, funded, onReady]);

  const connected = authorized && address !== undefined;
  const ready = connected && funded && accessKeyAddress !== undefined;
  const connecting = connect.isPending;
  return (
    <aside className="agent-byok agent-mpp" aria-label="Tempo MPP payment">
      <div className="agent-byok-summary">
        <span>
          <i className={ready ? "is-ready" : ""} aria-hidden="true" />
          {ready
            ? "Tempo Wallet ready"
            : connected
              ? !accessKeyAddress
                  ? "Authorize Tempo MPP access to continue"
                  : "Fund Tempo Wallet to continue"
            : "Use Tempo Wallet for MPP"}
        </span>
        <div>
          {connected ? (
            <>
              {!checkingAccessKey && !accessKeyAddress ? (
                <button type="button" disabled={authorize.isPending} onClick={() => authorize.mutate()}>
                  Authorize MPP
                </button>
              ) : null}
              {!funded ? (
                <button type="button" disabled={deposit.isPending} onClick={() => deposit.mutate()}>
                  Add funds
                </button>
              ) : null}
              <button type="button" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={connecting}
              onClick={() => connect.mutate()}
            >
              Continue with Tempo Wallet
            </button>
          )}
        </div>
      </div>
      {connect.error ? <p className="agent-byok-error" role="alert">{connect.error.message}</p> : null}
      {authorize.error ? <p className="agent-byok-error" role="alert">{authorize.error.message}</p> : null}
      {disconnect.error ? <p className="agent-byok-error" role="alert">{disconnect.error.message}</p> : null}
      {deposit.error ? <p className="agent-byok-error" role="alert">{deposit.error.message}</p> : null}
      {balances.error ? (
        <p className="agent-byok-error" role="alert">Could not refresh Tempo balances.</p>
      ) : null}
      {connected ? (
        <dl className="agent-mpp-details">
          <Detail label="Tempo account" value={address} />
          <Detail label="Payer" value={payment?.rootAddress ?? address} />
          <Detail
            label="USDC.e"
            value={balances.data === undefined
              ? "—"
              : formatTokenBalance(balances.data.usdc.amount, "USDC.e")}
          />
          <Detail
            label="pathUSD"
            value={balances.data === undefined
              ? "—"
              : formatTokenBalance(balances.data.pathUsd.amount, "pathUSD")}
          />
          <Detail label="Signer" value={payment?.accessKeyAddress ?? accessKeyAddress ?? "Not authorized"} />
          <Detail label="Channel" value={payment?.channelId ?? "Opens on first paid request"} />
          <Detail label="Model authorized" value={payment ? formatTokenBalance(BigInt(payment.cumulative), "USDC.e") : "0 USDC.e"} />
          <Detail label="Mercator authorized" value={payment?.mcpCumulative ? formatTokenBalance(BigInt(payment.mcpCumulative), "USDC.e") : "0 USDC.e"} />
        </dl>
      ) : null}
      {jsonl.length ? (
        <details className="agent-mpp-jsonl">
          <summary>MPP run JSONL ({jsonl.length})</summary>
          <pre>{jsonl.join("\n")}</pre>
        </details>
      ) : null}
    </aside>
  );
}

function Detail({ label, value }: { label: string; value: string | undefined }) {
  return <><dt>{label}</dt><dd title={value}>{value}</dd></>;
}

function formatTokenBalance(amount: bigint, symbol: string) {
  return `${formatUnits(amount, 6)} ${symbol}`;
}
