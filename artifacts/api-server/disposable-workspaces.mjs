/** Reviewed historical IDs, not a name/prefix deletion policy. */
const uatSuffixes = [
  "17834-1ca3f121-7948-4de2-bca7-e8182752b758",
  "17895-d7997dcb-a9be-452f-b4ac-d3f1bfc893c3",
  "17947-fa054143-b925-40f8-b53b-6409459c9870",
  "17991-9b68350d-7229-4f92-8135-b31ff12b0b09",
  "18052-9dce03b2-6229-496f-8542-c5fbe6c4a4a5",
  "18250-f545ce5c-e913-44ed-bb72-d5d24e5537a2",
];
export const reviewedDisposableWorkspaces = [
  ...["30929-1788956777949-1295017a", "31145-1788956804554-e850958f"].map(suffix => ({
    id: `candidate-security-b-${suffix}`,
    name: "Candidate Security B",
    slug: `candidate-security-b-${suffix}`,
    creator: `candidate-security-user-${suffix}`,
    evidence: "src/routes/candidate-portal-security.test.ts: paired IDs, shared fixture creator and slug; empty B tenant",
  })),
  ...uatSuffixes.map(suffix => ({
    id: `uat-center-${suffix}-b`,
    name: `uat-center-${suffix}-b`,
    slug: `uat-center-${suffix}-b`,
    creator: `uat-center-${suffix}-actor`,
    evidence: "Retired src/lib/onboarding/uat-test-center.test.ts: exact paired-ID and actor construction; empty B tenant",
  })),
];
