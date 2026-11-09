BEGIN;
-- Zero denotes a legacy message whose commit-time version was not recorded.
ALTER TABLE messages ADD COLUMN conversation_version integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_version_nonnegative CHECK (conversation_version >= 0);
CREATE TRIGGER message_version_immutable BEFORE UPDATE ON messages
 FOR EACH ROW EXECUTE FUNCTION guard_immutable_columns('conversation_version');
COMMIT;
