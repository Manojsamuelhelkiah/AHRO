import { Router, type IRouter } from "express";
import {
  DraftOnboardingChecklistProfileBody,
  DraftOnboardingChecklistProfileResponse,
} from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { isChecklistAdministrator } from "../lib/onboarding/checklist";
import {
  ChecklistProfileDraftFailure,
  draftChecklistProfileFromDescription,
} from "../lib/onboarding/checklist-profile-draft";

const router: IRouter = Router();

router.post("/onboarding/checklist-profiles/draft-from-description", async (req, res, next): Promise<void> => {
  if (!isChecklistAdministrator(req.organizationRole)) {
    res.status(403).json({ message: "Organization owner or admin HR role required for checklist profile drafting." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
  if (!body || Object.keys(body).some((key) => key !== "description")) {
    res.status(400).json({
      code: "invalid-request",
      message: "Only a description field is accepted.",
    });
    return;
  }
  const parsed = DraftOnboardingChecklistProfileBody.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({
      code: "invalid-request",
      message: parsed.error.message,
    });
    return;
  }
  if (!parsed.data.description.trim()) {
    res.status(400).json({
      code: "invalid-request",
      message: "description must contain non-whitespace text.",
    });
    return;
  }

  try {
    const result = await draftChecklistProfileFromDescription(
      getOrganizationId(req),
      parsed.data.description,
    );
    res.json(DraftOnboardingChecklistProfileResponse.parse(result));
  } catch (error) {
    if (error instanceof ChecklistProfileDraftFailure) {
      const status = error.code === "invalidAI"
        ? 502
        : error.unsupportedRequests.length > 0 ? 422 : 503;
      res.status(status).json({
        code: error.code,
        message: error.message,
        ...(error.unsupportedRequests.length > 0
          ? { unsupportedRequests: error.unsupportedRequests }
          : {}),
      });
      return;
    }
    next(error);
  }
});

export default router;