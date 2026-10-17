-- Hand-written, additive: the Phase 2 rules drizzle cannot declare, on the tables 0007
-- created (DATA_MODEL.md, "Phase 2 tables"). They use the two generic trigger functions
-- from 0001 and raise their SQLSTATEs: TP001 append-only, TP002 published or completed.

-- 1. review_decision is append-only, like application_event: a correction is a new row and
--    the latest row is current. The Phase 3 purge is exempt through tidepool.purge, as before.
create trigger review_decision_append_only
  before update or delete on review_decision
  for each row execute function tidepool_append_only();
--> statement-breakpoint

-- 2. The immutability function gains three rules; the three 0001 rules are unchanged.
--      rubric_version            like form_version: once out of draft, only published -> retired
--      rubric_version_criterion  like form_item: locked while its version is not a draft
--      ai_score                  once completed_at is set, only is_current may change. The
--                                Phase 3 purge strips its PII text columns, so it is exempt
--                                through the same tidepool.purge setting as the append-only rule.
create or replace function tidepool_immutable_once_published() returns trigger
language plpgsql as $$
declare
  rule text := tg_argv[0];
  form_status config_status;
  version_status config_status;
begin
  if rule = 'published_at' then
    if old.published_at is not null then
      raise exception 'tidepool: % % is published and cannot change, % rejected', tg_table_name, old.id, tg_op
        using errcode = 'TP002';
    end if;

  elsif rule = 'form_version' then
    if old.status <> 'draft' then
      if tg_op = 'UPDATE' and old.status = 'published' and new.status = 'retired'
         and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then
        return new;
      end if;
      raise exception 'tidepool: form_version % is % and cannot change, % rejected', old.id, old.status, tg_op
        using errcode = 'TP002';
    end if;

  elsif rule = 'form_item' then
    if tg_op <> 'INSERT' then
      select status into form_status from form_version where id = old.form_version_id;
      if form_status <> 'draft' then
        raise exception 'tidepool: form_version % is % and its items cannot change, % rejected', old.form_version_id, form_status, tg_op
          using errcode = 'TP002';
      end if;
    end if;
    if tg_op <> 'DELETE' then
      select status into form_status from form_version where id = new.form_version_id;
      if form_status <> 'draft' then
        raise exception 'tidepool: form_version % is % and its items cannot change, % rejected', new.form_version_id, form_status, tg_op
          using errcode = 'TP002';
      end if;
    end if;

  elsif rule = 'rubric_version' then
    if old.status <> 'draft' then
      if tg_op = 'UPDATE' and old.status = 'published' and new.status = 'retired'
         and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then
        return new;
      end if;
      raise exception 'tidepool: rubric_version % is % and cannot change, % rejected', old.id, old.status, tg_op
        using errcode = 'TP002';
    end if;

  elsif rule = 'rubric_version_criterion' then
    if tg_op <> 'INSERT' then
      select status into version_status from rubric_version where id = old.rubric_version_id;
      if version_status <> 'draft' then
        raise exception 'tidepool: rubric_version % is % and its criteria cannot change, % rejected', old.rubric_version_id, version_status, tg_op
          using errcode = 'TP002';
      end if;
    end if;
    if tg_op <> 'DELETE' then
      select status into version_status from rubric_version where id = new.rubric_version_id;
      if version_status <> 'draft' then
        raise exception 'tidepool: rubric_version % is % and its criteria cannot change, % rejected', new.rubric_version_id, version_status, tg_op
          using errcode = 'TP002';
      end if;
    end if;

  elsif rule = 'ai_score' then
    if old.completed_at is not null and current_setting('tidepool.purge', true) is distinct from 'on' then
      if tg_op = 'UPDATE' and (to_jsonb(new) - 'is_current') = (to_jsonb(old) - 'is_current') then
        return new;
      end if;
      raise exception 'tidepool: ai_score % is complete and only is_current may change, % rejected', old.id, tg_op
        using errcode = 'TP002';
    end if;

  else
    raise exception 'tidepool: unknown immutability rule %', rule;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger rubric_version_immutable_once_published
  before update or delete on rubric_version
  for each row execute function tidepool_immutable_once_published('rubric_version');
--> statement-breakpoint
create trigger rubric_version_criterion_immutable_once_published
  before insert or update or delete on rubric_version_criterion
  for each row execute function tidepool_immutable_once_published('rubric_version_criterion');
--> statement-breakpoint
create trigger ai_score_immutable_once_completed
  before update or delete on ai_score
  for each row execute function tidepool_immutable_once_published('ai_score');
--> statement-breakpoint

-- 3. The read-only database user (scripts/readonly-role.sql) reads every Phase 2 table. Its
--    default privileges already hand it tables the migrating user creates; this grant covers a
--    role whose default privileges were set up some other way. integration_secret stays
--    excluded (0006): nothing here names it.
DO $$
DECLARE
  phase2_table text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tidepool_readonly') THEN
    FOREACH phase2_table IN ARRAY ARRAY[
      'attendee', 'star', 'rubric', 'rubric_criterion', 'rubric_version', 'rubric_version_criterion',
      'rubric_test_case', 'ai_score', 'ai_criterion_score', 'review_decision', 'interview',
      'interview_grade', 'assessment', 'job'
    ] LOOP
      EXECUTE format('GRANT SELECT ON TABLE %I TO tidepool_readonly', phase2_table);
    END LOOP;
  END IF;
END
$$;
