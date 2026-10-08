import type { Request, Response, NextFunction } from "express";
import { openHroContext, closeHroContext } from "../lib/hro-context/manager";
import { runInHroContext, workflowForHroPath } from "../lib/hro-context/core";

/** Installed only AFTER authenticated membership/tenant resolution. */
export async function hroRequestContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Express strips mount prefixes from req.path for organization subrouters.
  const workflow = workflowForHroPath(req.path) ??
    workflowForHroPath(req.baseUrl.replace(/^\/api(?=\/|$)/, ""));
  if (!workflow || !req.organizationId || !req.authUserId ||
      ["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  try {
    const frame = await openHroContext({
      organizationId: req.organizationId, workflow, subjectType: "tenant",
      subjectId: req.organizationId, initiatingUserId: req.authUserId,
    });
    res.setHeader("X-HRO-Transaction-Id", frame.id);
    res.setHeader("X-HRO-Correlation-Id", frame.correlationId);
    await runInHroContext(frame, () => new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        const status = res.writableFinished && res.statusCode < 400 ? "completed" : "failed";
        void closeHroContext(frame, status).catch(() => {
          // Never log provider/error payloads. A still-running row truthfully
          // remains unfinished if durable finalization could not be recorded.
          req.log.error({ transactionId: frame.id }, "HRO context finalization failed");
        }).finally(resolve);
      };
      res.once("finish", finish);
      res.once("close", finish);
      next();
    }));
  } catch (error) {
    next(error);
  }
}
