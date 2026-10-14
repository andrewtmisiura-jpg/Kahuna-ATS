-- Hand-written migration: the two generic triggers from DATA_MODEL.md and the one
-- partial unique index drizzle cannot declare. drizzle-kit diffs against its own
-- snapshots, not the database, so nothing here is ever dropped by a generated migration.
--
-- Both trigger functions raise with a custom SQLSTATE so services can recognise them:
--   TP001  append-only table: UPDATE or DELETE rejected
--   TP002  published row: edit rejected

-- 1. Append-only logs: application_event, consent_event, audit_log (review_decision joins in Phase 2).
--    Corrections are new rows. The Phase 3 purge is the one exception: it runs with
--    `set local tidepool.purge = 'on'` inside its transaction.
create function tidepool_append_only() returns trigger
language plpgsql as $$
begin
  if current_setting('tidepool.purge', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  raise exception 'tidepool: % is append-only, % rejected', tg_table_name, tg_op
    using errcode = 'TP001';
end;
$$;
--> statement-breakpoint
create trigger application_event_append_only
  before update or delete on application_event
  for each row execute function tidepool_append_only();
--> statement-breakpoint
create trigger consent_event_append_only
  before update or delete on consent_event
  for each row execute function tidepool_append_only();
--> statement-breakpoint
create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function tidepool_append_only();
--> statement-breakpoint

-- 2. Published configuration is immutable: question versions and legal text versions
--    once published_at is set; a form version once its status leaves draft (the only
--    allowed change is status published -> retired); form items while their form is
--    not a draft. The first trigger argument picks the rule.
create function tidepool_immutable_once_published() returns trigger
language plpgsql as $$
declare
  rule text := tg_argv[0];
  form_status config_status;
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
create trigger question_version_immutable_once_published
  before update or delete on question_version
  for each row execute function tidepool_immutable_once_published('published_at');
--> statement-breakpoint
create trigger legal_text_version_immutable_once_published
  before update or delete on legal_text_version
  for each row execute function tidepool_immutable_once_published('published_at');
--> statement-breakpoint
create trigger form_version_immutable_once_published
  before update or delete on form_version
  for each row execute function tidepool_immutable_once_published('form_version');
--> statement-breakpoint
create trigger form_item_immutable_once_published
  before insert or update or delete on form_item
  for each row execute function tidepool_immutable_once_published('form_item');
--> statement-breakpoint

-- 3. One live template per (employer, role, purpose, channel), with a null role
--    counting as a value. Drizzle has no "nulls not distinct" on partial indexes.
create unique index message_template_one_live_per_scope
  on message_template (employer_id, role_id, purpose, channel) nulls not distinct
  where archived_at is null;
