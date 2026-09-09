export function validateLogistics(input: Record<string, unknown>) {
  const clean = (key: string, max: number) => {
    const value = input[key];
    if (value == null || value === "") return null;
    if (typeof value !== "string" || value.trim().length > max) {
      throw new Error(`Invalid ${key}`);
    }
    return value.trim();
  };
  const format = clean("format", 16);
  if (format && !["physical", "remote", "hybrid"].includes(format)) {
    throw new Error("Invalid format");
  }
  const date = clean("orientationDate", 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid orientationDate");
  }
  const time = clean("orientationTime", 5);
  if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("Invalid orientationTime");
  }
  const timezone = clean("timezone", 100);
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      throw new Error("Invalid timezone");
    }
  }
  const googleMapsUrl = clean("googleMapsUrl", 1000);
  if (googleMapsUrl) {
    let url: URL;
    try {
      url = new URL(googleMapsUrl);
    } catch {
      throw new Error("Invalid Google Maps URL");
    }
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !(
        host === "maps.google.com" ||
        host === "www.google.com" ||
        host === "goo.gl" ||
        host === "maps.app.goo.gl"
      )
    ) {
      throw new Error("Invalid Google Maps URL");
    }
  }
  const meetingUrl = clean("meetingUrl", 1000);
  if (meetingUrl) {
    try {
      if (new URL(meetingUrl).protocol !== "https:") throw new Error();
    } catch {
      throw new Error("Invalid meeting URL");
    }
  }
  return {
    orientationDate: date,
    orientationTime: time,
    timezone,
    format,
    venueAddress: clean("venueAddress", 1000),
    googleMapsUrl,
    meetingUrl,
    reportingContact: clean("reportingContact", 500),
    arrivalInstructions: clean("arrivalInstructions", 4000),
  };
}