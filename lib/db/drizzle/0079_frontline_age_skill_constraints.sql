ALTER TABLE "onb_frontline_evidence"
  ADD CONSTRAINT "onb_frontline_evidence_skill_key_check"
  CHECK (("kind" = 'skill-certificate' and "skill_requirement_key" is not null) or ("kind" <> 'skill-certificate' and "skill_requirement_key" is null));
--> statement-breakpoint
ALTER TABLE "onb_frontline_evidence"
  ADD CONSTRAINT "onb_frontline_evidence_age_check"
  CHECK (("kind" = 'age-proof' and "subject_age_years" is not null and "subject_age_years" between 0 and 120) or ("kind" <> 'age-proof' and "subject_age_years" is null));