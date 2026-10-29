import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Switch } from "@/components/ui/switch.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkbuddyPanelProps } from "./contract.js";
import { useWorkbuddy } from "./useWorkbuddy.js";
import { WorkbuddyModelInfo } from "./WorkbuddyModelInfo.js";
import { WorkbuddyModelSummary } from "./WorkbuddyModelSummary.js";

export function WorkbuddyPanel({
  provider,
  onSave,
  onDelete,
  onSetPersonalModelEnabled,
}: WorkbuddyPanelProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  const { state, busy, error, run, setError } = useWorkbuddy(provider.providerId);
  const [name, setName] = useState(provider.providerName || "WorkBuddy");
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [loginText, setLoginText] = useState("");
  const [transferMessage, setTransferMessage] = useState("");
  useEffect(() => {
    setLoginText("");
    setImportOpen(false);
    setTransferMessage("");
  }, [provider.providerId]);
  const t = (id: string) => intl.formatMessage({ id: `workbuddy.${id}` });
  const pendingId = state?.pendingLogin?.id;
  useEffect(() => {
    if (!pendingId) return;
    const timer = setInterval(() => {
      void run("poll", pendingId);
    }, 3000);
    return () => clearInterval(timer);
  }, [pendingId, run]);

  const save = async (operation: () => Promise<unknown> | void) => {
    setSaving(true);
    setError("");
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("failed"));
    } finally {
      setSaving(false);
    }
  };
  const disabled = busy || saving;
  const benefits = state?.benefits;
  const date = (value: number) => new Date(value).toLocaleString(locale);
  return (
    <section
      className="space-y-5"
      data-testid="workbuddy-panel"
      data-provider-id={provider.providerId}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-ui-lg font-semibold">{t("title")}</h2>
        <label className="flex items-center gap-2 text-ui-caption">
          <span>{t("enabled")}</span>
          <Switch
            checked={provider.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              void save(() => onSave({ ...provider, enabled, enabledUpdate: enabled }))
            }
          />
        </label>
      </div>
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1 space-y-2 text-ui-caption">
          <span>{t("name")}</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            data-testid="workbuddy-name"
          />
        </label>
        <Button
          variant="outline"
          disabled={disabled || !name.trim() || name === provider.providerName}
          onClick={() =>
            void save(() =>
              onSave({ ...provider, providerName: name.trim(), providerNameUpdate: name.trim() }),
            )
          }
        >
          {t("save")}
        </Button>
      </div>
      <div className="space-y-2 rounded-lg border border-border p-4">
        <label className="flex items-center justify-between gap-3 text-ui-caption">
          <span>{t("fallback")}</span>
          <Switch
            checked={state?.allowModelFallback ?? false}
            disabled={disabled || !state}
            data-testid="workbuddy-model-fallback"
            onCheckedChange={(enabled) => void run("set-model-fallback", enabled)}
          />
        </label>
        <p className="text-ui-sm text-foreground-subtle">{t("fallbackHelp")}</p>
      </div>
      <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <p className="text-ui-base" data-testid="workbuddy-account-status">
          {state
            ? state.connected
              ? `${t("connected")}${state.accountName ? ` · ${state.accountName}` : ""}`
              : t("disconnected")
            : t("loading")}
        </p>
        {state?.connected && state.accountId && (
          <p
            className="break-all text-ui-caption text-foreground-subtle"
            data-testid="workbuddy-account-id"
          >
            {intl.formatMessage({ id: "workbuddy.accountId" }, { id: state.accountId })}
          </p>
        )}
        {state?.profileError && (
          <p className="text-ui-caption text-warning">{state.profileError}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled}
            data-testid="workbuddy-login"
            onClick={() =>
              void run("login").then((next) => {
                if (next?.pendingLogin) platform.openExternal(next.pendingLogin.authUrl);
              })
            }
          >
            {t(state?.connected ? "relogin" : "login")}
          </Button>
          {state?.connected && (
            <>
              <Button variant="outline" disabled={disabled} onClick={() => void run("refresh")}>
                {t("refresh")}
              </Button>
              <Button variant="ghost" disabled={disabled} onClick={() => void run("logout")}>
                {t("logout")}
              </Button>
            </>
          )}
          <Button
            variant="outline"
            disabled={disabled}
            data-testid="workbuddy-import-login"
            onClick={() => {
              setTransferMessage("");
              setImportOpen((value) => !value);
              setLoginText("");
            }}
          >
            {t("importLogin")}
          </Button>
          {state?.connected && (
            <Button
              variant="outline"
              disabled={disabled}
              data-testid="workbuddy-export-login"
              onClick={() =>
                void save(async () => {
                  setTransferMessage("");
                  if (!navigator.clipboard?.writeText) throw new Error(t("clipboardFailed"));
                  const result = await run("export-login");
                  if (result?.loginExport) {
                    try {
                      await navigator.clipboard.writeText(result.loginExport);
                    } catch {
                      throw new Error(t("clipboardFailed"));
                    }
                    setTransferMessage(t("loginCopied"));
                  }
                })
              }
            >
              {t("exportLogin")}
            </Button>
          )}
        </div>
        <p className="text-ui-sm text-foreground-subtle">{t("loginTransferHelp")}</p>
        {transferMessage && (
          <p role="status" className="text-ui-caption">
            {transferMessage}
          </p>
        )}
        {importOpen && (
          <div className="space-y-2">
            <Textarea
              aria-label={t("loginPaste")}
              data-testid="workbuddy-login-text"
              value={loginText}
              maxLength={65536}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setLoginText(event.target.value)}
              placeholder={t("loginPaste")}
            />
            <div className="flex gap-2">
              <Button
                disabled={disabled || !loginText.trim()}
                onClick={() =>
                  void run("import-login", loginText).then((result) => {
                    if (result) {
                      setLoginText("");
                      setImportOpen(false);
                      setTransferMessage(t("loginImported"));
                    }
                  })
                }
              >
                {t("confirmImport")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setLoginText("");
                  setImportOpen(false);
                }}
              >
                {t("closeImport")}
              </Button>
            </div>
          </div>
        )}
        {state?.pendingLogin && (
          <div className="space-y-2 text-ui-caption">
            <p role="status">{t("waiting")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => platform.openExternal(state.pendingLogin!.authUrl)}
              >
                {t("openLogin")}
              </Button>
              <Button variant="ghost" disabled={disabled} onClick={() => void run("cancel-login")}>
                {t("cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
      {state?.connected && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
              <h3 className="text-ui-base font-medium">{t("credits")}</h3>
              <p className="text-ui-xl font-semibold" data-testid="workbuddy-balance">
                {benefits?.credits ? number.format(benefits.credits.remaining) : "—"}
              </p>
              {benefits?.creditsError && (
                <p className="text-ui-caption text-warning">{benefits.creditsError}</p>
              )}
              {benefits?.credits?.packages.map((pack, index) => (
                <div key={index} className="text-ui-caption text-foreground-subtle">
                  <p>
                    {pack.name} · {number.format(pack.remaining)}
                  </p>
                  {pack.expiresAt && (
                    <p>
                      {intl.formatMessage(
                        { id: "workbuddy.expiry" },
                        { date: date(pack.expiresAt) },
                      )}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <h3 className="text-ui-base font-medium">
                {benefits?.checkin?.title || t("checkinTitle")}
              </h3>
              <p className="text-ui-caption">
                {benefits?.checkin
                  ? t(
                      benefits.checkin.todayCheckedIn
                        ? "checkedIn"
                        : benefits.checkin.active
                          ? "notCheckedIn"
                          : "inactive",
                    )
                  : "—"}
              </p>
              {benefits?.checkin && (
                <p className="text-ui-caption text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "workbuddy.streak" },
                    {
                      days: benefits.checkin.streakDays ?? "—",
                      credits: benefits.checkin.totalCredits ?? "—",
                    },
                  )}
                </p>
              )}
              <Button
                variant="outline"
                data-testid="workbuddy-checkin"
                disabled={disabled || !benefits?.checkin?.active || benefits.checkin.todayCheckedIn}
                onClick={() => void run("checkin")}
              >
                {t("checkin")}
              </Button>
              {benefits?.checkinError && (
                <p className="text-ui-caption text-warning">{benefits.checkinError}</p>
              )}
            </div>
          </div>
          {benefits && (
            <p className="text-ui-caption text-foreground-subtlest">
              {intl.formatMessage({ id: "workbuddy.updated" }, { date: date(benefits.checkedAt) })}
            </p>
          )}
        </>
      )}
      <p className="text-ui-caption text-foreground-subtle">{t("background")}</p>
      {state?.message && (
        <p role="status" className="text-ui-caption">
          {state.message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-ui-caption text-destructive">
          {error}
        </p>
      )}
      <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-ui-base font-medium">{t("models")}</h3>
          <Button
            variant="outline"
            disabled={disabled}
            data-testid="workbuddy-sync"
            onClick={() => void run("sync-models")}
          >
            {t("sync")}
          </Button>
        </div>
        <p className="text-ui-caption text-foreground-subtle">
          {t(state?.modelSource === "account" ? "onlineCatalog" : "snapshotCatalog")}
        </p>
        {state?.modelSyncError && (
          <p className="text-ui-caption text-warning">{state.modelSyncError}</p>
        )}
        <div className="divide-y divide-border">
          {provider.models.map((model) => {
            const catalog = state?.models?.find((item) => item.id === model.modelId);
            return (
              <label key={model.modelId} className="flex items-center gap-3 py-3 text-ui-caption">
                <input
                  type="checkbox"
                  checked={model.config.enabled !== false}
                  disabled={disabled || !!catalog?.disabled || !onSetPersonalModelEnabled}
                  onChange={(e) =>
                    void save(() =>
                      onSetPersonalModelEnabled!(
                        provider.providerId,
                        model.modelId,
                        e.target.checked,
                      ),
                    )
                  }
                />
                <span className="min-w-0 flex-1 break-words">{catalog?.name || model.modelId}</span>
                {catalog ? <WorkbuddyModelSummary model={catalog} /> : <span>{t("unknown")}</span>}
                {catalog ? (
                  <WorkbuddyModelInfo
                    model={catalog}
                    updatedAt={state?.modelDetailsUpdatedAt}
                    error={state?.modelDetailsError}
                  />
                ) : null}
              </label>
            );
          })}
        </div>
      </div>
      <div className="space-y-1 text-ui-caption text-foreground-subtle">
        <p>
          {state?.usage
            ? intl.formatMessage(
                { id: "workbuddy.usage" },
                { credits: number.format(state.usage.credits) },
              )
            : t("usagePending")}
        </p>
        <p>{t("usageHelp")}</p>
        {!!state?.usage?.unreportedRequests && (
          <p>
            {intl.formatMessage(
              { id: "workbuddy.unreported" },
              { count: state.usage.unreportedRequests },
            )}
          </p>
        )}
      </div>
      <Button
        variant="destructive"
        disabled={disabled}
        onClick={() => void save(() => onDelete(provider))}
      >
        {t("delete")}
      </Button>
    </section>
  );
}
