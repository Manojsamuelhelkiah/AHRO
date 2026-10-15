import { z } from "zod";
import type { PilotTask } from "./exchange-contract";

export const SourceHandling = z.object({
  sharedAccountOwner: z.string().min(1).max(160).optional(),
  ktRequired: z.boolean().optional(),
  ktOwner: z.string().min(1).max(160).optional(),
  ktExpiresAt: z.string().datetime().optional(),
  ktAuthorizationReference: z.string().min(1).max(256).optional(),
}).strict();
export type SourceHandling = z.infer<typeof SourceHandling>;

export function authoredStatement(statement: string): string {
  return statement.split(/(?:^|\r?\n)\s*(?:On .+wrote:|From:|>{1,}|-{2,}\s*(?:Forwarded|Original) message|Begin forwarded message:)/i)[0];
}
/** Only explicit authored fields, never model inference, quoted text or labels
 * that grant authority. Membership checks remain at the mutation boundary. */
export function sourceHandling(task: PilotTask, statement: string, clock: string): { handling: SourceHandling | null; question: string } {
  if (!["shared-accounts", "kt-access-exception"].includes(task.id)) return { handling: null, question: "" };
  const authored = authoredStatement(statement);
  const field = (name: string) => {
    const values = authored.split(/\r?\n/).map(v => v.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "i"))?.[1]).filter((v): v is string => !!v);
    return values.length === 1 ? values[0] : undefined;
  };
  if (task.id === "shared-accounts") {
    const parsed = SourceHandling.safeParse({ sharedAccountOwner: field("Shared account owner") });
    return parsed.success && parsed.data.sharedAccountOwner ? { handling: parsed.data, question: "" } :
      { handling: null, question: "Who is the current named member taking ownership? Reply with Shared account owner: <member id>." };
  }
  const required = field("KT required")?.toLowerCase();
  if (required === "no") return { handling: { ktRequired: false }, question: "" };
  if (required === "yes") {
    const parsed = SourceHandling.safeParse({ ktRequired: true, ktOwner: field("KT owner"), ktExpiresAt: field("KT expiry"), ktAuthorizationReference: field("KT authorization") });
    if (parsed.success && parsed.data.ktOwner && parsed.data.ktExpiresAt && parsed.data.ktAuthorizationReference &&
        Date.parse(parsed.data.ktExpiresAt) > Math.max(Date.now(), Date.parse(clock))) return { handling: parsed.data, question: "" };
  }
  return { handling: null, question: "Reply with KT required: no, or KT required: yes plus KT owner: <member id>, KT expiry: <future ISO timestamp> and KT authorization: <reviewed source reference>." };
}
