import { InputValidationError } from "../validate-inputs";

export type ScenarioSystemSetupMode =
  | "direct-integration"
  | "email-watch"
  | "file-transfer"
  | "webhook"
  | "manual";

type ScenarioSetupData = {
  systems: Array<{
    key: string;
    mode: ScenarioSystemSetupMode;
  }>;
};

type SetupModeOption = {
  mode: ScenarioSystemSetupMode;
  label: string;
  description: string;
};

export type SystemSetupCapability = {
  key: string;
  label: string;
  description: string;
  modes: readonly SetupModeOption[];
  watcherSystem?: "bgv" | "itsm" | "payroll";
};

const DIRECT: SetupModeOption = {
  mode: "direct-integration",
  label: "Direct integration",
  description: "Connect through the system's supported API or provider adapter.",
};
const EMAIL: SetupModeOption = {
  mode: "email-watch",
  label: "Email watch",
  description: "Track status emails sent to the watched mailbox; this does not grant system access.",
};
const FILE: SetupModeOption = {
  mode: "file-transfer",
  label: "File transfer",
  description: "Exchange approved structured files without a live system connection.",
};
const WEBHOOK: SetupModeOption = {
  mode: "webhook",
  label: "Webhook",
  description: "Receive authenticated events pushed by the source system.",
};
const MANUAL: SetupModeOption = {
  mode: "manual",
  label: "Manual",
  description: "Keep the work human-operated; no mailbox or system monitoring is activated.",
};

export const SYSTEM_SETUP_CAPABILITIES: readonly SystemSetupCapability[] = [
  { key: "ats", label: "ATS / Recruiting", description: "Offer and pre-hire intake.", modes: [DIRECT, WEBHOOK, FILE, MANUAL] },
  { key: "hris", label: "HRIS / Core HR", description: "Worker identity and employment records.", modes: [DIRECT, FILE, MANUAL] },
  { key: "identity", label: "Identity & Access (IAM)", description: "Corporate identity and access provisioning.", modes: [DIRECT, MANUAL] },
  { key: "lms", label: "Learning (LMS)", description: "Learning assignments and completion records.", modes: [FILE, MANUAL] },
  { key: "itsm", label: "ITSM / Ticketing", description: "Access and equipment service requests.", modes: [DIRECT, EMAIL, MANUAL], watcherSystem: "itsm" },
  { key: "payroll", label: "Payroll & Benefits", description: "Payroll and benefits activation readiness.", modes: [DIRECT, EMAIL, FILE, MANUAL], watcherSystem: "payroll" },
  { key: "leave", label: "Leave / Time", description: "Absence and time records.", modes: [DIRECT, FILE, MANUAL] },
  { key: "compliance", label: "Compliance / Policy", description: "Policy and compliance source material.", modes: [FILE, MANUAL] },
  { key: "esignature", label: "E-Signature & Documents", description: "Document signature and completion tracking.", modes: [DIRECT, WEBHOOK, MANUAL] },
  { key: "communications", label: "Communications", description: "Employee messaging and collaboration.", modes: [DIRECT, MANUAL] },
  { key: "bgv", label: "Background Verification", description: "Background verification status and exceptions.", modes: [DIRECT, EMAIL, MANUAL], watcherSystem: "bgv" },
] as const;

const CAPABILITY_BY_KEY = new Map(SYSTEM_SETUP_CAPABILITIES.map((capability) => [capability.key, capability]));

export function canActivateSystemSetup(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function validateSystemSetup(setupData: ScenarioSetupData | null | undefined): void {
  if (!setupData) return;
  const seen = new Set<string>();
  for (const system of setupData.systems) {
    const capability = CAPABILITY_BY_KEY.get(system.key);
    if (!capability) {
      throw new InputValidationError(`Unsupported Client Setup system "${system.key}"`);
    }
    if (seen.has(system.key)) {
      throw new InputValidationError(`Client Setup system "${capability.label}" is selected more than once`);
    }
    seen.add(system.key);
    if (!capability.modes.some(({ mode }) => mode === system.mode)) {
      throw new InputValidationError(
        `${capability.label} does not support setup mode "${system.mode}"`,
      );
    }
  }
}

export function selectedWatcherConfigurations(
  setupData: ScenarioSetupData | null | undefined,
): Array<{
  connectorKey: string;
  system: "bgv" | "itsm" | "payroll";
  trackingMode: "api" | "email";
  status: "connected" | "disconnected";
}> {
  if (!setupData) return [];
  return setupData.systems.flatMap((system) => {
    const capability = CAPABILITY_BY_KEY.get(system.key);
    if (!capability?.watcherSystem) {
      return [];
    }
    return [{
      connectorKey: capability.key,
      system: capability.watcherSystem,
      trackingMode: system.mode === "email-watch" ? "email" as const : "api" as const,
      status: system.mode === "direct-integration" || system.mode === "email-watch"
        ? "connected" as const
        : "disconnected" as const,
    }];
  });
}

export function connectorUpdateForSetupSelection(
  current: {
    trackingMode: string;
    configurationProvenance: "trusted-provider" | "simulated";
  },
  selection: ReturnType<typeof selectedWatcherConfigurations>[number],
): {
  trackingMode: "api" | "email";
  status: "connected" | "disconnected";
  configurationProvenance: "trusted-provider" | "simulated";
} {
  return {
    trackingMode: selection.trackingMode,
    status: selection.status,
    configurationProvenance:
      current.trackingMode === selection.trackingMode
        ? current.configurationProvenance
        : "simulated",
  };
}