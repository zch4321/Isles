-- Run atomically with foreign keys enabled. Refuse to discard unmappable legacy references.
CREATE TABLE `__message_migration_check` (`invalid_count` integer CHECK (`invalid_count` = 0));
--> statement-breakpoint
INSERT INTO `__message_migration_check`
SELECT count(*) FROM `messages` m LEFT JOIN `messages` parent
  ON parent.id = m.reply_to AND parent.channel_id = m.channel_id
WHERE m.reply_to IS NOT NULL AND parent.id IS NULL;
--> statement-breakpoint
INSERT INTO `__message_migration_check`
SELECT count(*) FROM `deliveries` d LEFT JOIN `messages` m
  ON m.id = d.message_id AND m.channel_id = d.channel_id
WHERE m.id IS NULL;
--> statement-breakpoint
ALTER TABLE `channels` ADD `next_message_seq` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `channels` SET `next_message_seq` = coalesce(
  (SELECT max(seq) + 1 FROM messages WHERE channel_id = channels.id), 1
);
--> statement-breakpoint
CREATE TABLE `__new_messages` (
  `channel_id` text NOT NULL,
  `seq` integer NOT NULL,
  `sender` text NOT NULL,
  `sender_id` text NOT NULL,
  `body` text NOT NULL,
  `client_id` text NOT NULL,
  `reply_to` integer,
  `mentions` text DEFAULT '[]' NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`channel_id`, `seq`),
  FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`),
  FOREIGN KEY (`channel_id`, `reply_to`) REFERENCES `__new_messages` (`channel_id`, `seq`),
  CONSTRAINT `messages_positive_seq` CHECK (`seq` > 0)
);
--> statement-breakpoint
INSERT INTO `__new_messages`
SELECT m.channel_id, m.seq, m.sender, m.sender_id, m.body, m.client_id,
       parent.seq, m.mentions, m.created_at
FROM `messages` m LEFT JOIN `messages` parent
  ON parent.id = m.reply_to AND parent.channel_id = m.channel_id;
--> statement-breakpoint
CREATE TABLE `__new_deliveries` (
  `seq` integer NOT NULL,
  `agent_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `status` text NOT NULL,
  `run_id` text,
  `turn_id` text,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`channel_id`, `seq`, `agent_id`),
  FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`),
  FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`),
  FOREIGN KEY (`channel_id`, `seq`) REFERENCES `__new_messages` (`channel_id`, `seq`)
);
--> statement-breakpoint
INSERT INTO `__new_deliveries`
SELECT m.seq, d.agent_id, d.channel_id, d.status, d.run_id, d.turn_id, d.updated_at
FROM `deliveries` d JOIN `messages` m ON m.id = d.message_id AND m.channel_id = d.channel_id;
--> statement-breakpoint
UPDATE `events` SET data = json_remove(data, '$.messageId') WHERE type = 'message';
--> statement-breakpoint
DROP TABLE `deliveries`;
--> statement-breakpoint
DROP TABLE `messages`;
--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;
--> statement-breakpoint
ALTER TABLE `__new_deliveries` RENAME TO `deliveries`;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedupe` ON `messages` (`channel_id`, `sender`, `sender_id`, `client_id`);
--> statement-breakpoint
CREATE INDEX `deliveries_queue` ON `deliveries` (`agent_id`, `status`);
--> statement-breakpoint
CREATE INDEX `deliveries_run` ON `deliveries` (`run_id`);
--> statement-breakpoint
DROP TABLE `__message_migration_check`;
