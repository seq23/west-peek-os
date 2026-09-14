-- 0159 · every step an employee takes on a card is counted on the card (14 Sep 2026)
--
-- WHAT HAPPENED. "Deal flow: Helios Grid" was worked three times by the sweep. Each run took five
-- steps, every one a search that came back "nothing live can be found", and none of the fifteen
-- ended in a conclusion: the run's step allowance ran out, the attempt was scored a failure, and
-- the next attempt started the same way. The third run was killed part-way (a cron invocation on
-- the Free plan has a CPU budget; five steps of model calls in one invocation exceeds it) and the
-- card sat IN_PROGRESS at the attempt cap, unclaimable, for ever.
--
-- WHAT THIS CHANGES. Work is resumable across invocations: a run takes a FEW steps and hands the
-- card back still in progress; the next tick carries on. That needs the card, not the run, to hold
-- the count, so the budget is per card and a forced conclusion happens when it is spent — an
-- employee that has used its steps must say done or blocked, not search once more.
ALTER TABLE work_card ADD COLUMN work_steps INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0159_every_step_is_counted');
