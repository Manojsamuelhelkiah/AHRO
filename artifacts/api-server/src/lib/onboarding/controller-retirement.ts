/**
 * Historical provenance is a deny fence, not fictional identity or authority.
 * Never remove it from a retained case, even after the former run is pruned.
 */
export function isRetiredControllerCase(row: {
  controllerRetired?: boolean;
  notes?: string | null;
  syntheticProvenance?: string | null;
  candidateEmailAuthorizedBy?: string | null;
  checklistProfileId?: string | null;
  orchestrationCheckpoint?: string | null;
}): boolean {
  return row.controllerRetired === true ||
    row.syntheticProvenance === "demo-controller-fictional" ||
    row.candidateEmailAuthorizedBy === "demo-controller" ||
    row.checklistProfileId === "demo-controller" ||
    row.orchestrationCheckpoint?.startsWith("demo-controller") === true ||
    /\[demo-controller-run:/i.test(row.notes ?? "");
}

/** Country labels are not inferred from regional or legal-entity names. */
export function normalizedWorkCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const countries: Record<string, string> = {
    canada: "CA", ca: "CA", australia: "AU", au: "AU",
    india: "IN", in: "IN", "united states": "US", usa: "US", us: "US",
    "united kingdom": "GB", uk: "GB", gb: "GB", germany: "DE", de: "DE",
    france: "FR", fr: "FR", "united arab emirates": "AE", uae: "AE", ae: "AE",
    japan: "JP", jp: "JP", "south africa": "ZA", za: "ZA", singapore: "SG", sg: "SG",
  };
  return countries[value.trim().toLowerCase()] ?? null;
}
