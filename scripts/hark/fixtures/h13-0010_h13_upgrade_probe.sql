-- Hark lane H13 CI ONLY: the "newer version" probe migration. Staged into a COPY of the
-- app for the probe-newer installer (v-next); never part of the repository's chains.
CREATE TABLE IF NOT EXISTS h13_upgrade_probe (
  id   INTEGER PRIMARY KEY,
  note TEXT NOT NULL
);
INSERT INTO h13_upgrade_probe (id, note) VALUES (1, 'written by the probe-newer build');
