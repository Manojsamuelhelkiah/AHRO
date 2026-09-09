import { useCallback, useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import type { FlowDiagramView } from "@/components/flow-diagram";

export const PROCESS_VIEW_STORAGE_KEY = "cost-explorer.process-view";

export function parseProcessView(value: string | null): FlowDiagramView {
  return value === "technical" || value === "sipoc" || value === "bpmn"
    ? value
    : "bpmn";
}

function readInitialProcessView(): FlowDiagramView {
  if (typeof window === "undefined") return "bpmn";

  const urlView = new URLSearchParams(window.location.search).get("view");
  if (urlView !== null) return parseProcessView(urlView);

  try {
    return parseProcessView(window.localStorage.getItem(PROCESS_VIEW_STORAGE_KEY));
  } catch {
    return "bpmn";
  }
}

export function useProcessViewPreference() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const [processView, setProcessViewState] = useState<FlowDiagramView>(readInitialProcessView);

  useEffect(() => {
    const urlView = new URLSearchParams(search).get("view");
    if (urlView === null) return;

    const parsedView = parseProcessView(urlView);
    setProcessViewState(parsedView);
    try {
      window.localStorage.setItem(PROCESS_VIEW_STORAGE_KEY, parsedView);
    } catch {
      // Persistence is optional when storage is unavailable or blocked.
    }
  }, [search]);

  const setProcessView = useCallback((view: FlowDiagramView) => {
    setProcessViewState(view);
    try {
      window.localStorage.setItem(PROCESS_VIEW_STORAGE_KEY, view);
    } catch {
      // The in-memory and URL state still work when storage is unavailable.
    }

    const searchParams = new URLSearchParams(search);
    searchParams.set("view", view);
    setLocation(`${location}?${searchParams.toString()}${window.location.hash}`, { replace: true });
  }, [location, search, setLocation]);

  return [processView, setProcessView] as const;
}