-- Forward-only reconciliation after the two historical 0030 branches. Keep
-- both already-applied 0030 files immutable and use the next unique ordering.
-- Historical recovery fixtures can lack the tenant/portal branch entirely.
DO $$
BEGIN
  IF to_regclass('organizations') IS NULL
     OR to_regclass('onb_settings') IS NULL
     OR to_regclass('onb_cases') IS NULL
     OR to_regclass('onb_case_logistics') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "onb_settings" ("organization_id", "key", "value")
  SELECT
    "id",
    'day1_logistics_default',
    '{"orientationDate":null,"orientationTime":"09:30","timezone":"Etc/UTC","format":"hybrid","venueAddress":"Example HQ, 100 Demo Avenue, Sample City","googleMapsUrl":"https://maps.google.com/?q=Example+HQ+Demo+Avenue","meetingUrl":"https://meet.example.com/synthetic-day-one","reportingContact":"Alex Example — Demo People Team","arrivalInstructions":"Synthetic demo instructions: arrive 15 minutes early or join the example meeting link."}'
  FROM "organizations"
  ON CONFLICT ("organization_id", "key") DO NOTHING;

  INSERT INTO "onb_case_logistics" (
    "organization_id", "case_id", "orientation_date", "orientation_time",
    "timezone", "format", "venue_address", "google_maps_url", "meeting_url",
    "reporting_contact", "arrival_instructions"
  )
  SELECT
    cases."organization_id",
    cases."id",
    cases."joining_date",
    '09:30',
    'Etc/UTC',
    'hybrid',
    'Example HQ, 100 Demo Avenue, Sample City',
    'https://maps.google.com/?q=Example+HQ+Demo+Avenue',
    'https://meet.example.com/synthetic-day-one',
    'Alex Example — Demo People Team',
    'Synthetic demo instructions: arrive 15 minutes early or join the example meeting link.'
  FROM "onb_cases" AS cases
  ON CONFLICT ("organization_id", "case_id") DO NOTHING;
END $$;