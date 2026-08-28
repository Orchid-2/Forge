CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`entity_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_created_idx` ON `activity` (`created_at`);--> statement-breakpoint
CREATE TABLE `adapters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`base_model_id` text,
	`hf_repo_id` text,
	`hf_filename` text,
	`local_path` text,
	`scale` real DEFAULT 1 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`downloaded_bytes` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`status_message` text,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`base_model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `adapters_base_idx` ON `adapters` (`base_model_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New chat' NOT NULL,
	`title_generated` integer DEFAULT false NOT NULL,
	`project_id` text,
	`profile_id` text,
	`provider` text,
	`model` text,
	`system_prompt` text,
	`summary` text,
	`summarized_until` integer DEFAULT 0 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`token_count` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`last_message_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `conversations_project_idx` ON `conversations` (`project_id`);--> statement-breakpoint
CREATE INDEX `conversations_updated_idx` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_archived_idx` ON `conversations` (`archived`);--> statement-breakpoint
CREATE TABLE `custom_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`parameters` text DEFAULT '{}',
	`method` text DEFAULT 'POST' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`headers` text DEFAULT '{}',
	`body_template` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`value` real DEFAULT 1 NOT NULL,
	`note` text,
	`day` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `goal_entries_goal_idx` ON `goal_entries` (`goal_id`,`day`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`icon` text DEFAULT '◎' NOT NULL,
	`accent` text DEFAULT '142 70% 45%' NOT NULL,
	`kind` text DEFAULT 'counter' NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`target` real DEFAULT 0 NOT NULL,
	`current` real DEFAULT 0 NOT NULL,
	`streak` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goals_archived_idx` ON `goals` (`archived`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`transport` text DEFAULT 'stdio' NOT NULL,
	`command` text,
	`args` text DEFAULT '[]',
	`env` text DEFAULT '{}',
	`url` text,
	`headers` text DEFAULT '{}',
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`last_error` text,
	`discovered_tools` text DEFAULT '[]',
	`last_connected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`title` text,
	`kind` text DEFAULT 'fact' NOT NULL,
	`importance` real DEFAULT 0.5 NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`source` text DEFAULT 'auto' NOT NULL,
	`source_conversation_id` text,
	`source_message_id` text,
	`project_id` text,
	`profile_id` text,
	`tags` text DEFAULT '[]',
	`pinned` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL,
	`last_accessed_at` integer,
	`embedding` blob,
	`embedding_model` text,
	`embedding_dim` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_project_idx` ON `memories` (`project_id`);--> statement-breakpoint
CREATE INDEX `memories_kind_idx` ON `memories` (`kind`);--> statement-breakpoint
CREATE INDEX `memories_archived_idx` ON `memories` (`archived`);--> statement-breakpoint
CREATE INDEX `memories_pinned_idx` ON `memories` (`pinned`);--> statement-breakpoint
CREATE INDEX `memories_created_idx` ON `memories` (`created_at`);--> statement-breakpoint
CREATE TABLE `memory_links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`relation` text DEFAULT 'related' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_links_from_idx` ON `memory_links` (`from_id`);--> statement-breakpoint
CREATE INDEX `memory_links_to_idx` ON `memory_links` (`to_id`);--> statement-breakpoint
CREATE TABLE `message_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`reasoning` text,
	`tool_calls` text,
	`model` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_versions_message_idx` ON `message_versions` (`message_id`,`version`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`reasoning` text,
	`tool_calls` text,
	`tool_call_id` text,
	`tool_name` text,
	`cited_memory_ids` text,
	`provider` text,
	`model` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`error` text,
	`version_count` integer DEFAULT 1 NOT NULL,
	`active_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_pinned_idx` ON `messages` (`pinned`);--> statement-breakpoint
CREATE INDEX `messages_created_idx` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`provider` text NOT NULL,
	`family` text,
	`parameter_size` text,
	`quantization` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`context_length` integer,
	`source` text DEFAULT 'ollama' NOT NULL,
	`hf_repo_id` text,
	`hf_filename` text,
	`local_path` text,
	`status` text DEFAULT 'ready' NOT NULL,
	`downloaded_bytes` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`status_message` text,
	`capabilities` text DEFAULT '{"tools":false,"vision":false,"embedding":false,"reasoning":false}',
	`favorite` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `models_provider_idx` ON `models` (`provider`);--> statement-breakpoint
CREATE INDEX `models_status_idx` ON `models` (`status`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text DEFAULT '◈' NOT NULL,
	`accent` text DEFAULT '24 95% 58%' NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`provider` text,
	`model` text,
	`temperature` real DEFAULT 0.8 NOT NULL,
	`top_p` real DEFAULT 0.95 NOT NULL,
	`top_k` integer DEFAULT 40 NOT NULL,
	`repeat_penalty` real DEFAULT 1.1 NOT NULL,
	`max_tokens` integer DEFAULT 2048 NOT NULL,
	`context_window` integer,
	`stop_sequences` text DEFAULT '[]',
	`enabled_tools` text DEFAULT '[]',
	`memory_read` integer DEFAULT true NOT NULL,
	`memory_write` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `profiles_sort_idx` ON `profiles` (`sort_order`);--> statement-breakpoint
CREATE INDEX `profiles_archived_idx` ON `profiles` (`archived`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text DEFAULT '▲' NOT NULL,
	`accent` text DEFAULT '190 90% 50%' NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`default_profile_id` text,
	`default_provider` text,
	`default_model` text,
	`memory_scoped` integer DEFAULT true NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`default_profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `projects_archived_idx` ON `projects` (`archived`);--> statement-breakpoint
CREATE INDEX `projects_pinned_idx` ON `projects` (`pinned`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`entity_id` text DEFAULT '*' NOT NULL,
	`content_hash` text,
	`remote_ref` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`error` text,
	`synced_at` integer,
	`updated_at` integer NOT NULL
);
