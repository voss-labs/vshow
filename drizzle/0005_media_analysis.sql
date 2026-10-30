-- What the file was found to be at upload (dimensions, aspect ratio, duration, codec, structural checks), stored with the
-- immutable media version so reviewers and the server room can see it without re-reading the file. Additive and nullable:
-- versions recorded before this existed simply have no details. Forward-only.
ALTER TABLE "media_version" ADD COLUMN "media_info" jsonb;--> statement-breakpoint
ALTER TABLE "media_version" ADD CONSTRAINT "media_version_info_object" CHECK ("media_version"."media_info" IS NULL OR jsonb_typeof("media_version"."media_info") = 'object');