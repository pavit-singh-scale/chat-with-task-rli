-- Every task currently sitting in ONE review lane, longest-blocked first.
--
-- The board shows severity buckets and workflow lanes; neither says anything
-- about a task that is stuck upstream. This is that list: the actionable
-- drill-down for a problem lane (L1 content issues, L8 engineering issues), with
-- enough context to route each one without opening it.
--
-- AGE IS MEASURED FROM CREATED_AT, NOT UPDATED_AT
-- The equivalent dashboard queries (Redash 324822 / 324823) age from
-- UPDATED_AT, which is the last time the node was touched for any reason, not
-- when the task entered the lane. Measured on this project: 43 of 228 pending
-- nodes have been touched after creation, so their age is understated — by 5.1
-- days on the worst one. CREATED_AT is the entry time and the only one that
-- answers "how long has this been blocked".
--
-- "Came from" is the newest node the task held before this one. The movement
-- view (view.review_task_movement_v3) carries an explicit PREVIOUS_REVIEW_LEVEL
-- and would be more faithful, but it costs ~30s against ~2s here and this drives
-- a page panel. Node ordering agrees with it on every case checked.
WITH lane AS (
    SELECT
        hn.TASK       AS task_id,
        hn.CREATED_AT AS entered_at,
        hn.UPDATED_AT AS last_touched_at,
        DATEDIFF('hour', hn.CREATED_AT, CURRENT_TIMESTAMP()) AS hours_blocked
    FROM PUBLIC.PIPELINEV3HUMANNODES hn
    WHERE hn.PROJECT      = '{{project_id}}'
      AND hn.STATUS NOT IN ('canceled', 'completed')  -- live = pending OR paused
      AND hn.REVIEW_LEVEL::int = {{level}}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY hn.TASK ORDER BY hn.CREATED_AT DESC) = 1
),
came_from AS (
    SELECT
        hn.TASK              AS task_id,
        hn.REVIEW_LEVEL::int AS prior_level
    FROM PUBLIC.PIPELINEV3HUMANNODES hn
    JOIN lane l ON l.task_id = hn.TASK
    WHERE hn.PROJECT = '{{project_id}}'
      AND hn.REVIEW_LEVEL::int <> {{level}}
      AND hn.CREATED_AT < l.entered_at
    QUALIFY ROW_NUMBER() OVER (PARTITION BY hn.TASK ORDER BY hn.CREATED_AT DESC) = 1
),
-- Who produced the work that is now stuck: the newest authoring attempt.
author AS (
    SELECT
        ta.TASK         AS task_id,
        ta.ATTEMPTED_BY AS user_id,
        ta.ATTEMPTED_AT AS authored_at
    FROM PUBLIC.TASKATTEMPTS ta
    JOIN lane l ON l.task_id = ta.TASK
    WHERE ta.PROJECT = '{{project_id}}'
      AND ta.ATTEMPTED_AT_REVIEW_LEVEL = -1
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ta.TASK ORDER BY ta.ATTEMPTED_AT DESC) = 1
),
effort AS (
    SELECT
        ta.TASK              AS task_id,
        COUNT(*)             AS attempts_so_far,
        MAX(ta.ATTEMPTED_AT) AS last_attempt_at,
        ROUND(SUM(ta.V2_TIME_SPENT_SECS) / 3600.0, 1) AS hours_sunk
    FROM PUBLIC.TASKATTEMPTS ta
    JOIN lane l ON l.task_id = ta.TASK
    WHERE ta.PROJECT = '{{project_id}}'
    GROUP BY 1
)
SELECT
    l.task_id,
    l.entered_at,
    ROUND(l.hours_blocked / 24.0, 1)  AS days_blocked,
    cf.prior_level                    AS came_from_level,
    a.authored_at,
    u.FULL_NAME                       AS author,
    u.EMAIL                           AS author_email,
    u.WORKER_TEAM_NAME                AS author_team,
    COALESCE(e.attempts_so_far, 0)    AS attempts_so_far,
    e.last_attempt_at,
    COALESCE(e.hours_sunk, 0)         AS hours_sunk
FROM lane l
LEFT JOIN came_from      cf ON cf.task_id = l.task_id
LEFT JOIN author         a  ON a.task_id  = l.task_id
LEFT JOIN effort         e  ON e.task_id  = l.task_id
LEFT JOIN VIEW.DIM_USERS u  ON u.USER_ID  = a.user_id
ORDER BY l.hours_blocked DESC
