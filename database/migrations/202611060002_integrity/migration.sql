BEGIN;
-- SQL constraints are the authority for rules not represented by Prisma's stable DSL.
ALTER TABLE organizations ADD CONSTRAINT organizations_ai_config_revision_nonnegative CHECK (ai_config_revision>=0);
ALTER TABLE organizations ADD CONSTRAINT organizations_knowledge_revision_nonnegative CHECK (knowledge_revision>=0);
ALTER TABLE organizations ADD CONSTRAINT organizations_authorization_revision_nonnegative CHECK (authorization_revision>=0);
ALTER TABLE organizations ADD CONSTRAINT organizations_version_nonnegative CHECK (version>=0);
ALTER TABLE memberships ADD CONSTRAINT memberships_version_nonnegative CHECK (version>=0);
ALTER TABLE widget_configs ADD CONSTRAINT widget_configs_version_nonnegative CHECK (version>=0);
ALTER TABLE customers ADD CONSTRAINT customers_version_nonnegative CHECK (version>=0);
ALTER TABLE conversations ADD CONSTRAINT conversations_version_nonnegative CHECK (version>=0);
ALTER TABLE conversations ADD CONSTRAINT conversations_last_seq_nonnegative CHECK (last_seq>=0);
ALTER TABLE conversations ADD CONSTRAINT conversations_last_visitor_seq_nonnegative CHECK (last_visitor_seq>=0);
ALTER TABLE conversations ADD CONSTRAINT conversations_input_revision_nonnegative CHECK (input_revision>=0);
ALTER TABLE conversations ADD CONSTRAINT conversations_reception_epoch_nonnegative CHECK (reception_epoch>=0);
ALTER TABLE messages ADD CONSTRAINT messages_seq_nonnegative CHECK (seq>=0);
ALTER TABLE conversation_reads ADD CONSTRAINT conversation_reads_last_read_seq_nonnegative CHECK (last_read_seq>=0);
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_version_nonnegative CHECK (version>=0);
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_version_nonnegative CHECK (version>=0);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_revision_nonnegative CHECK (revision>=0);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_embedding_dimensions_nonnegative CHECK (embedding_dimensions>=0);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_preparation_attempt_nonnegative CHECK (preparation_attempt>=0);
ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_chunks_ordinal_nonnegative CHECK (ordinal>=0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_input_revision_nonnegative CHECK (input_revision>=0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_source_through_seq_nonnegative CHECK (source_through_seq>=0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_latest_visitor_seq_nonnegative CHECK (latest_visitor_seq>=0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_reception_epoch_nonnegative CHECK (reception_epoch>=0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_knowledge_revision_nonnegative CHECK (knowledge_revision>=0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_ai_config_revision_nonnegative CHECK (ai_config_revision>=0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_version_nonnegative CHECK (version>=0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_attempt_count_nonnegative CHECK (attempt_count>=0);
ALTER TABLE tickets ADD CONSTRAINT tickets_version_nonnegative CHECK (version>=0);
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_version_nonnegative CHECK (version>=0);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_version_nonnegative CHECK (aggregate_version>=0);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_attempt_count_nonnegative CHECK (attempt_count>=0);
ALTER TABLE users ADD CONSTRAINT users_status_values CHECK (status IN ('active','disabled'));
ALTER TABLE memberships ADD CONSTRAINT memberships_status_values CHECK (status IN ('active','disabled'));
ALTER TABLE memberships ADD CONSTRAINT memberships_role_values CHECK (role IN ('admin','agent'));
ALTER TABLE invitations ADD CONSTRAINT invitations_role_values CHECK (role IN ('admin','agent'));
ALTER TABLE memberships ADD CONSTRAINT memberships_availability_values CHECK (availability IN ('available','away'));
ALTER TABLE memberships ADD CONSTRAINT memberships_reading_language_values CHECK (reading_language IN ('zh','en'));
ALTER TABLE widget_configs ADD CONSTRAINT widget_configs_default_language_values CHECK (default_language IN ('zh','en'));
ALTER TABLE customers ADD CONSTRAINT customers_preferred_language_values CHECK (preferred_language IN ('zh','en'));
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_target_language_values CHECK (target_language IN ('zh','en'));
ALTER TABLE presence_connections ADD CONSTRAINT presence_connections_transport_values CHECK (transport IN ('http','socket'));
ALTER TABLE conversations ADD CONSTRAINT conversations_status_values CHECK (status IN ('ai_active','waiting_human','human_active','closed'));
ALTER TABLE conversations ADD CONSTRAINT conversations_resolution_values CHECK (resolution IN ('customer_confirmed','agent_resolved','unconfirmed'));
ALTER TABLE messages ADD CONSTRAINT messages_sender_type_values CHECK (sender_type IN ('visitor','agent','ai','system'));
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_type_values CHECK (type IN ('faq','text'));
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_status_values CHECK (status IN ('draft','enabled','disabled'));
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_preparation_status_values CHECK (preparation_status IN ('pending','processing','ready','failed'));
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_scope_values CHECK (scope IN ('conversation_auto','conversation_assist','knowledge_test'));
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_operation_values CHECK (operation IN ('answer','translate','summarize','suggest_reply'));
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_status_values CHECK (status IN ('queued','running','succeeded','failed','superseded'));
ALTER TABLE ai_results ADD CONSTRAINT ai_results_result_kind_values CHECK (result_kind IN ('answer','translate','summarize','suggest_reply'));
ALTER TABLE tickets ADD CONSTRAINT tickets_priority_values CHECK (priority IN ('low','normal','high'));
ALTER TABLE tickets ADD CONSTRAINT tickets_status_values CHECK (status IN ('open','in_progress','waiting_customer','resolved'));
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_from_status_values CHECK (from_status IN ('open','in_progress','waiting_customer','resolved'));
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_to_status_values CHECK (to_status IN ('open','in_progress','waiting_customer','resolved'));
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_type_values CHECK (type IN ('created','updated','assigned','status_changed','comment'));
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_type_values CHECK (type IN ('handoff','claim','assign','transfer','close','reopen'));
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_from_status_values CHECK (from_status IN ('ai_active','waiting_human','human_active','closed'));
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_to_status_values CHECK (to_status IN ('ai_active','waiting_human','human_active','closed'));
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_actor_type_values CHECK (actor_type IN ('visitor','agent','ai','system'));
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_destination_values CHECK (destination IN ('socket','queue'));
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_status_values CHECK (status IN ('pending','published'));
ALTER TABLE organizations ADD CONSTRAINT organization_sender_ids_distinct CHECK (ai_sender_id <> system_sender_id);
ALTER TABLE users ADD CONSTRAINT users_email_normalized CHECK (email_normalized = lower(btrim(email_normalized)) AND char_length(email_normalized) BETWEEN 1 AND 254);
ALTER TABLE conversations ADD CONSTRAINT conversation_assignment CHECK ((status='human_active' AND assigned_membership_id IS NOT NULL) OR (status IN ('ai_active','waiting_human') AND assigned_membership_id IS NULL) OR status='closed');
ALTER TABLE conversations ADD CONSTRAINT conversation_closure CHECK ((status='closed' AND closed_at IS NOT NULL AND resolution IS NOT NULL) OR (status<>'closed' AND closed_at IS NULL AND resolution IS NULL));
ALTER TABLE conversations ADD CONSTRAINT conversation_watermarks CHECK (last_visitor_seq<=last_seq);
ALTER TABLE conversations ADD CONSTRAINT conversation_first_reply_pair CHECK ((first_human_reply_at IS NULL)=(first_human_reply_membership_id IS NULL));
ALTER TABLE messages ADD CONSTRAINT message_sender_identity CHECK ((sender_type='visitor' AND sender_customer_id IS NOT NULL AND sender_id=sender_customer_id AND sender_membership_id IS NULL AND ai_task_id IS NULL)
 OR (sender_type='agent' AND sender_membership_id IS NOT NULL AND sender_id=sender_membership_id AND sender_customer_id IS NULL AND ai_task_id IS NULL)
 OR (sender_type='ai' AND sender_membership_id IS NULL AND sender_customer_id IS NULL AND ai_task_id IS NOT NULL)
 OR (sender_type='system' AND sender_membership_id IS NULL AND sender_customer_id IS NULL AND ai_task_id IS NULL));
ALTER TABLE messages ADD CONSTRAINT message_seq_positive CHECK (seq>0);
ALTER TABLE invitations ADD CONSTRAINT invitation_consumption CHECK ((accepted_at IS NULL)=(accepted_by_user_id IS NULL) AND NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL));
ALTER TABLE widget_configs ADD CONSTRAINT widget_origins_array CHECK (jsonb_typeof(allowed_origins)='array');
ALTER TABLE presence_connections ADD CONSTRAINT presence_transport_identity CHECK ((transport='socket' AND socket_id IS NOT NULL) OR (transport='http' AND socket_id IS NULL));
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_dimensions CHECK (embedding_dimensions BETWEEN 1 AND 16000);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_profile_nonempty CHECK (char_length(embedding_profile_version)>0 AND char_length(embedding_model_id)>0);
ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_vector_nonzero CHECK (vector_norm(embedding)>0);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_revision_positive CHECK (revision>0);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_task_arrays CHECK (jsonb_typeof(input_message_ids)='array' AND jsonb_typeof(attempts)='array');
ALTER TABLE ai_tasks ADD CONSTRAINT ai_scope_shape CHECK ((scope='conversation_auto' AND conversation_id IS NOT NULL AND operation='answer' AND requested_by_membership_id IS NULL AND command_id IS NULL AND input_revision>0 AND latest_visitor_seq IS NOT NULL AND reception_epoch IS NOT NULL AND deadline_at IS NOT NULL AND question_text IS NULL)
 OR (scope='conversation_assist' AND conversation_id IS NOT NULL AND operation IN ('translate','summarize','suggest_reply') AND requested_by_membership_id IS NOT NULL AND command_id IS NOT NULL AND source_through_seq IS NOT NULL AND question_text IS NULL)
 OR (scope='knowledge_test' AND conversation_id IS NULL AND operation='answer' AND requested_by_membership_id IS NOT NULL AND command_id IS NOT NULL AND question_text IS NOT NULL AND char_length(question_text) BETWEEN 1 AND 8000 AND input_revision=1));
ALTER TABLE tickets ADD CONSTRAINT ticket_resolution CHECK ((status='resolved')=(resolved_at IS NOT NULL));
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_lease_pair CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL));
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_lease_pair CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL));
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_lease_pair CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL));
ALTER TABLE organizations ADD CONSTRAINT organizations_name_length CHECK (char_length(name) BETWEEN 1 AND 100);
ALTER TABLE widget_configs ADD CONSTRAINT widget_configs_welcome_text_length CHECK (char_length(welcome_text) BETWEEN 0 AND 500);
ALTER TABLE customers ADD CONSTRAINT customers_name_length CHECK (char_length(name) BETWEEN 0 AND 100);
ALTER TABLE customers ADD CONSTRAINT customers_email_length CHECK (char_length(email) BETWEEN 0 AND 254);
ALTER TABLE customers ADD CONSTRAINT customers_internal_notes_length CHECK (char_length(internal_notes) BETWEEN 0 AND 2000);
ALTER TABLE messages ADD CONSTRAINT messages_content_length CHECK (char_length(content) BETWEEN 1 AND 8000);
ALTER TABLE conversation_notes ADD CONSTRAINT conversation_notes_content_length CHECK (char_length(content) BETWEEN 1 AND 8000);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_title_or_question_length CHECK (char_length(title_or_question) BETWEEN 1 AND 200);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_body_length CHECK (char_length(body) BETWEEN 1 AND 50000);
ALTER TABLE tickets ADD CONSTRAINT tickets_title_length CHECK (char_length(title) BETWEEN 1 AND 200);
ALTER TABLE tickets ADD CONSTRAINT tickets_description_length CHECK (char_length(description) BETWEEN 1 AND 8000);

-- Automatic tasks deduplicate a visitor turn; manual tasks deduplicate the actor's command.
CREATE UNIQUE INDEX ai_tasks_auto_key ON ai_tasks(organization_id,conversation_id,input_revision,operation) WHERE scope='conversation_auto';
CREATE UNIQUE INDEX ai_tasks_command_key ON ai_tasks(organization_id,requested_by_membership_id,command_id) WHERE scope<>'conversation_auto';

-- Generic immutable-column guard; no business state transitions or queue work in triggers.
CREATE FUNCTION guard_immutable_columns() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field_name text;
BEGIN
  FOREACH field_name IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD)->field_name IS DISTINCT FROM to_jsonb(NEW)->field_name THEN
      RAISE EXCEPTION 'immutable column: %.%', TG_TABLE_NAME, field_name USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE FUNCTION validate_message_sender() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected uuid;
