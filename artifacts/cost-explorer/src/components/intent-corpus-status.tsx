import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface IntentCorpusStatusProps {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  onRetry: () => void;
  loading: ReactNode;
  children: ReactNode;
  errorTitle?: string;
}

interface IntentCorpusAvailabilityProps {
  isError: boolean;
  error: unknown;
  customIntentsAvailable?: boolean;
  warning?: string;
  isFetching: boolean;
  onRetry: () => void;
  unavailableActions?: string;
}

export function IntentCorpusAvailability({
  isError,
  error,
  customIntentsAvailable,
  warning,
  isFetching,
  onRetry,
  unavailableActions,
}: IntentCorpusAvailabilityProps) {
  if (!isError && customIntentsAvailable !== false) return null;

  const degraded = !isError && customIntentsAvailable === false;
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
        degraded
          ? "border-amber-500/30 bg-amber-500/10"
          : "border-destructive/30 bg-destructive/5"
      }`}
    >
      <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${degraded ? "text-amber-600" : "text-destructive"}`} />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {degraded ? "Custom intents are temporarily unavailable" : "Intent data could not be loaded"}
        </p>
        <p className="text-muted-foreground">
          {degraded
            ? warning
            : error instanceof Error
              ? error.message
              : "The intent service did not return a usable response."}
        </p>
        {unavailableActions && (
          <p className="mt-1 font-medium text-foreground">{unavailableActions}</p>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={isFetching}>
        {isFetching ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

export function IntentCorpusStatus({
  isLoading,
  isError,
  error,
  isFetching,
  onRetry,
  loading,
  children,
  errorTitle = "Intent Corpus could not be loaded",
}: IntentCorpusStatusProps) {
  if (isLoading) return <>{loading}</>;

  if (isError) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center">
        <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive" />
        <h2 className="font-semibold text-foreground">{errorTitle}</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "The intent service did not return a usable response."}
        </p>
        <Button className="mt-4 gap-2" onClick={onRetry} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? "Retrying…" : "Try again"}
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}