-- Support handoff fix (October 2026). Never edits older migrations.
--
-- The AI used to find "new" customer messages as the ones written after its last answer (by message id). When a
-- customer wrote again while the AI was still thinking (e.g. "Hello", then "I'd like to talk to a person"), the
-- answer to the first message was saved after the second one, so the second was never treated as new and the
-- handover rule never saw it. Now each thread remembers the last customer message the AI has dealt with.
alter table support_threads add column if not exists ai_seen_msg_id bigint;
