import { Router, type IRouter } from "express";
import path from "node:path";

const router: IRouter = Router();

const DECK_PATH = path.resolve(process.cwd(), "exports/hro-agentic-architecture.pdf");

router.get("/slide-deck", (_req, res) => {
  res.download(DECK_PATH, "Autonomous-HRO-Agentic-Architecture.pdf");
});

export default router;
