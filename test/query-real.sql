select
  "guests"."id",
  "guests"."session_id",
  "guests"."username",
  "guests"."avatar_path",
  "guests"."color",
  "guests"."side",
  "guests"."audio_recording_path",
  "guests"."audio_recording_public",
  "guests"."memo",
  "guests"."memo_public",
  "guests"."setup_at",
  "guests"."last_upload",
  "guests"."inserted_at",
  "guests"."updated_at",
  "userAssets"."id",
  "userAssets"."kind",
  "userAssets"."event_id",
  "userAssets"."uploader_id",
  "userAssets"."uploader_ip",
  "userAssets"."path",
  "userAssets"."file_size",
  "userAssets"."width",
  "userAssets"."height",
  "userAssets"."visible_at",
  "userAssets"."deleted_at",
  "userAssets"."inserted_at",
  "userAssets"."updated_at"
from
  (
    select
      "id",
      "session_id",
      "username",
      "avatar_path",
      "color",
      "side",
      "audio_recording_path",
      "audio_recording_public",
      "memo",
      "memo_public",
      "setup_at",
      "last_upload",
      "inserted_at",
      "updated_at"
    from
      "guests"
    order by
      "guests"."last_upload" desc,
      "guests"."id" desc
    limit
      $1
  ) "guests"
  cross join lateral (
    select
      "id",
      "kind",
      "event_id",
      "uploader_id",
      "uploader_ip",
      "path",
      "file_size",
      "width",
      "height",
      "visible_at",
      "deleted_at",
      "inserted_at",
      "updated_at"
    from
      "assets"
    where
      (
        "assets"."event_id" = (
          select
            "id"
          from
            "events"
          where
            "events"."event_key" = $2
        )
        and "assets"."uploader_id" = "guests"."id"
      )
    order by
      "assets"."inserted_at" desc
    limit
      $3
  ) "userAssets"