BEGIN
  IF NEW.sender_type IN ('ai','system') THEN
    SELECT CASE WHEN NEW.sender_type='ai' THEN ai_sender_id ELSE system_sender_id END
      INTO expected FROM organizations WHERE id=NEW.organization_id;
    IF NEW.sender_id IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'invalid service sender identity' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_service_sender BEFORE INSERT OR UPDATE ON messages
 FOR EACH ROW EXECUTE FUNCTION validate_message_sender();

CREATE FUNCTION validate_knowledge_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_row knowledge_versions; document_type text;
BEGIN
  IF TG_TABLE_NAME='knowledge_chunks' THEN
    SELECT * INTO version_row FROM knowledge_versions
      WHERE organization_id=NEW.organization_id AND document_id=NEW.document_id AND id=NEW.version_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing knowledge version' USING ERRCODE='23503'; END IF;
    IF vector_dims(NEW.embedding)<>version_row.embedding_dimensions OR NEW.embedding_profile_version<>version_row.embedding_profile_version THEN
      RAISE EXCEPTION 'embedding dimension/profile mismatch' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT type INTO document_type FROM knowledge_documents WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
    IF document_type='faq' AND char_length(NEW.body)>8000 THEN
      RAISE EXCEPTION 'FAQ body exceeds 8000 code points' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_chunk_shape BEFORE INSERT OR UPDATE ON knowledge_chunks
 FOR EACH ROW EXECUTE FUNCTION validate_knowledge_content();
