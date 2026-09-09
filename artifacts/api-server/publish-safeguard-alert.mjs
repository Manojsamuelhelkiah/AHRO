import { ReplitConnectors } from "@replit/connectors-sdk";
import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const ALERT_MARKER = ".system-alerts/tenant-safeguard-publish-blocked";
const ALERT_SUBJECT =
  "[Onboarding Control Tower] Production publish blocked by tenant safeguards";
const ALERT_BODY = [
  "The Onboarding Control Tower did not start because its tenant safeguards could not be trusted.",
  "",
  "No production traffic is being served by the blocked release.",
  "Review the deployment logs, correct the tenant-safeguard failure, and publish again.",
  "",
  "This alert intentionally omits database details and secrets.",
].join("\n");

function defaultAlertMarker() {
  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucketId) {
    throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID is not configured");
  }
  const storage = new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      type: "external_account",
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: { type: "json", subject_token_field_name: "access_token" },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
    retryOptions: {
      autoRetry: true,
      maxRetries: 2,
      maxRetryDelay: 1,
      totalTimeout: 4,
    },
  });
  return storage.bucket(bucketId).file(ALERT_MARKER);
}

export async function claimBlockedPublishAlert(marker) {
  try {
    await marker.save("", {
      resumable: false,
      contentType: "text/plain",
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return true;
  } catch (error) {
    if (error?.code === 412) return false;
    throw error;
  }
}

export async function clearBlockedPublishAlert(options = {}) {
  const marker = options.marker ?? defaultAlertMarker();
  await marker.delete({ ignoreNotFound: true });
}

export async function alertBlockedPublish(options = {}) {
  const to = (
    options.operatorEmail ??
    process.env.HR_ALERT_EMAIL ??
    process.env.ONBOARDING_HR_ALERT_EMAIL ??
    ""
  ).trim();
  if (!to) {
    console.error(
      "Blocked-publish operator alert skipped: no operator email is configured.",
    );
    return { claimed: false, sent: false };
  }

  const marker = options.marker ?? defaultAlertMarker();
  const claimed = await claimBlockedPublishAlert(marker);
  if (!claimed) {
    console.log("Blocked-publish operator alert already sent; suppressing retry.");
    return { claimed: false, sent: false };
  }

  try {
    const connectors = options.connectors ?? new ReplitConnectors();
    const raw = Buffer.from(
      [
        `To: ${to}`,
        `Subject: ${ALERT_SUBJECT}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        ALERT_BODY,
      ].join("\r\n"),
    ).toString("base64url");
    const response = await connectors.proxy(
      "google-mail",
      "/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      },
    );
    if (!response.ok) {
      await response.text();
      await clearBlockedPublishAlert({ marker });
      throw new Error(`operator email delivery failed (${response.status})`);
    }
    console.log("Blocked-publish operator alert sent.");
    return { claimed: true, sent: true };
  } catch (error) {
    // A thrown connector request has an ambiguous delivery outcome. Keep the
    // marker in that case so automatic retries cannot send duplicate mail.
    throw error;
  }
}