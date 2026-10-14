import { Router, type IRouter } from "express";
import { getPrivateFile } from "../lib/objectStorage";

// Content-addressed, public application-authored exports; no user-supplied path.
export const DECK_DOWNLOADS = {
  pdf: "/objects/public-downloads/hro-architecture/75fd160a3ca8d572f13e9ab0b7b47da7c7ea1b36f4b1bc41256a30bd49c8fd8a.pdf",
  pptx: "/objects/public-downloads/hro-architecture/965814c459513a26a26675d682c2b513ecff4bf900a20d8490327b3b9acc0023.pptx",
} as const;

export function createSlideDeckRouter(fileFor = getPrivateFile): IRouter {
 const router: IRouter = Router();
 for (const format of ["pdf", "pptx"] as const) {
  router.get(format === "pdf" ? "/slide-deck" : "/slide-deck.pptx", async (_req, res) => {
    try {
      const [metadata] = await fileFor(DECK_DOWNLOADS[format]).getMetadata();
      res.attachment(`Autonomous-HRO-Agentic-Architecture.${format}`);
      res.type(format === "pdf" ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation");
      res.setHeader("Content-Length", String(metadata.size));
      res.setHeader("Cache-Control", "public, max-age=3600");
      fileFor(DECK_DOWNLOADS[format]).createReadStream().on("error", () => {
        if (res.headersSent) res.destroy();
        else res.status(503).end();
      }).pipe(res);
    } catch {
      res.status(503).json({ error: "The architecture download is temporarily unavailable." });
    }
  });
 }
 return router;
}

export default createSlideDeckRouter();
