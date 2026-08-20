import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, pricingSheetsTable } from "@workspace/db";
import {
  CreatePricingSheetBody,
  CreatePricingSheetResponse,
  GetPricingSheetResponse,
  ListPricingSheetsResponse,
  UpdatePricingSheetBody,
  UpdatePricingSheetResponse,
} from "@workspace/api-zod";
import {
  calculatePricingModel,
  extractPricingRecommendation,
  normalizePricingInputs,
  type PricingInputs,
} from "@workspace/pricing-model";
import { InputValidationError } from "../lib/validate-inputs";

const router: IRouter = Router();
const INTEGER_INPUT_KEYS = [
  "clientsInCohort",
  "annualTransactions",
  "channels",
  "integrations",
  "agents",
  "workflows",
  "buildAmortizationYears",
] as const satisfies ReadonlyArray<keyof PricingInputs>;

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InputValidationError("id must be a positive integer");
  }
  return id;
}

function serialize(row: typeof pricingSheetsTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    inputs: row.inputs,
    recommendation: row.recommendation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function calculateRecommendation(inputs: PricingInputs) {
  return extractPricingRecommendation(calculatePricingModel(inputs));
}

function validateAndNormalizeInputs(inputs: PricingInputs): PricingInputs {
  for (const key of INTEGER_INPUT_KEYS) {
    if (!Number.isInteger(inputs[key])) {
      throw new InputValidationError(`${key} must be an integer`);
    }
  }
  return normalizePricingInputs(inputs);
}

router.get("/pricing-sheets", async (_req, res, next): Promise<void> => {
  try {
    const rows = await db
      .select()
      .from(pricingSheetsTable)
      .orderBy(pricingSheetsTable.updatedAt, pricingSheetsTable.id);
    res.json(ListPricingSheetsResponse.parse(rows.map(serialize)));
  } catch (err) {
    next(err);
  }
});

router.post("/pricing-sheets", async (req, res, next): Promise<void> => {
  try {
    const body = CreatePricingSheetBody.parse(req.body);
    const inputs = validateAndNormalizeInputs(body.inputs);
    const [row] = await db
      .insert(pricingSheetsTable)
      .values({
        name: body.name,
        inputs,
        recommendation: calculateRecommendation(inputs),
      })
      .returning();
    res.status(201).json(CreatePricingSheetResponse.parse(serialize(row!)));
  } catch (err) {
    next(err);
  }
});

router.get("/pricing-sheets/:id", async (req, res, next): Promise<void> => {
  try {
    const id = parseId(req.params["id"]);
    const [row] = await db
      .select()
      .from(pricingSheetsTable)
      .where(eq(pricingSheetsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Pricing sheet not found" });
      return;
    }
    res.json(GetPricingSheetResponse.parse(serialize(row)));
  } catch (err) {
    next(err);
  }
});

router.patch("/pricing-sheets/:id", async (req, res, next): Promise<void> => {
  try {
    const id = parseId(req.params["id"]);
    const body = UpdatePricingSheetBody.parse(req.body);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates["name"] = body.name;
    if (body.inputs !== undefined) {
      const inputs = validateAndNormalizeInputs(body.inputs);
      updates["inputs"] = inputs;
      updates["recommendation"] = calculateRecommendation(inputs);
    }
    const [row] = await db
      .update(pricingSheetsTable)
      .set(updates)
      .where(eq(pricingSheetsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Pricing sheet not found" });
      return;
    }
    res.json(UpdatePricingSheetResponse.parse(serialize(row)));
  } catch (err) {
    next(err);
  }
});

router.delete("/pricing-sheets/:id", async (req, res, next): Promise<void> => {
  try {
    const id = parseId(req.params["id"]);
    const [row] = await db
      .delete(pricingSheetsTable)
      .where(eq(pricingSheetsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Pricing sheet not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;