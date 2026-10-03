CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`harness` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_effort` text NOT NULL,
	`workspace` text NOT NULL,
	`native_home` text NOT NULL,
	`thread_id` text,
	`thread_creation_attempted` integer DEFAULT false NOT NULL,
	`can_create_groups` integer DEFAULT false NOT NULL,
	`desired_state` text DEFAULT 'running' NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_thread` ON `agents` (`harness`,`native_home`,`thread_id`);--> statement-breakpoint
CREATE TABLE `channel_members` (
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`added_by` text NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `agent_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `channel_members_agent` ON `channel_members` (`agent_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`agent_id` text,
	`paused` integer DEFAULT false NOT NULL,
	`next_message_seq` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channels_kind_shape" CHECK(("channels"."kind" = 'private' and "channels"."agent_id" is not null and "channels"."name" is null) or ("channels"."kind" = 'group' and "channels"."agent_id" is null and "channels"."name" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_private_agent` ON `channels` (`agent_id`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`seq` integer NOT NULL,
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`turn_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `seq`, `agent_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`,`seq`) REFERENCES `messages`(`channel_id`,`seq`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deliveries_queue` ON `deliveries` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `deliveries_run` ON `deliveries` (`run_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`agent_id` text,
	`channel_id` text,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`channel_id` text NOT NULL,
	`seq` integer NOT NULL,
	`sender` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`client_id` text NOT NULL,
	`reply_to` integer,
	`mentions` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `seq`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`,`reply_to`) REFERENCES `messages`(`channel_id`,`seq`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_positive_seq" CHECK("messages"."seq" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedupe` ON `messages` (`channel_id`,`sender`,`sender_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text NOT NULL,
	`native_request_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`status` text NOT NULL,
	`definition` text NOT NULL,
	`answer` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `run_items` (
	`key` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_agent` ON `runs` (`agent_id`,`created_at`);
