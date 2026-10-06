-- Cas can run on Claude direct, OpenRouter or OpenAI. Each AI call now also records who answered, with which model,
-- and (OpenRouter only) what it cost in USD.
alter table ai_usage add column if not exists provider text not null default 'anthropic';
alter table ai_usage add column if not exists model text;
alter table ai_usage add column if not exists cost_usd numeric(12, 6) not null default 0;
