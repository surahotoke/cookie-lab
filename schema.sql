DROP TABLE IF EXISTS visits;
CREATE TABLE visits (
  id INTEGER PRIMARY KEY,
  time INTEGER NOT NULL
);
CREATE INDEX idx_visits_time ON visits(time);
