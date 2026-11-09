BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email_normalized" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ai_config_revision" INTEGER NOT NULL DEFAULT 0,
    "knowledge_revision" INTEGER NOT NULL DEFAULT 0,
    "authorization_revision" INTEGER NOT NULL DEFAULT 0,
    "ai_sender_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system_sender_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "availability" TEXT NOT NULL DEFAULT 'away',
    "reading_language" TEXT NOT NULL DEFAULT 'zh',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_by_membership_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_by_user_id" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "public_key" UUID NOT NULL DEFAULT gen_random_uuid(),
    "allowed_origins" JSONB NOT NULL DEFAULT '[]',
    "welcome_text" TEXT NOT NULL DEFAULT '',
    "default_language" TEXT NOT NULL DEFAULT 'zh',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "widget_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presence_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "auth_session_id" UUID NOT NULL,
    "transport" TEXT NOT NULL,
    "socket_id" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "presence_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "email_normalized" TEXT,
    "preferred_language" TEXT NOT NULL DEFAULT 'zh',
    "internal_notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "widget_config_id" UUID NOT NULL,
    "parent_origin" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "visitor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "created_by_visitor_session_id" UUID NOT NULL,
    "client_conversation_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting_human',
    "assigned_membership_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "last_visitor_seq" INTEGER NOT NULL DEFAULT 0,
    "input_revision" INTEGER NOT NULL DEFAULT 0,
    "reception_epoch" INTEGER NOT NULL DEFAULT 0,
    "clarification_pending" BOOLEAN NOT NULL DEFAULT false,
    "active_ai_task_id" UUID,
    "entered_ai_at" TIMESTAMPTZ(6),
    "first_handoff_at" TIMESTAMPTZ(6),
    "first_handoff_reason" TEXT,
    "first_human_reply_at" TIMESTAMPTZ(6),
    "first_human_reply_membership_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "sender_type" TEXT NOT NULL,
    "sender_membership_id" UUID,
    "sender_customer_id" UUID,
    "client_message_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "ai_task_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "author_membership_id" UUID NOT NULL,
    "client_note_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_reads" (
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "last_read_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("organization_id","conversation_id","membership_id")
);

