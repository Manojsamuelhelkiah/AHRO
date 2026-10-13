import { and, eq, like, sql, type SQLWrapper } from "drizzle-orm";
import { activationRecord } from "./operational-eligibility";
import { db, onbCases, onbSettings } from "@workspace/db";

/**
 * UAT run ownership is deliberately split between a cheap, durable case
 * fence and the authoritative run ledger. `scenarioKey` is copied into the
 * case when the server creates it and must survive privacy minimisation; the
 * run ledger proves that a particular case belongs to a particular tenant run.
 *
 * Never use notes, names, addresses, or a Demo Organization membership to
 * classify a UAT case. Those fields are mutable and/or not run-scoped.
 */
export const UAT_RUN_SETTING_PREFIX = "onboarding-uat.run.v1:";
export const UAT_SCENARIO_KEY_PREFIX = "UAT-";

type UatRunLink = {
  runId?: unknown;
  linkedCaseIds?: unknown;
};

export type UatIsolationCase = {
  organizationId: string;
  id: number;
  scenarioKey?: string | null;
};

export type UatCaseIsolation = {
  /** A persistent case field says ordinary work must fail closed. */
  fencedByScenarioKey: boolean;
  /** A valid same-tenant UAT run ledger explicitly owns this case. */
  linkedToRun: boolean;
  /** Either signal is enough to deny ordinary workers/providers. */
  isolated: boolean;
};

export function hasUatScenarioKey(
  row: Pick<UatIsolationCase, "scenarioKey">,
): boolean {
  return typeof row.scenarioKey === "string" &&
    row.scenarioKey.startsWith(UAT_SCENARIO_KEY_PREFIX);
}

/**
 * SQL counterpart to the durable UAT fence, for use before a bounded worker
 * batch is selected or atomically claimed. The JSON predicate deliberately
 * validates the text setting before casting it: arbitrary control-tower
 * setting values must neither crash a worker nor make a linked UAT case live.
 *
 * The authoritative TypeScript lookup remains required after selection for
 * worker operations. This predicate prevents a backlog of UAT rows from
 * consuming a limited batch before that final fence can run.
 */
export function ordinaryCaseSql(
  organizationId: SQLWrapper,
  caseId: SQLWrapper,
  recordCreatedAt?: SQLWrapper,
) {
  return sql`
    not exists (
      select 1
      from ${onbCases} uat_case
      where uat_case.organization_id = ${organizationId}
        and uat_case.id = ${caseId}
        and (
          (coalesce(uat_case.scenario_key, '') like ${`${UAT_SCENARIO_KEY_PREFIX}%`}
            and not coalesce((
              uat_case.operational_activation->>'schema' = 'offline-case-activation/v1'
              and uat_case.operational_activation->>'organizationId' = uat_case.organization_id
              and uat_case.operational_activation->>'caseId' = uat_case.id::text
              and uat_case.operational_activation->>'sourceKey' = uat_case.scenario_key
              and ${recordCreatedAt
                ? sql`${recordCreatedAt} >= coalesce(uat_case.operational_activation->>'generationStartedAt',
                    uat_case.operational_activation->>'activatedAt')::timestamptz`
                : sql`true`}
            ), false))
          or exists (
            select 1
            from ${onbSettings} uat_run
            where uat_run.organization_id = uat_case.organization_id
              and uat_run.key like ${`${UAT_RUN_SETTING_PREFIX}%`}
              and jsonb_typeof(
                case
                  when uat_run.value is json object then uat_run.value::jsonb
                  else '{}'::jsonb
                end
              ) = 'object'
              and jsonb_typeof(
                case
                  when uat_run.value is json object then uat_run.value::jsonb -> 'runId'
                  else null
                end
              ) = 'string'
              and jsonb_typeof(
                case
                  when uat_run.value is json object then uat_run.value::jsonb -> 'linkedCaseIds'
                  else null
                end
              ) = 'array'
              and (
                case
                  when uat_run.value is json object then uat_run.value::jsonb -> 'linkedCaseIds'
                  else '[]'::jsonb
                end
              ) @> jsonb_build_array(to_jsonb(uat_case.id))
          )
        )
    )
  `;
}

function linkedCaseIds(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value) as UatRunLink;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      typeof parsed.runId !== "string" || !Array.isArray(parsed.linkedCaseIds) ||
      !parsed.linkedCaseIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return null;
    }
    return parsed.linkedCaseIds;
  } catch {
    return null;
  }
}

/**
 * Resolve UAT isolation from the organization-scoped durable run ledger.
 * A malformed UAT ledger never authorizes a case; a reserved `UAT-` case key
 * still fences ordinary work so corruption cannot turn it live.
 */
export async function getUatCaseIsolation(
  input: Pick<UatIsolationCase, "organizationId" | "id"> &
    Partial<Pick<UatIsolationCase, "scenarioKey">>,
  readDb: Pick<typeof db, "select"> = db,
): Promise<UatCaseIsolation> {
  let scenarioKey = input.scenarioKey;
  if (scenarioKey === undefined) {
    const [caseRow] = await readDb.select({ scenarioKey: onbCases.scenarioKey })
      .from(onbCases)
      .where(and(
        eq(onbCases.organizationId, input.organizationId),
        eq(onbCases.id, input.id),
      ));
    scenarioKey = caseRow?.scenarioKey;
  }
  const [current] = await readDb.select().from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.id),
  ));
  const fencedByScenarioKey = hasUatScenarioKey({ scenarioKey: current?.scenarioKey ?? scenarioKey }) &&
    !activationRecord(current ?? {});
  const rows = await readDb.select({ value: onbSettings.value }).from(onbSettings)
    .where(and(
      eq(onbSettings.organizationId, input.organizationId),
      like(onbSettings.key, `${UAT_RUN_SETTING_PREFIX}%`),
    ));
  const linkedToRun = rows.some((row) => linkedCaseIds(row.value)?.includes(input.id));
  const uncertainOwnership = Boolean(current?.operationalActivation) && rows.some(row => linkedCaseIds(row.value) === null);
  return {
    fencedByScenarioKey,
    linkedToRun,
    isolated: fencedByScenarioKey || linkedToRun || uncertainOwnership,
  };
}

/** The explicit portal/upload exception requires an authoritative run link. */
export async function isAuthoritativelyUatRunOwnedCase(
  input: Pick<UatIsolationCase, "organizationId" | "id"> &
    Partial<Pick<UatIsolationCase, "scenarioKey">>,
): Promise<boolean> {
  const isolation = await getUatCaseIsolation(input);
  return isolation.fencedByScenarioKey && isolation.linkedToRun;
}

/** One tenant-ledger read for list presentation; same validation as isolation. */
export async function authoritativelyUatRunOwnedCaseIds(
  organizationId: string,
  cases: readonly UatIsolationCase[],
): Promise<Set<number>> {
  const eligible = cases.filter(row => row.organizationId === organizationId && hasUatScenarioKey(row));
  if (!eligible.length) return new Set();
  const rows = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId), like(onbSettings.key, `${UAT_RUN_SETTING_PREFIX}%`),
  ));
  const linked = new Set(rows.flatMap(row => linkedCaseIds(row.value) ?? []));
  return new Set(eligible.filter(row => linked.has(row.id)).map(row => row.id));
}
