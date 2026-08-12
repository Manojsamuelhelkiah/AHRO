import { Router, type IRouter } from "express";
import path from "node:path";

const router: IRouter = Router();

const PDF_PATH = path.resolve(process.cwd(), "exports/hro-agentic-architecture.pdf");
const PPTX_PATH = path.resolve(process.cwd(), "exports/hro-agentic-architecture.pptx");

router.get("/slide-deck", (_req, res) => {
  res.download(PDF_PATH, "Autonomous-HRO-Agentic-Architecture.pdf");
});

router.get("/slide-deck.pptx", (_req, res) => {
  res.download(PPTX_PATH, "Autonomous-HRO-Agentic-Architecture.pptx");
});

export default router;