-- CreateTable
CREATE TABLE "conversation_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_type" TEXT,
    "actor_id" UUID,
    "command_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "from_assignee" UUID,
    "to_assignee" UUID,
    "reason" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "current_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(6),
    "created_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "title_or_question" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "preparation_status" TEXT NOT NULL DEFAULT 'pending',
    "embedding_profile_version" TEXT NOT NULL,
    "embedding_model_id" TEXT NOT NULL,
    "embedding_dimensions" INTEGER NOT NULL,
    "prepared_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "preparation_attempt" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "preparation_started_at" TIMESTAMPTZ(6),
    "preparation_deadline_at" TIMESTAMPTZ(6),
    "created_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector NOT NULL,
    "embedding_profile_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID,
    "scope" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requested_by_membership_id" UUID,
    "command_id" UUID,
    "input_revision" INTEGER NOT NULL,
    "source_through_seq" INTEGER,
    "input_message_ids" JSONB NOT NULL DEFAULT '[]',
    "question_text" TEXT,
    "latest_visitor_seq" INTEGER,
    "reception_epoch" INTEGER,
    "knowledge_revision" INTEGER NOT NULL,
    "ai_config_revision" INTEGER NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "target_language" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "version" INTEGER NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "result_kind" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "model_version" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "usage" JSONB NOT NULL,
    "usage_estimated" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "owner_membership_id" UUID,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'open',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by_membership_id" UUID NOT NULL,
    "created_command_id" UUID NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "actor_membership_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "content" TEXT,
    "reason" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "actor_scope" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "command_id" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_ref" JSONB NOT NULL,
    "secret_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "actor_membership_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "before_meta" JSONB,
    "after_meta" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_normalized_key" ON "users"("email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "memberships_organization_id_role_status_idx" ON "memberships"("organization_id", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_id_key" ON "memberships"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_organization_id_id_key" ON "invitations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "widget_configs_public_key_key" ON "widget_configs"("public_key");

-- CreateIndex
CREATE UNIQUE INDEX "widget_configs_organization_id_id_key" ON "widget_configs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "widget_configs_organization_id_key" ON "widget_configs"("organization_id");

-- CreateIndex
CREATE INDEX "presence_connections_organization_id_membership_id_last_see_idx" ON "presence_connections"("organization_id", "membership_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "presence_connections_organization_id_id_key" ON "presence_connections"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "presence_connections_organization_id_socket_id_key" ON "presence_connections"("organization_id", "socket_id");

-- CreateIndex
CREATE INDEX "customers_organization_id_name_idx" ON "customers"("organization_id", "name");

-- CreateIndex
CREATE INDEX "customers_organization_id_email_normalized_idx" ON "customers"("organization_id", "email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_token_hash_key" ON "visitor_sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_organization_id_id_key" ON "visitor_sessions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_organization_id_id_customer_id_key" ON "visitor_sessions"("organization_id", "id", "customer_id");

-- CreateIndex
CREATE INDEX "conversations_inbox_idx" ON "conversations"("organization_id", "status", "assigned_membership_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "conversations_organization_id_customer_id_created_at_id_idx" ON "conversations"("organization_id", "customer_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_id_key" ON "conversations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_id_customer_id_key" ON "conversations"("organization_id", "id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_client_key" ON "conversations"("organization_id", "created_by_visitor_session_id", "client_conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_ai_task_id_key" ON "messages"("ai_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_id_key" ON "messages"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_conversation_id_seq_key" ON "messages"("organization_id", "conversation_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_idempotency_key" ON "messages"("organization_id", "conversation_id", "sender_id", "client_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_notes_organization_id_id_key" ON "conversation_notes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notes_idempotency_key" ON "conversation_notes"("organization_id", "conversation_id", "author_membership_id", "client_note_id");

-- CreateIndex
CREATE INDEX "conversation_events_organization_id_conversation_id_version_idx" ON "conversation_events"("organization_id", "conversation_id", "version", "type");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_events_organization_id_id_key" ON "conversation_events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "knowledge_documents_organization_id_status_deleted_at_idx" ON "knowledge_documents"("organization_id", "status", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_organization_id_id_key" ON "knowledge_documents"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_versions_organization_id_id_key" ON "knowledge_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_versions_organization_id_document_id_revision_key" ON "knowledge_versions"("organization_id", "document_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_versions_organization_id_document_id_id_key" ON "knowledge_versions"("organization_id", "document_id", "id");

-- CreateIndex
CREATE INDEX "knowledge_chunks_organization_id_version_id_idx" ON "knowledge_chunks"("organization_id", "version_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_organization_id_id_key" ON "knowledge_chunks"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_organization_id_version_id_ordinal_key" ON "knowledge_chunks"("organization_id", "version_id", "ordinal");

-- CreateIndex
CREATE INDEX "ai_tasks_status_deadline_at_idx" ON "ai_tasks"("status", "deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tasks_organization_id_id_key" ON "ai_tasks"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tasks_organization_id_conversation_id_id_key" ON "ai_tasks"("organization_id", "conversation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_results_task_id_key" ON "ai_results"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_results_organization_id_id_key" ON "ai_results"("organization_id", "id");

-- CreateIndex
CREATE INDEX "tickets_organization_id_status_updated_at_id_idx" ON "tickets"("organization_id", "status", "updated_at", "id");

-- CreateIndex
CREATE INDEX "tickets_organization_id_owner_membership_id_updated_at_id_idx" ON "tickets"("organization_id", "owner_membership_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "tickets_organization_id_priority_updated_at_id_idx" ON "tickets"("organization_id", "priority", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_organization_id_id_key" ON "tickets"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_create_key" ON "tickets"("organization_id", "created_by_membership_id", "created_command_id");

-- CreateIndex
CREATE INDEX "ticket_events_organization_id_ticket_id_created_at_id_idx" ON "ticket_events"("organization_id", "ticket_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_events_organization_id_id_key" ON "ticket_events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_organization_id_id_key" ON "outbox_events"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_delivery_key" ON "outbox_events"("organization_id", "aggregate_type", "aggregate_id", "aggregate_version", "event_type", "destination");

-- CreateIndex
CREATE UNIQUE INDEX "operation_receipts_actor_scope_operation_command_id_key" ON "operation_receipts"("actor_scope", "operation", "command_id");

-- CreateIndex
CREATE UNIQUE INDEX "operation_receipts_organization_id_id_key" ON "operation_receipts"("organization_id", "id");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_resource_type_resource_id_crea_idx" ON "audit_events"("organization_id", "resource_type", "resource_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_organization_id_id_key" ON "audit_events"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_created_by_membership_id_fkey" FOREIGN KEY ("organization_id", "created_by_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "widget_configs" ADD CONSTRAINT "widget_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "presence_connections" ADD CONSTRAINT "presence_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "presence_connections" ADD CONSTRAINT "presence_connections_organization_id_membership_id_fkey" FOREIGN KEY ("organization_id", "membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "presence_connections" ADD CONSTRAINT "presence_connections_auth_session_id_fkey" FOREIGN KEY ("auth_session_id") REFERENCES "auth_sessions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_organization_id_widget_config_id_fkey" FOREIGN KEY ("organization_id", "widget_config_id") REFERENCES "widget_configs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_created_by_visitor_session_i_fkey" FOREIGN KEY ("organization_id", "created_by_visitor_session_id", "customer_id") REFERENCES "visitor_sessions"("organization_id", "id", "customer_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_assigned_membership_id_fkey" FOREIGN KEY ("organization_id", "assigned_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_first_human_reply_membership_fkey" FOREIGN KEY ("organization_id", "first_human_reply_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_id_active_ai_task_id_fkey" FOREIGN KEY ("organization_id", "id", "active_ai_task_id") REFERENCES "ai_tasks"("organization_id", "conversation_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_sender_membership_id_fkey" FOREIGN KEY ("organization_id", "sender_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_conversation_id_sender_customer_i_fkey" FOREIGN KEY ("organization_id", "conversation_id", "sender_customer_id") REFERENCES "conversations"("organization_id", "id", "customer_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_sender_customer_id_fkey" FOREIGN KEY ("organization_id", "sender_customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_conversation_id_ai_task_id_fkey" FOREIGN KEY ("organization_id", "conversation_id", "ai_task_id") REFERENCES "ai_tasks"("organization_id", "conversation_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_author_membership_id_fkey" FOREIGN KEY ("organization_id", "author_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_organization_id_membership_id_fkey" FOREIGN KEY ("organization_id", "membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_from_assignee_fkey" FOREIGN KEY ("organization_id", "from_assignee") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_to_assignee_fkey" FOREIGN KEY ("organization_id", "to_assignee") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_organization_id_created_by_membership__fkey" FOREIGN KEY ("organization_id", "created_by_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_organization_id_id_current_version_id_fkey" FOREIGN KEY ("organization_id", "id", "current_version_id") REFERENCES "knowledge_versions"("organization_id", "document_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_organization_id_created_by_membership_i_fkey" FOREIGN KEY ("organization_id", "created_by_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "knowledge_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_organization_id_document_id_version_id_fkey" FOREIGN KEY ("organization_id", "document_id", "version_id") REFERENCES "knowledge_versions"("organization_id", "document_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_organization_id_requested_by_membership_id_fkey" FOREIGN KEY ("organization_id", "requested_by_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "ai_tasks"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_owner_membership_id_fkey" FOREIGN KEY ("organization_id", "owner_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_conversation_id_customer_id_fkey" FOREIGN KEY ("organization_id", "conversation_id", "customer_id") REFERENCES "conversations"("organization_id", "id", "customer_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_created_by_membership_id_fkey" FOREIGN KEY ("organization_id", "created_by_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_organization_id_actor_membership_id_fkey" FOREIGN KEY ("organization_id", "actor_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "operation_receipts" ADD CONSTRAINT "operation_receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_actor_membership_id_fkey" FOREIGN KEY ("organization_id", "actor_membership_id") REFERENCES "memberships"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
COMMIT;