CREATE TRIGGER knowledge_version_shape BEFORE INSERT OR UPDATE ON knowledge_versions
 FOR EACH ROW EXECUTE FUNCTION validate_knowledge_content();

CREATE FUNCTION validate_presence_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships m JOIN auth_sessions s ON s.user_id=m.user_id
    WHERE m.organization_id=NEW.organization_id AND m.id=NEW.membership_id AND s.id=NEW.auth_session_id) THEN
    RAISE EXCEPTION 'presence session/member mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER presence_identity BEFORE INSERT OR UPDATE ON presence_connections
 FOR EACH ROW EXECUTE FUNCTION validate_presence_identity();
CREATE TRIGGER organizations_immutable BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','ai_sender_id','system_sender_id');
CREATE TRIGGER memberships_immutable BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','user_id');
CREATE TRIGGER auth_sessions_immutable BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','user_id');
CREATE TRIGGER visitor_sessions_immutable BEFORE UPDATE ON visitor_sessions FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','customer_id','widget_config_id','parent_origin');
CREATE TRIGGER presence_connections_immutable BEFORE UPDATE ON presence_connections FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','membership_id','auth_session_id','transport','socket_id');
CREATE TRIGGER messages_immutable BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','conversation_id','sender_id','sender_type','sender_membership_id','sender_customer_id','client_message_id','seq','content','content_hash','ai_task_id','created_at');
CREATE TRIGGER conversation_notes_immutable BEFORE UPDATE ON conversation_notes FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','conversation_id','author_membership_id','client_note_id','content','created_at');
CREATE TRIGGER conversation_events_immutable BEFORE UPDATE ON conversation_events FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','conversation_id','type','actor_type','actor_id','command_id','from_status','to_status','from_assignee','to_assignee','reason','version','created_at');
CREATE TRIGGER ticket_events_immutable BEFORE UPDATE ON ticket_events FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','ticket_id','actor_membership_id','command_id','type','from_status','to_status','content','reason','version','created_at');
CREATE TRIGGER ai_results_immutable BEFORE UPDATE ON ai_results FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','task_id','result_kind','result','source_snapshot','model_version','prompt_version','usage','usage_estimated','created_at');
CREATE TRIGGER knowledge_documents_immutable BEFORE UPDATE ON knowledge_documents FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','type');
CREATE TRIGGER knowledge_versions_immutable BEFORE UPDATE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','document_id','revision','title_or_question','body','content_hash','embedding_profile_version','embedding_model_id','embedding_dimensions','created_by_membership_id','created_at');
CREATE TRIGGER knowledge_chunks_immutable BEFORE UPDATE ON knowledge_chunks FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('id','organization_id','document_id','version_id','ordinal','text','content_hash','embedding','embedding_profile_version','created_at');
COMMIT;
