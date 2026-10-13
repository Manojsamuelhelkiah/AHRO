import { Router } from "express";
import { UpdateClientOperationsSettingsBody } from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { isPlatformSuperAdmin } from "../lib/private-platform-admin";
import {
  ClientOperationsError, clientRoutingGroups, currentClientOperationsAccess, loadClientOperations, saveClientOperations,
} from "../lib/onboarding/client-operations-settings";

const router = Router();
router.get("/organizations/current/settings/operations", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const settings = await loadClientOperations(organizationId);
    const groups = await clientRoutingGroups(organizationId);
    const { canRead, canEdit } = await currentClientOperationsAccess(organizationId, req.authUserId!);
    if (!canRead) { res.status(403).json({ message: "Your client access has ended." }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...settings, canEdit,
      configuration: { ...settings.configuration, routingRules: canEdit ? settings.configuration.routingRules : [] },
      groups: canEdit ? groups : [],
    });
  } catch (error) { next(error); }
});
router.put("/organizations/current/settings/operations", async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    if (req.organizationRole !== "owner" && !isPlatformSuperAdmin(req.authUserId!, organizationId)) {
      res.status(403).json({ message: "An active organization owner or Super Admin must change client settings." }); return;
    }
    const body = UpdateClientOperationsSettingsBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ message: "Invalid client settings request." }); return; }
    const result = await saveClientOperations(organizationId, req.authUserId!, body.data.expectedVersion, body.data.configuration);
    const groups = await clientRoutingGroups(organizationId);
    const { canEdit } = await currentClientOperationsAccess(organizationId, req.authUserId!);
    if (!canEdit) { res.status(403).json({ message: "Client settings access ended after the save. Refresh your session." }); return; }
    res.json({ ...result, canEdit: true, groups });
  } catch (error) {
    if (error instanceof ClientOperationsError) { res.status(error.status).json({ message: error.message }); return; }
    next(error);
  }
});
export default router;
