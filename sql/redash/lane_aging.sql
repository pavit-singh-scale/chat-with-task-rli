-- How long the pending work has been sitting, bucketed, for EVERY review level.
--
-- queue_state.sql already gives an average and an oldest per level, but an
-- average hides the shape: forty tasks a day old and two tasks three weeks old
-- average out to something that looks fine. The buckets show the tail, which is
-- the part worth acting on.
--
-- The dashboard equivalent (Redash 324824) covers only L1 and L8 and ages from
-- UPDATED_AT; this covers every level and ages from CREATED_AT for the reason
-- documented in blocked_backlog.sql.
WITH pending AS (
    SELECT
        TASK,
        REVIEW_LEVEL::string AS review_level,
        DATEDIFF('hour', CREATED_AT, CURRENT_TIMESTAMP()) AS hours_in_lane
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE PROJECT = '{{project_id}}'
      AND STATUS NOT IN ('canceled', 'completed')  -- live = pending OR paused
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) = 1
),
bucketed AS (
    SELECT
        review_level,
        CASE
            WHEN hours_in_lane < 24      THEN '0-24h'
            WHEN hours_in_lane < 24 * 3  THEN '1-3d'
            WHEN hours_in_lane < 24 * 7  THEN '3-7d'
            WHEN hours_in_lane < 24 * 14 THEN '7-14d'
            ELSE                              '>14d'
        END AS age_bucket,
        CASE
            WHEN hours_in_lane < 24      THEN 1
            WHEN hours_in_lane < 24 * 3  THEN 2
            WHEN hours_in_lane < 24 * 7  THEN 3
            WHEN hours_in_lane < 24 * 14 THEN 4
            ELSE                              5
        END AS bucket_order,
        hours_in_lane
    FROM pending
)
SELECT
    review_level,
    age_bucket,
    bucket_order,
    COUNT(*)                                  AS tasks,
    ROUND(MAX(hours_in_lane) / 24.0, 1)       AS oldest_days
FROM bucketed
GROUP BY 1, 2, 3
ORDER BY TRY_TO_NUMBER(review_level), bucket_order
