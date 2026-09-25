-- Every task currently in flight, at any review level, with the A/B model
-- matchup it is comparing.
--
-- WHERE THE MATCHUP LIVES
-- There is no model column. The pairing is buried in the annotation payload:
-- TASKATTEMPTS.RESPONSE holds, at a task-specific path, one object per agent
-- instance carrying `instance_id` and `metadata.agent_model`. The containing
-- path varies per task (it sits under a generated `step-*` key, e.g.
-- before['step-1776811788151-l910ed'].output.items[0].content.data.instances[N]
-- .context), so this uses a RECURSIVE flatten and matches on shape — any node
-- with both an instance_id and a metadata.agent_model — rather than hardcoding
-- a path that only holds for one task template.
--
-- WHICH SIDE A MODEL IS ON
-- `metadata.model_label` ('a' / 'b'), sitting right beside agent_model, with the
-- instance_id suffix as a fallback.
--
-- The suffix used to be the only source, and it is NOT universal: on the
-- ad-delivery-optimizer template the ids end `-V19-<hash>` with no side letter
-- at all, so REGEXP_SUBSTR returned NULL for every node and both sides
-- collapsed — tasks whose pairing was fully recorded were reported as unknown.
-- Checked across every in-flight task, model_label agrees with the suffix on
-- every node where a suffix exists (147 tasks A/a, 140 B/b, no disagreements)
-- and is populated on the tasks where it does not. Matching on shape was
-- already the right instinct here; the side extraction just hadn't followed.
--
-- WHY THERE IS A SECOND PASS
-- Recursive flatten over a large VARIANT is expensive, so the fast pass picks
-- exactly one attempt per task — the newest whose RESPONSE carries the metadata.
-- That loses tasks whose newest such attempt happens to hold no matching node
-- while an older one does. The deep pass re-flattens ALL attempts, but only for
-- the handful of tasks the fast pass could not resolve, so the common case pays
-- nothing for it.
--
-- A NULL matchup is a genuine absence, not a failure: most are tasks that have
-- never been worked, so no pairing has been recorded anywhere yet. Use
-- matchup_state to tell the three cases apart.
WITH latest_node AS (
    SELECT
        TASK,
        REVIEW_LEVEL::string AS review_level,
        STATUS,
        CREATED_AT,
        NODE_NAME
    FROM PUBLIC.PIPELINEV3HUMANNODES
    WHERE PROJECT = '{{project_id}}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY CREATED_AT DESC) = 1
),
inflight AS (
    SELECT TASK, review_level, CREATED_AT AS entered_at
    FROM latest_node
    WHERE STATUS NOT IN ('canceled', 'completed')  -- live = pending OR paused
),
with_metadata AS (
    SELECT ta.TASK, ta.RESPONSE, ta.ATTEMPTED_AT
    FROM PUBLIC.TASKATTEMPTS ta
    JOIN inflight i ON i.TASK = ta.TASK
    WHERE ta.RESPONSE::string ILIKE '%agent_model%'
),
picked AS (
    SELECT TASK, RESPONSE
    FROM with_metadata
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TASK ORDER BY ATTEMPTED_AT DESC) = 1
),
sides_fast AS (
    SELECT DISTINCT
        p.TASK,
        COALESCE(
            UPPER(f.value:metadata:model_label::string),
            REGEXP_SUBSTR(f.value:instance_id::string, '-([AB])-[0-9a-f]+$', 1, 1, 'e', 1)
        )                                          AS side,
        f.value:metadata:agent_model::string       AS agent_model
    FROM picked p,
         LATERAL FLATTEN(input => TRY_PARSE_JSON(p.RESPONSE::string), RECURSIVE => TRUE) f
    WHERE f.value:metadata:agent_model IS NOT NULL
      AND f.value:instance_id IS NOT NULL
),
matchup_fast AS (
    SELECT
        TASK,
        MAX(CASE WHEN side = 'A' THEN agent_model END) AS model_a,
        MAX(CASE WHEN side = 'B' THEN agent_model END) AS model_b
    FROM sides_fast
    GROUP BY 1
),
-- Only the tasks the fast pass left incomplete, and only those that have an
-- attempt to look into at all.
residual AS (
    SELECT wm.TASK
    FROM with_metadata wm
    LEFT JOIN matchup_fast m ON m.TASK = wm.TASK
    WHERE m.TASK IS NULL OR m.model_a IS NULL OR m.model_b IS NULL
    GROUP BY 1
),
sides_deep AS (
    SELECT DISTINCT
        wm.TASK,
        COALESCE(
            UPPER(f.value:metadata:model_label::string),
            REGEXP_SUBSTR(f.value:instance_id::string, '-([AB])-[0-9a-f]+$', 1, 1, 'e', 1)
        )                                          AS side,
        f.value:metadata:agent_model::string       AS agent_model
    FROM with_metadata wm
    JOIN residual r ON r.TASK = wm.TASK,
         LATERAL FLATTEN(input => TRY_PARSE_JSON(wm.RESPONSE::string), RECURSIVE => TRUE) f
    WHERE f.value:metadata:agent_model IS NOT NULL
      AND f.value:instance_id IS NOT NULL
),
matchup_deep AS (
    SELECT
        TASK,
        MAX(CASE WHEN side = 'A' THEN agent_model END) AS model_a,
        MAX(CASE WHEN side = 'B' THEN agent_model END) AS model_b
    FROM sides_deep
    GROUP BY 1
),
matchup AS (
    SELECT
        COALESCE(f.TASK, d.TASK)             AS TASK,
        COALESCE(f.model_a, d.model_a)       AS model_a,
        COALESCE(f.model_b, d.model_b)       AS model_b
    FROM matchup_fast f
    FULL OUTER JOIN matchup_deep d ON d.TASK = f.TASK
)
SELECT
    i.TASK                                                                  AS task_id,
    i.review_level,
    ROUND(DATEDIFF(hour, i.entered_at, CURRENT_TIMESTAMP()) / 24.0, 1)      AS age_days,
    m.model_a,
    m.model_b,
    -- Order-independent so "X vs Y" and "Y vs X" aggregate as one matchup.
    CASE
      WHEN m.model_a IS NULL OR m.model_b IS NULL THEN NULL
      ELSE LEAST(m.model_a, m.model_b) || '  vs  ' || GREATEST(m.model_a, m.model_b)
    END                                                                     AS matchup,
    -- Lets the caller distinguish "one arm recorded so far" from "nothing
    -- recorded", instead of showing both as an absence.
    CASE
      WHEN m.model_a IS NOT NULL AND m.model_b IS NOT NULL THEN 'complete'
      WHEN m.model_a IS NOT NULL OR  m.model_b IS NOT NULL THEN 'one_side'
      ELSE 'none'
    END                                                                     AS matchup_state
FROM inflight i
LEFT JOIN matchup m ON m.TASK = i.TASK
ORDER BY TRY_TO_NUMBER(i.review_level), age_days DESC
