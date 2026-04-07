ALTER TABLE "issues" ADD COLUMN "disable_triage" boolean DEFAULT false NOT NULL;
ALTER TABLE "routines" ADD COLUMN "disable_triage" boolean DEFAULT false NOT NULL;
