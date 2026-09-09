import { validateLogistics } from "./logistics-validation";

export type Day1Logistics = ReturnType<typeof validateLogistics>;

/**
 * Deliberately synthetic defaults make a fresh/demo tenant useful without
 * implying that the sample venue, contact, or meeting room is real.
 * orientationDate stays blank so each case receives its own joining date.
 */
export const SYNTHETIC_DAY1_LOGISTICS_DEFAULT: Readonly<Day1Logistics> = Object.freeze({
  orientationDate: null,
  orientationTime: "09:30",
  timezone: "Etc/UTC",
  format: "hybrid",
  venueAddress: "Example HQ, 100 Demo Avenue, Sample City",
  googleMapsUrl: "https://maps.google.com/?q=Example+HQ+Demo+Avenue",
  meetingUrl: "https://meet.example.com/synthetic-day-one",
  reportingContact: "Alex Example — Demo People Team",
  arrivalInstructions: "Synthetic demo instructions: arrive 15 minutes early or join the example meeting link.",
});

export function validateDay1LogisticsDefault(input: unknown): Day1Logistics {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Day-1 logistics default must be a JSON object.");
  }
  return validateLogistics(input as Record<string, unknown>);
}

export function parseDay1LogisticsDefault(value: string): Day1Logistics {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored Day-1 logistics default is not valid JSON.");
  }
  return validateDay1LogisticsDefault(parsed);
}

export function logisticsForCase(
  defaultLogistics: Day1Logistics,
  joiningDate: string,
): Day1Logistics {
  return {
    ...defaultLogistics,
    orientationDate: defaultLogistics.orientationDate || joiningDate,
  };
}