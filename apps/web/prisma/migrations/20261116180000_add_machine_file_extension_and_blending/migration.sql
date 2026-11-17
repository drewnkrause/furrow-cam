-- Add optional fileExtension and pathBlendingTolerance to Machine
ALTER TABLE "machine" ADD COLUMN "fileExtension" TEXT,
ADD COLUMN "pathBlendingTolerance" DOUBLE PRECISION;
