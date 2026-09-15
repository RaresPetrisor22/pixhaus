-- The photo a gallery leads with: the full-bleed image a client sees before
-- they scroll. One of the gallery's own assets, not a separate upload, so it
-- already has renditions and costs no new storage path.
--
-- The FK carries studio_id as well as the id, the same tenant-safe pattern as
-- assets -> galleries: a cover from another studio cannot be named, whatever
-- the request body says.
--
-- SET NULL names its column because studio_id is NOT NULL -- deleting the
-- cover photo clears the cover, it does not orphan the gallery.

ALTER TABLE galleries
  ADD COLUMN cover_asset_id uuid,
  ADD FOREIGN KEY (cover_asset_id, studio_id) REFERENCES assets (id, studio_id)
    ON DELETE SET NULL (cover_asset_id);
