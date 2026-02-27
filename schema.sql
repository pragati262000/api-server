-- ============================================
-- Time Tracker v2 | Client 2 | SQL Schema
-- ============================================
-- Run this once in your database (Clever Cloud
-- Adminer, MySQL Workbench, or any SQL console).
-- ============================================

-- Activity log — one row per tracked URL segment
CREATE TABLE IF NOT EXISTS activity_logs (
  id               VARCHAR(36)  PRIMARY KEY,
  agent_id         VARCHAR(100) NOT NULL,
  activity_type    VARCHAR(50)  NOT NULL,  -- PRODUCTIVE | NON_PRODUCTIVE | IDLE | END_OF_DAY
  sub_category     VARCHAR(50),            -- WORK_TIME | BREAK | ONE_ON_ONE | HUDDLE | MEETING | ENTERTAINMENT | OTHER
  url              TEXT,
  page_title       TEXT,
  additional_info  TEXT,
  start_time       DATETIME     NOT NULL,
  end_time         DATETIME,
  duration_seconds INT          DEFAULT 0,
  manually_categorized BOOLEAN  DEFAULT FALSE,
  logged_at        DATETIME     DEFAULT CURRENT_TIMESTAMP
);

-- Live agent status — one row per agent (upserted)
CREATE TABLE IF NOT EXISTS agent_status (
  agent_id          VARCHAR(100) PRIMARY KEY,
  current_status    VARCHAR(50),
  current_activity  VARCHAR(100),
  current_url       TEXT,
  status_updated_at DATETIME,
  last_seen         DATETIME
);

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_logs_agent    ON activity_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_logs_start    ON activity_logs(start_time);
CREATE INDEX IF NOT EXISTS idx_logs_type     ON activity_logs(activity_type);

-- Daily summary view
CREATE OR REPLACE VIEW daily_summary AS
SELECT
  agent_id,
  DATE(start_time)                                      AS shift_date,
  SUM(CASE WHEN activity_type = 'PRODUCTIVE'    THEN duration_seconds ELSE 0 END) AS productive_seconds,
  SUM(CASE WHEN activity_type IN ('BREAK','ONE_ON_ONE','HUDDLE','MEETING','NON_PRODUCTIVE')
                                                THEN duration_seconds ELSE 0 END) AS non_productive_seconds,
  SUM(CASE WHEN activity_type = 'IDLE'          THEN duration_seconds ELSE 0 END) AS idle_seconds,
  COUNT(*)                                               AS record_count
FROM activity_logs
GROUP BY agent_id, DATE(start_time);
