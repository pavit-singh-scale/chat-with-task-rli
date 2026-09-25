-- What is in flight right now, and how long it has been sitting.
--
-- One row per review level, over tasks whose newest pipeline node is still
-- live (pending or paused — filtering on 'pending' alone hid the 12 paused tasks at
-- L-1/L11 on 0925). This is the "can we make the next delivery" query: `pending` is the
-- pool available to draw the batch from, and the age columns say which part of
-- that pool has stopped moving.
--
-- Age is measured from the node's CREATED_AT — when the task entered its current
-- level — not from the task's own creation, so a task that has bounced through
-- rework is aged by its current wait, not its whole history. Deliberately not
-- UPDATED_AT: the ops dashboard's stuck-task queries age from that, and it is
-- the last time the node was touched for any reason. On this project 43 of 228
-- pending nodes have been touched since creation, so under that convention they
-- read younger than they are — by 5.1 days on the worst one.
--
-- An average hides the tail, so p90 and the oldest task id are here too: forty
-- one-day-old tasks and two three-week-old ones average to something reassuring.
--
-- lane_kind separates the two things a pending count can mean. Work at -1/0/10/12
-- is moving through the pipeline as designed; work at 1 or 8 is BLOCKED on a
-- content or engineering problem and needs someone to act on it. Summing them
-- into a single "pending" figure hides the second inside the first — see
-- blocked_backlog.sql for the per-task drill-down.
WITH latest AS (
    SELECT
        TASK,
        REVIEW_LEVEL::string AS review_level,
        STATUS,
        CREATED_AT
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE PROJECT = '{{project_id}}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) = 1
),
pending AS (
    SELECT
        TASK,
        review_level,
        DATEDIFF(hour, CREATED_AT, CURRENT_TIMESTAMP()) AS age_hours
    FROM latest
    WHERE STATUS NOT IN ('canceled', 'completed')  -- live = pending OR paused
)
SELECT
    review_level,
    CASE review_level
        WHEN '8'  THEN 'pool'          -- RLI: fresh tasks awaiting eval
        WHEN '-1' THEN 'production'
        ELSE           'review'
    END                                                                     AS lane_kind,
    COUNT(*)                                                                AS pending,
    ROUND(AVG(age_hours) / 24.0, 1)                                         AS avg_age_days,
    ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY age_hours) / 24.0, 1) AS p90_age_days,
    ROUND(MAX(age_hours) / 24.0, 1)                                         AS oldest_days,
    MAX_BY(TASK, age_hours)                                                 AS oldest_task_id,
    COUNT_IF(age_hours > 24 * {{stale_days}})                               AS stale
FROM pending
GROUP BY 1, 2
ORDER BY TRY_TO_NUMBER(review_level)
